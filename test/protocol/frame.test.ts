import { describe, expect, it } from 'vitest';

import { buildFrame, FrameParser, fromHex, parseFrame, splitIntoChunks, toHex } from '../../src/protocol/index.js';
import { BAD_CHECKSUM_FRAMES, COMPACT_FRAMES, EXTENDED_FRAMES, HELLO_FRAMES, TX_FRAMES } from '../fixtures/captures.js';

describe('buildFrame', () => {
  it.each(TX_FRAMES)('reproduces captured TX frame: $name', ({ hex, seq, payload }) => {
    expect(toHex(buildFrame(0x22, seq, fromHex(payload)), '')).toBe(fromHex(hex).toString('hex'));
  });

  it('encodes payload length little-endian', () => {
    const frame = buildFrame(0x22, 0, Buffer.alloc(300));
    expect(frame[3]).toBe(300 & 0xff);
    expect(frame[4]).toBe(300 >> 8);
    expect(frame.length).toBe(306);
  });

  it('masks seq to 8 bits', () => {
    expect(buildFrame(0x22, 0x1ff, Buffer.from([1, 0x40, 0x40, 0]))[2]).toBe(0xff);
  });
});

describe('splitIntoChunks', () => {
  it('splits a 42-byte hello into 20 + 20 + 2 matching the captured writes', () => {
    const fixture = HELLO_FRAMES[0]!;
    const chunks = splitIntoChunks(fromHex(fixture.chunks.join('')));
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 2]);
    expect(chunks.map((c) => c.toString('hex'))).toEqual(fixture.chunks.map((c) => c.toLowerCase()));
  });

  it.each([[10, [10]], [20, [20]], [25, [20, 5]], [50, [20, 20, 10]]])('length %i → %j', (len, sizes) => {
    expect(splitIntoChunks(Buffer.alloc(len)).map((c) => c.length)).toEqual(sizes);
  });
});

describe('FrameParser', () => {
  it('parses a single complete frame', () => {
    const f = parseFrame(fromHex(EXTENDED_FRAMES[0]!.hex));
    expect(f?.frameType).toBe(0x12);
    expect(f?.seq).toBe(0x18);
    expect(f?.payload.length).toBe(29);
  });

  it('reassembles a frame split across notifications', () => {
    const bytes = fromHex(EXTENDED_FRAMES[1]!.hex);
    const parser = new FrameParser();
    expect(parser.push(bytes.subarray(0, 3))).toEqual([]);
    expect(parser.push(bytes.subarray(3, 20))).toEqual([]);
    const frames = parser.push(bytes.subarray(20));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.seq).toBe(0x83);
    expect(parser.pending).toBe(0);
  });

  it('returns multiple frames delivered in one notification', () => {
    const joined = Buffer.concat(COMPACT_FRAMES.slice(0, 3).map((c) => fromHex(c.hex)));
    const frames = new FrameParser().push(joined);
    expect(frames.map((f) => f.seq)).toEqual([0xb5, 0x1f, 0x20]);
  });

  it('skips leading garbage and resyncs on 0xA5', () => {
    const parser = new FrameParser();
    const frames = parser.push(Buffer.concat([Buffer.from([0x00, 0x13, 0x37]), fromHex(COMPACT_FRAMES[0]!.hex)]));
    expect(frames).toHaveLength(1);
    expect(parser.discardedBytes).toBe(3);
  });

  it('drops garbage containing no magic byte entirely', () => {
    const parser = new FrameParser();
    expect(parser.push(Buffer.from([1, 2, 3, 4, 5, 6, 7]))).toEqual([]);
    expect(parser.pending).toBe(0);
  });

  it.each(BAD_CHECKSUM_FRAMES)('discards frame with bad checksum: $name', ({ hex }) => {
    const parser = new FrameParser();
    expect(parser.push(fromHex(hex))).toEqual([]);
  });

  it('recovers after a bad frame followed by a good one', () => {
    const parser = new FrameParser();
    const frames = parser.push(Buffer.concat([fromHex(BAD_CHECKSUM_FRAMES[0]!.hex), fromHex(COMPACT_FRAMES[1]!.hex)]));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.seq).toBe(0x1f);
  });

  it('rejects absurd payload lengths without waiting forever', () => {
    const parser = new FrameParser(64);
    const frames = parser.push(Buffer.concat([Buffer.from([0xa5, 0x22, 0x00, 0xff, 0xff, 0x00]), fromHex(COMPACT_FRAMES[0]!.hex)]));
    expect(frames).toHaveLength(1);
  });

  it('does not let a stray partial header swallow a following real frame', () => {
    const parser = new FrameParser();
    // a5 ff 00 13 01 … reads as a 275-byte payload
    expect(parser.push(Buffer.from([0xa5, 0xa5, 0xff, 0x00, 0x13]))).toEqual([]);
    expect(parser.push(Buffer.from([0x01, 0x02, 0x03]))).toEqual([]);
    const frames = parser.push(fromHex(EXTENDED_FRAMES[0]!.hex));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.seq).toBe(0x18);
    expect(parser.pending).toBe(0);
  });

  it('parseFrame returns undefined for trailing bytes', () => {
    expect(parseFrame(Buffer.concat([fromHex(COMPACT_FRAMES[0]!.hex), Buffer.from([0xa5])]))).toBeUndefined();
  });
});

describe('hex helpers', () => {
  it('fromHex accepts colon/space separated and mixed case', () => {
    expect(fromHex('A5:22 0a-FF').toString('hex')).toBe('a5220aff');
  });

  it('fromHex rejects odd length', () => {
    expect(() => fromHex('a52')).toThrow();
  });

  it('toHex formats with separator', () => {
    expect(toHex(Buffer.from([0xa5, 0x22, 0x01]))).toBe('a5 22 01');
  });
});
