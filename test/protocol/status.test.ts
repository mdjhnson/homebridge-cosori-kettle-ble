import { describe, expect, it } from 'vitest';

import { decodeMessage, fromHex, parseCompactStatus, parseExtendedStatus, parseFrame } from '../../src/protocol/index.js';
import { ACK_FRAMES, COMPACT_FRAMES, COMPLETION_FRAMES, EXTENDED_FRAMES, OWN_KETTLE_FRAMES } from '../fixtures/captures.js';

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
      delaySetSeconds: fx.delaySetSeconds,
      delayRemainingSeconds: fx.delayRemainingSeconds,
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

describe('own kettle: heat-and-hold cycle started from the kettle (2026-09-24)', () => {
  it('decodes compact status while heating and after the hold', () => {
    expect(decode(OWN_KETTLE_FRAMES.compactHeatingGreen95).message)
      .toEqual({ kind: 'compact', stage: 1, mode: 1, setpointF: 180, tempF: 95 });
    expect(decode(OWN_KETTLE_FRAMES.compactHeating132).message)
      .toEqual({ kind: 'compact', stage: 1, mode: 1, setpointF: 180, tempF: 132 });
    expect(decode(OWN_KETTLE_FRAMES.compactIdleAfterHold).message)
      .toEqual({ kind: 'compact', stage: 0, mode: 0, setpointF: 180, tempF: 181 });
  });

  it('flags the armed hold in compact [8] and extended [9]', () => {
    expect(parseFrame(fromHex(OWN_KETTLE_FRAMES.compactHeatingGreen95))!.payload[8]).toBe(1);
    expect(parseFrame(fromHex(OWN_KETTLE_FRAMES.extendedHeatingHold30))!.payload[9]).toBe(1);
    expect(parseFrame(fromHex(OWN_KETTLE_FRAMES.compactIdleAfterHold))!.payload[8]).toBe(0);
  });

  it('decodes extended status while heating with a 30 min hold pending', () => {
    expect(decode(OWN_KETTLE_FRAMES.extendedHeatingHold30).message).toEqual({
      kind: 'extended', stage: 1, mode: 1, setpointF: 180, tempF: 98, myTempF: 140,
      configuredHoldSeconds: 1800, remainingHoldSeconds: 1800, onBase: true, babyFormula: false,
      delaySetSeconds: 300, delayRemainingSeconds: 0,
    });
  });

  it('decodes the heating-done completion', () => {
    expect(decode(OWN_KETTLE_FRAMES.completionHeatingDone).message).toEqual({ kind: 'completion', code: 0x20 });
  });
});
