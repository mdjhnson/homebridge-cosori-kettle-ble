import { describe, expect, it } from 'vitest';

import {
  commandFrame, compactStatusPayload, fromHex, helloPayload, Mode, parseKey, pollPayload, ProtocolVersion, registerPayload,
  setHoldPayload, setModePayload, setMyTempPayload, splitIntoChunks, stopPayload,
} from '../../src/protocol/index.js';
import { BARRY_V0_HELLO, HELLO_FRAMES, TX_FRAMES } from '../fixtures/captures.js';

const V1 = ProtocolVersion.V1;
const V0 = ProtocolVersion.V0;

function tx(name: string) {
  const f = TX_FRAMES.find((t) => t.name.startsWith(name));
  if (!f) {
    throw new Error(`fixture ${name} missing`);
  }
  return f;
}

describe('command payloads reproduce real captures', () => {
  it('poll', () => {
    const f = tx('poll');
    expect(commandFrame(f.seq, pollPayload(V1))).toEqual(fromHex(f.hex));
  });

  it('compact status request', () => {
    const f = tx('compact status request');
    expect(commandFrame(f.seq, compactStatusPayload(V1))).toEqual(fromHex(f.hex));
  });

  it('stop', () => {
    const f = tx('F4 stop');
    expect(commandFrame(f.seq, stopPayload(V1))).toEqual(fromHex(f.hex));
  });

  it('set MyBrew 179°F', () => {
    const f = tx('F3 set MyBrew');
    expect(commandFrame(f.seq, setMyTempPayload(V1, 179))).toEqual(fromHex(f.hex));
  });

  it('F0 coffee preset with no hold (app sends 00 in temp byte)', () => {
    for (const f of TX_FRAMES.filter((t) => t.name.startsWith('F0 coffee'))) {
      expect(commandFrame(f.seq, setModePayload(V1, Mode.COFFEE))).toEqual(fromHex(f.hex));
    }
  });

  it.each(HELLO_FRAMES)('$cmd frame: $name', (h) => {
    const key = parseKey(h.key);
    const payload = h.cmd === 'hello' ? helloPayload(h.version as ProtocolVersion, key) : registerPayload(h.version as ProtocolVersion, key);
    const chunks = splitIntoChunks(commandFrame(h.seq, payload));
    expect(chunks.map((c) => c.toString('hex'))).toEqual(h.chunks.map((c) => c.toLowerCase()));
  });

  it('barrymichels V0 hello checksum', () => {
    const frame = commandFrame(0, helloPayload(V0, parseKey(BARRY_V0_HELLO.key)));
    expect(frame[5]).toBe(BARRY_V0_HELLO.checksum);
    expect(frame.subarray(6, 10)).toEqual(Buffer.from([0x00, 0x81, 0xd1, 0x00]));
  });
});

describe('setHoldPayload', () => {
  it('matches barrymichels V0 "HELLO5" (enable, 3600 s little-endian)', () => {
    expect(setHoldPayload(V0, 3600)).toEqual(Buffer.from([0x00, 0xf2, 0xa3, 0x00, 0x00, 0x01, 0x10, 0x0e]));
  });

  it('disables hold at 0', () => {
    expect(setHoldPayload(V1, 0)).toEqual(Buffer.from([0x01, 0xf2, 0xa3, 0x00, 0x00, 0x00, 0x00, 0x00]));
  });

  it('encodes 1800 s little-endian', () => {
    expect(setHoldPayload(V1, 1800).subarray(6)).toEqual(Buffer.from([0x08, 0x07]));
  });

  it.each([-1, 3601, 1.5])('rejects %s', (v) => {
    expect(() => setHoldPayload(V1, v)).toThrow(RangeError);
  });
});

describe('setModePayload', () => {
  it('encodes hold little-endian by default (2100 s → 34 08)', () => {
    expect(setModePayload(V1, Mode.COFFEE, { holdSeconds: 2100 })).toEqual(
      Buffer.from([0x01, 0xf0, 0xa3, 0x00, 0x03, 0x00, 0x01, 0x34, 0x08]),
    );
  });

  it('can encode hold big-endian for on-device verification', () => {
    expect(setModePayload(V1, Mode.COFFEE, { holdSeconds: 2100, holdByteOrder: 'be' }).subarray(7)).toEqual(Buffer.from([0x08, 0x34]));
  });

  it('matches barrymichels V0 setpoint layout when temp is given', () => {
    expect(setModePayload(V0, Mode.BOIL, { tempF: 212, holdSeconds: 3600 })).toEqual(
      Buffer.from([0x00, 0xf0, 0xa3, 0x00, 0x04, 0xd4, 0x01, 0x10, 0x0e]),
    );
  });

  it('requires a temperature for MyBrew', () => {
    expect(() => setModePayload(V1, Mode.MY_BREW)).toThrow(RangeError);
    expect(setModePayload(V1, Mode.MY_BREW, { tempF: 179 })[5]).toBe(179);
  });

  it('clamps temperatures to 104–212 °F', () => {
    expect(setModePayload(V1, Mode.MY_BREW, { tempF: 90 })[5]).toBe(104);
    expect(setMyTempPayload(V1, 250)[4]).toBe(212);
  });

  it('rejects unknown modes', () => {
    expect(() => setModePayload(V1, 0x09)).toThrow(RangeError);
    expect(() => setModePayload(V1, Mode.NONE)).toThrow(RangeError);
  });
});
