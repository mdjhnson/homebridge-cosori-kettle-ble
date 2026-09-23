import { describe, expect, it } from 'vitest';

import { decodeMessage, fromHex, parseCompactStatus, parseExtendedStatus, parseFrame } from '../../src/protocol/index.js';
import { ACK_FRAMES, COMPACT_FRAMES, COMPLETION_FRAMES, EXTENDED_FRAMES } from '../fixtures/captures.js';

function decode(hex: string) {
  const frame = parseFrame(fromHex(hex));
  if (!frame) {
    throw new Error(`fixture did not parse: ${hex}`);
  }
  return { frame, message: decodeMessage(frame) };
}

describe('extended status', () => {
  it.each(EXTENDED_FRAMES)('$name', (fx) => {
    const { frame, message } = decode(fx.hex);
    expect(frame.frameType).toBe(0x12);
    expect(message).toEqual({
      kind: 'extended',
      stage: fx.stage,
      mode: fx.mode,
      setpointF: fx.setpointF,
      tempF: fx.tempF,
      myTempF: fx.myTempF,
      configuredHoldSeconds: fx.configuredHoldSeconds,
      remainingHoldSeconds: fx.remainingHoldSeconds,
      onBase: fx.onBase,
      babyFormula: fx.babyFormula,
    });
  });

  it('marks readings outside 40–230 °F invalid', () => {
    const payload = Buffer.from(parseFrame(fromHex(EXTENDED_FRAMES[0]!.hex))!.payload);
    payload[7] = 39;
    expect(parseExtendedStatus(payload).kind).toBe('invalid');
    payload[7] = 231;
    expect(parseExtendedStatus(payload).kind).toBe('invalid');
    payload[7] = 230;
    expect(parseExtendedStatus(payload).kind).toBe('extended');
  });

  it('drops an out-of-range MyBrew temperature but keeps the frame', () => {
    const payload = Buffer.from(parseFrame(fromHex(EXTENDED_FRAMES[0]!.hex))!.payload);
    payload[8] = 0;
    const s = parseExtendedStatus(payload);
    expect(s.kind).toBe('extended');
    expect(s.kind === 'extended' && s.myTempF).toBeUndefined();
  });

  it('rejects short payloads', () => {
    expect(parseExtendedStatus(Buffer.from([1, 0x40, 0x40, 0])).kind).toBe('invalid');
  });
});

describe('compact status', () => {
  it.each(COMPACT_FRAMES)('$hex', (fx) => {
    const { frame, message } = decode(fx.hex);
    expect(frame.frameType).toBe(0x22);
    expect(message).toEqual({ kind: 'compact', stage: fx.stage, mode: fx.mode, setpointF: fx.setpointF, tempF: fx.tempF });
  });

  it('marks invalid temperature readings', () => {
    const payload = Buffer.from(parseFrame(fromHex(COMPACT_FRAMES[0]!.hex))!.payload);
    payload[7] = 0;
    expect(parseCompactStatus(payload).kind).toBe('invalid');
  });
});

describe('completion', () => {
  it.each(COMPLETION_FRAMES)('$name', (fx) => {
    expect(decode(fx.hex).message).toEqual({ kind: 'completion', code: fx.code });
  });
});

describe('acks', () => {
  it.each(ACK_FRAMES)('$name', (fx) => {
    const { frame, message } = decode(fx.hex);
    expect(frame.seq).toBe(fx.seq);
    expect(message).toEqual({ kind: 'ack', command: fx.command, status: fx.status });
  });
});
