import { randomBytes } from 'node:crypto';

import { Cmd, CmdClass, REGISTRATION_KEY_BYTES } from './constants.js';
import { FrameParser, fromHex } from './frame.js';

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

/**
 * Recover the registration key from the hello the VeSync/Cosori app writes when it connects.
 *
 * The app writes one 42-byte frame as three chunks (20 + 20 + 2 bytes):
 *   A5 22 ss 24 00 cs  VV 81 D1 00  <32 ASCII hex chars>
 * Pass the chunks in order (hex strings with any separators). Leading bytes before the A5 magic
 * (e.g. an ATT header copied from PacketLogger) are ignored. The frame checksum is verified.
 */
export function keyFromHelloPackets(packets: string[]): Buffer {
  const joined = Buffer.concat(packets.map((p) => fromHex(p)));
  const parser = new FrameParser();
  const frames = parser.push(joined);
  const hello = frames.find((f) => f.payload.length >= 36
    && (f.payload[1] === Cmd.HELLO || f.payload[1] === Cmd.REGISTER)
    && f.payload[2] === CmdClass.AUTH
    && f.payload[3] === 0x00);
  if (!hello) {
    throw new Error('no valid hello/register frame found (check that all three packets were pasted in order and the checksum matches)');
  }
  const ascii = hello.payload.subarray(4, 36).toString('ascii');
  return parseKey(ascii);
}
