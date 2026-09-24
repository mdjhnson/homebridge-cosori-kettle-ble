import { describe, expect, it } from 'vitest';

import {
  commandFrame, decodeMessage, delayedStartPayload, fromHex, isHeatingStage, Mode, parseFrame, ProtocolVersion, Stage, stopPayload,
} from '../../src/protocol/index.js';
import { OWN_KETTLE_FRAMES, TX_FRAMES } from '../fixtures/captures.js';

const V1 = ProtocolVersion.V1;

describe('delayed start (F1)', () => {
  it('reproduces the VeSync app capture: Green Tea in 25 min, hold 30 min', () => {
    const built = commandFrame(0x04, delayedStartPayload(V1, 25 * 60, Mode.GREEN_TEA, { holdSeconds: 30 * 60 }));
    expect(built).toEqual(fromHex(OWN_KETTLE_FRAMES.delayStartGreen25Hold30));
  });

  it('reproduces the upstream capture: boil in 3780 s, no hold', () => {
    const fx = TX_FRAMES.find((t) => t.name.startsWith('F1'))!;
    expect(commandFrame(fx.seq, delayedStartPayload(V1, 3780, Mode.BOIL))).toEqual(fromHex(fx.hex));
  });

  it('carries the temperature byte for MyBrew', () => {
    expect([...delayedStartPayload(V1, 600, Mode.MY_BREW, { tempF: 170 })]).toEqual([0x01, 0xf1, 0xa3, 0x00, 0x58, 0x02, 0x05, 170, 0x00, 0x00, 0x00]);
  });

  it.each([0, -60, 1.5, 12 * 3600 + 1])('rejects delay %s', (d) => {
    expect(() => delayedStartPayload(V1, d, Mode.BOIL)).toThrow(RangeError);
  });

  it('accepts the 12 h maximum', () => {
    expect(delayedStartPayload(V1, 43200, Mode.BOIL).readUInt16LE(4)).toBe(43200);
  });

  it('ACK has no status byte', () => {
    expect(decodeMessage(parseFrame(fromHex(OWN_KETTLE_FRAMES.delayStartAck))!)).toEqual({ kind: 'ack', command: 0xf1, status: undefined });
  });

  it('kettle reports stage 5 (delay scheduled) — not a heating stage', () => {
    const msg = decodeMessage(parseFrame(fromHex(OWN_KETTLE_FRAMES.compactDelayScheduled))!);
    expect(msg).toEqual({ kind: 'compact', stage: Stage.DELAY_SCHEDULED, mode: Mode.GREEN_TEA, setpointF: 180, tempF: 114 });
    expect(isHeatingStage(Stage.DELAY_SCHEDULED)).toBe(false);
  });

  it('cancel is a plain stop, acknowledged, then idle', () => {
    expect(commandFrame(0x05, stopPayload(V1))).toEqual(fromHex(OWN_KETTLE_FRAMES.cancelDelayStop));
    expect(decodeMessage(parseFrame(fromHex(OWN_KETTLE_FRAMES.stopAck))!)).toEqual({ kind: 'ack', command: 0xf4, status: undefined });
    expect(decodeMessage(parseFrame(fromHex(OWN_KETTLE_FRAMES.compactAfterCancel))!)).toMatchObject({ kind: 'compact', stage: Stage.IDLE });
  });

  it('plugin-sent F1 matches the builder', () => {
    expect(commandFrame(0x02, delayedStartPayload(V1, 300, Mode.GREEN_TEA, { holdSeconds: 1800 }))).toEqual(fromHex(OWN_KETTLE_FRAMES.pluginDelayStart5min));
  });

  it('extended status while scheduled exposes the delay countdown at [19–20]', () => {
    const a = decodeMessage(parseFrame(fromHex(OWN_KETTLE_FRAMES.extendedScheduled297))!);
    const b = decodeMessage(parseFrame(fromHex(OWN_KETTLE_FRAMES.extendedScheduled290))!);
    expect(a).toMatchObject({
      kind: 'extended', stage: Stage.DELAY_SCHEDULED, mode: Mode.GREEN_TEA, configuredHoldSeconds: 1800, remainingHoldSeconds: 1800,
      delaySetSeconds: 300, delayRemainingSeconds: 297,
    });
    expect(b).toMatchObject({ delaySetSeconds: 300, delayRemainingSeconds: 290 });
  });

  it('after cancel the delay setting is retained and the countdown is zero', () => {
    expect(decodeMessage(parseFrame(fromHex(OWN_KETTLE_FRAMES.extendedAfterCancel))!)).toMatchObject({
      kind: 'extended', stage: Stage.IDLE, delaySetSeconds: 300, delayRemainingSeconds: 0,
    });
  });

  it('isHeatingStage', () => {
    expect([0, 1, 2, 3, 5].map(isHeatingStage)).toEqual([false, true, true, true, false]);
  });
});
