import { randomBytes } from 'node:crypto';

import { Cmd, CmdClass, FrameType, REGISTRATION_KEY_BYTES } from './constants.js';
import { FrameParser, fromHex, type Frame } from './frame.js';

const KEY_HEX_RE = /^[0-9a-f]{32}$/;

/** Normalise a user-supplied key ("0123…", "01:23:…", upper/lower case) to 16 bytes. */
export function parseKey(input: string): Buffer {
  const clean = input.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!KEY_HEX_RE.test(clean)) {
    throw new Error('registration key must be 32 hex characters (16 bytes)');
  }
  return Buffer.from(clean, 'hex');
}

export function isValidKeyString(input: string | undefined): input is string {
  if (!input) {
    return false;
  }
  try {
    parseKey(input);
    return true;
  } catch {
    return false;
  }
}

export function keyToHex(key: Uint8Array): string {
  return Buffer.from(key).toString('hex');
}

/** The key is sent on the wire as 32 lowercase ASCII hex characters. */
export function keyToAscii(key: Uint8Array): Buffer {
  if (key.length !== REGISTRATION_KEY_BYTES) {
    throw new Error(`registration key must be ${REGISTRATION_KEY_BYTES} bytes`);
  }
  return Buffer.from(keyToHex(key), 'ascii');
}

export function generateKey(): Buffer {
  return randomBytes(REGISTRATION_KEY_BYTES);
}

/** ATT opcodes that carry a characteristic value we care about. */
const ATT_VALUE_OPCODES: ReadonlySet<number> = new Set([
  0x12, // Write Request
  0x52, // Write Command
  0x1b, // Handle Value Notification
  0x1d, // Handle Value Indication
]);
const L2CAP_ATT_CID = 0x0004;

/**
 * Strip capture-tool headers from a hex dump so only the ATT value remains.
 *
 * PacketLogger's raw column (and Wireshark's "copy as hex") include, before every value:
 *   [HCI ACL: handle/flags(2) len(2)] [L2CAP: len(2) CID=0004(2)] [ATT: opcode(1) handle(2)]
 * e.g. `05 04 1B 00 17 00 04 00 12 0E 00 | A5 22 …`. The L2CAP length must equal the number of
 * bytes after the L2CAP header, which makes false matches inside real values implausible.
 * A bare ATT PDU (`12 0E 00 A5 …`) is also accepted. Anything else is returned unchanged.
 */
export function stripAttHeader(bytes: Buffer): Buffer {
  for (let i = 0; i <= 5 && i + 7 <= bytes.length; i++) {
    const l2capLen = bytes[i]! | (bytes[i + 1]! << 8);
    const cid = bytes[i + 2]! | (bytes[i + 3]! << 8);
    if (cid === L2CAP_ATT_CID && ATT_VALUE_OPCODES.has(bytes[i + 4]!) && l2capLen === bytes.length - (i + 4)) {
      return bytes.subarray(i + 7);
    }
  }
  if (bytes.length > 3 && ATT_VALUE_OPCODES.has(bytes[0]!) && bytes[3] === 0xa5) {
    return bytes.subarray(3);
  }
  return bytes;
}

function isAuthFrame(f: Frame): boolean {
  return f.frameType === FrameType.MESSAGE
    && f.payload.length >= 36
    && (f.payload[1] === Cmd.HELLO || f.payload[1] === Cmd.REGISTER)
    && f.payload[2] === CmdClass.AUTH
    && f.payload[3] === 0x00;
}

function keyFromAuthFrame(f: Frame): Buffer {
  return parseKey(f.payload.subarray(4, 36).toString('ascii'));
}

/**
 * Recover the registration key from the hello the VeSync/Cosori app writes when it connects.
 *
 * The app writes one 42-byte frame as three chunks (20 + 20 + 2 bytes):
 *   A5 22 ss 24 00 cs  VV 81 D1 00  <32 ASCII hex chars>
 * Pass the chunks in order (hex strings with any separators). Capture-tool headers on each chunk
 * are stripped (see stripAttHeader). The frame checksum is verified, so a truncated, mistyped or
 * reordered packet is rejected rather than producing a wrong key.
 */
export function keyFromHelloPackets(packets: string[]): Buffer {
  if (packets.some((p) => p.includes('…') || p.includes('...'))) {
    throw new Error('a packet contains "…" — that is PacketLogger\'s truncated Value column. Copy the full hex bytes instead (or use key-from-log).');
  }
  const joined = Buffer.concat(packets.map((p) => stripAttHeader(fromHex(p))));
  const hello = new FrameParser().push(joined).find(isAuthFrame);
  if (!hello) {
    throw new Error('no valid hello/register frame found — check that all three packets were pasted, in order, and complete');
  }
  return keyFromAuthFrame(hello);
}

export interface CapturedHandshake {
  key: Buffer;
  command: 'hello' | 'register';
  seq: number;
  protocolVersion: number;
  /** Status byte of the kettle's ACK for this frame, if the reply is in the log (0 = accepted). */
  ackStatus?: number;
}

export interface LogScanResult {
  handshakes: CapturedHandshake[];
  writeLines: number;
  notifyLines: number;
}

/** Trailing run of space-separated 2-digit hex bytes (PacketLogger's raw column). */
const TRAILING_HEX_RE = /(?:^|\s)((?:[0-9A-Fa-f]{2}[ \t]+)*[0-9A-Fa-f]{2})\s*$/;

/**
 * Find hello/register handshakes in a text export of a PacketLogger (or similar) BLE trace.
 *
 * Every "ATT Send … Write" line's raw bytes are header-stripped and concatenated in order, then run
 * through the frame parser, which reassembles the chunked 42-byte frame and verifies its checksum.
 * Kettle notifications are parsed the same way to find the ACK (status 00 = key accepted).
 */
export function findHandshakesInLog(text: string): LogScanResult {
  const tx: Buffer[] = [];
  const rx: Buffer[] = [];
  for (const line of text.split(/\r?\n/)) {
    const isWrite = /ATT\s+Send/i.test(line) && /Write\s+(Request|Command)/i.test(line);
    const isNotify = /ATT\s+Receive/i.test(line) && /(Notification|Indication)/i.test(line);
    if (!isWrite && !isNotify) {
      continue;
    }
    const match = TRAILING_HEX_RE.exec(line);
    if (!match) {
      continue;
    }
    const value = stripAttHeader(fromHex(match[1]!));
    (isWrite ? tx : rx).push(value);
  }

  const acks = new FrameParser().push(Buffer.concat(rx)).filter((f) => f.frameType === FrameType.ACK
    && f.payload[2] === CmdClass.AUTH
    && (f.payload[1] === Cmd.HELLO || f.payload[1] === Cmd.REGISTER));

  const handshakes: CapturedHandshake[] = [];
  for (const frame of new FrameParser().push(Buffer.concat(tx)).filter(isAuthFrame)) {
    const ack = acks.find((a) => a.seq === frame.seq && a.payload[1] === frame.payload[1]);
    handshakes.push({
      key: keyFromAuthFrame(frame),
      command: frame.payload[1] === Cmd.HELLO ? 'hello' : 'register',
      seq: frame.seq,
      protocolVersion: frame.payload[0]!,
      ackStatus: ack && ack.payload.length >= 5 ? ack.payload[4] : undefined,
    });
  }
  return { handshakes, writeLines: tx.length, notifyLines: rx.length };
}
