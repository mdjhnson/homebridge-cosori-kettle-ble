import { computeChecksum } from './checksum.js';
import { BLE_CHUNK_SIZE, FRAME_MAGIC, HEADER_SIZE, MAX_PAYLOAD_SIZE } from './constants.js';

/**
 * Wire frame:  A5 | type | seq | len_lo | len_hi | checksum | payload[len]
 * Length is little-endian and counts payload bytes only.
 */
export interface Frame {
  frameType: number;
  seq: number;
  payload: Buffer;
}

export function buildFrame(frameType: number, seq: number, payload: Uint8Array): Buffer {
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new RangeError(`payload too large (${payload.length} > ${MAX_PAYLOAD_SIZE})`);
  }
  const buf = Buffer.alloc(HEADER_SIZE + payload.length);
  buf[0] = FRAME_MAGIC;
  buf[1] = frameType & 0xff;
  buf[2] = seq & 0xff;
  buf[3] = payload.length & 0xff;
  buf[4] = (payload.length >> 8) & 0xff;
  buf[5] = 0x01;
  buf.set(payload, HEADER_SIZE);
  buf[5] = computeChecksum(buf);
  return buf;
}

/** Split an encoded frame into BLE write chunks (no additional framing). */
export function splitIntoChunks(frame: Uint8Array, chunkSize = BLE_CHUNK_SIZE): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < frame.length; i += chunkSize) {
    chunks.push(Buffer.from(frame.subarray(i, i + chunkSize)));
  }
  return chunks;
}

/** Parse exactly one complete frame. Returns undefined if malformed or the checksum fails. */
export function parseFrame(data: Uint8Array): Frame | undefined {
  const parser = new FrameParser();
  const frames = parser.push(data);
  return frames.length === 1 && parser.pending === 0 ? frames[0] : undefined;
}

/**
 * Streaming frame parser. Notifications are appended with `push()`; any complete, checksum-valid
 * frames are returned. Garbage bytes and frames with bad checksums are skipped by resyncing on the
 * next 0xA5 byte. Partial frames are retained until more bytes arrive.
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  /** Count of bytes discarded while resyncing (useful for debug logging). */
  public discardedBytes = 0;

  constructor(private readonly maxPayloadSize = MAX_PAYLOAD_SIZE) {}

  /** Bytes currently buffered waiting for the rest of a frame. */
  get pending(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk: Uint8Array): Frame[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];

    for (;;) {
      const start = this.buffer.indexOf(FRAME_MAGIC);
      if (start < 0) {
        this.discardedBytes += this.buffer.length;
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (start > 0) {
        this.discardedBytes += start;
        this.buffer = this.buffer.subarray(start);
      }
      if (this.buffer.length < HEADER_SIZE) {
        break;
      }
      const payloadLen = this.buffer[3]! | (this.buffer[4]! << 8);
      if (payloadLen > this.maxPayloadSize) {
        this.skipOne();
        continue;
      }
      const frameLen = HEADER_SIZE + payloadLen;
      if (this.buffer.length < frameLen) {
        // A stray 0xA5 can masquerade as a long frame and swallow real traffic. If a complete,
        // checksum-valid frame starts at a later 0xA5, the current "frame" was garbage: resync there.
        const next = this.findLaterValidFrame();
        if (next > 0) {
          this.discardedBytes += next;
          this.buffer = this.buffer.subarray(next);
          continue;
        }
        break;
      }
      const raw = this.buffer.subarray(0, frameLen);
      if (raw[5] !== computeChecksum(raw)) {
        this.skipOne();
        continue;
      }
      frames.push({
        frameType: raw[1]!,
        seq: raw[2]!,
        payload: Buffer.from(raw.subarray(HEADER_SIZE)),
      });
      this.buffer = this.buffer.subarray(frameLen);
    }

    if (this.buffer.length > 0) {
      // Detach from the (possibly large) concatenated backing buffer.
      this.buffer = Buffer.from(this.buffer);
    }
    return frames;
  }

  private findLaterValidFrame(): number {
    for (let i = this.buffer.indexOf(FRAME_MAGIC, 1); i > 0; i = this.buffer.indexOf(FRAME_MAGIC, i + 1)) {
      if (this.buffer.length - i < HEADER_SIZE) {
        return -1;
      }
      const len = this.buffer[i + 3]! | (this.buffer[i + 4]! << 8);
      if (len > this.maxPayloadSize || this.buffer.length - i < HEADER_SIZE + len) {
        continue;
      }
      const candidate = this.buffer.subarray(i, i + HEADER_SIZE + len);
      if (candidate[5] === computeChecksum(candidate)) {
        return i;
      }
    }
    return -1;
  }

  private skipOne(): void {
    this.discardedBytes += 1;
    this.buffer = this.buffer.subarray(1);
  }
}

/** Hex helper for logging: "a5 22 00 ...". */
export function toHex(data: Uint8Array, sep = ' '): string {
  return Buffer.from(data).toString('hex').replace(/(..)(?!$)/g, `$1${sep}`);
}

/** Parse "a5:22 00-24…" / "A52200…" style strings into bytes. */
export function fromHex(hex: string): Buffer {
  const clean = hex.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2 !== 0) {
    throw new Error(`odd-length hex string: ${hex}`);
  }
  return Buffer.from(clean, 'hex');
}
