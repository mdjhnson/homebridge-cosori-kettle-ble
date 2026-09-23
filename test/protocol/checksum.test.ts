import { describe, expect, it } from 'vitest';

import { buildFrame, computeChecksum, fromHex, verifyChecksum } from '../../src/protocol/index.js';
import {
  ACK_FRAMES, BAD_CHECKSUM_FRAMES, COMPACT_FRAMES, COMPLETION_FRAMES, EXTENDED_FRAMES, HELLO_FRAMES, TX_FRAMES,
} from '../fixtures/captures.js';

const allGood: Array<{ name: string; hex: string }> = [
  ...TX_FRAMES,
  ...ACK_FRAMES,
  ...COMPLETION_FRAMES,
  ...COMPACT_FRAMES.map((c) => ({ name: `compact ${c.hex}`, hex: c.hex })),
  ...EXTENDED_FRAMES,
  ...HELLO_FRAMES.map((h) => ({ name: h.name, hex: h.chunks.join('') })),
];

describe('checksum', () => {
  it.each(allGood)('verifies real capture: $name', ({ hex }) => {
    expect(verifyChecksum(fromHex(hex))).toBe(true);
  });

  it.each(BAD_CHECKSUM_FRAMES)('rejects bad upstream example: $name', ({ hex }) => {
    expect(verifyChecksum(fromHex(hex))).toBe(false);
  });

  it('ignores the current value of byte 5 (treated as 0x01)', () => {
    const frame = fromHex('A5224104007201404000');
    const zeroed = Buffer.from(frame);
    zeroed[5] = 0x00;
    expect(computeChecksum(zeroed)).toBe(0x72);
  });

  it('rejects frames shorter than the header', () => {
    expect(verifyChecksum(fromHex('a52241'))).toBe(false);
  });

  // barrymichels' V0 builders use hard-coded constants; the single subtractive rule must reproduce them.
  describe('matches barrymichels V0 hard-coded checksum constants', () => {
    const seqs = [0x00, 0x01, 0x42, 0x7f, 0xb4, 0xff];

    it.each(seqs)('poll 00 40 40 00 → 0xB4 - seq (seq %i)', (seq) => {
      expect(buildFrame(0x22, seq, Buffer.from([0x00, 0x40, 0x40, 0x00]))[5]).toBe((0xb4 - seq) & 0xff);
    });

    it.each(seqs)('F2 00 F2 A3 00 00 01 10 0E → 0x7C - seq (seq %i)', (seq) => {
      const payload = Buffer.from([0x00, 0xf2, 0xa3, 0x00, 0x00, 0x01, 0x10, 0x0e]);
      expect(buildFrame(0x22, seq, payload)[5]).toBe((0x7c - seq) & 0xff);
    });

    it.each([[0x04, 212], [0x06, 180], [0x06, 104]])('F0 mode %i temp %i → 0x7D - seq - mode - temp', (mode, temp) => {
      for (const seq of seqs) {
        const payload = Buffer.from([0x00, 0xf0, 0xa3, 0x00, mode, temp, 0x01, 0x10, 0x0e]);
        expect(buildFrame(0x22, seq, payload)[5]).toBe((0x7d - seq - mode - temp) & 0xff);
      }
    });

    it.each(seqs)('F4 00 F4 A3 00 → 0x9D - seq (seq %i)', (seq) => {
      expect(buildFrame(0x22, seq, Buffer.from([0x00, 0xf4, 0xa3, 0x00]))[5]).toBe((0x9d - seq) & 0xff);
    });

    it.each(seqs)('CTRL (type 0x12) 00 41 40 00 → 0xC3 - seq (seq %i)', (seq) => {
      expect(buildFrame(0x12, seq, Buffer.from([0x00, 0x41, 0x40, 0x00]))[5]).toBe((0xc3 - seq) & 0xff);
    });
  });
});
