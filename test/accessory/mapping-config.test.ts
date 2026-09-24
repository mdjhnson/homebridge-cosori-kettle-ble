import { describe, expect, it } from 'vitest';

import {
  currentFToC, firmwareRevision, targetCToF, targetFToC, TemperatureSmoother,
} from '../../src/accessory/mapping.js';
import { parseConfig } from '../../src/config.js';

describe('temperature mapping', () => {
  it.each([[40, 104], [82, 180], [91, 196], [96, 205], [100, 212], [75, 167], [39, 104], [101, 212]])('%s °C → %s °F', (c, f) => {
    expect(targetCToF(c)).toBe(f);
  });

  it.each([[104, 40], [180, 82], [195, 90.5], [205, 96], [212, 100], [167, 75]])('%s °F → %s °C (0.5 steps)', (f, c) => {
    expect(targetFToC(f)).toBe(c);
  });

  it('round-trips every HomeKit step to the same step', () => {
    for (let c = 40; c <= 100; c += 0.5) {
      expect(Math.abs(targetFToC(targetCToF(c)) - c)).toBeLessThanOrEqual(0.5);
    }
  });

  it('current temperature is clamped to HAP limits', () => {
    expect(currentFToC(230)).toBe(100);
    expect(currentFToC(117)).toBe(47.2);
  });
});

describe('TemperatureSmoother', () => {
  it('ignores ±1 °F flicker (as seen from the real kettle while idle)', () => {
    const s = new TemperatureSmoother();
    const readings = [112, 111, 112, 111, 112, 111, 112];
    expect(readings.map((r) => s.update(r))).toEqual([112, 112, 112, 112, 112, 112, 112]);
  });

  it('follows a steady change', () => {
    const s = new TemperatureSmoother();
    expect([110, 109, 109, 108, 108].map((r) => s.update(r))).toEqual([110, 110, 109, 109, 108]);
  });

  it('tracks fast heating immediately', () => {
    const s = new TemperatureSmoother();
    expect([120, 122, 124, 127].map((r) => s.update(r))).toEqual([120, 122, 124, 127]);
  });
});

describe('firmwareRevision', () => {
  it('maps R0007V0012 to 7.12.0', () => {
    expect(firmwareRevision('R0007V0012', '1.0.00')).toBe('7.12.0');
  });
  it('falls back to hardware revision', () => {
    expect(firmwareRevision(undefined, '1.0.00')).toBe('1.0.0');
    expect(firmwareRevision(undefined, undefined)).toBeUndefined();
  });
});

describe('parseConfig', () => {
  const base = { platform: 'CosoriKettleBLE', mac: 'fc-58-fa-0f-c3-26', registrationKey: '9903E01A3C3BAA8F6C71CBB5167E7D5F' };

  it('applies defaults and normalises the MAC', () => {
    const { config, errors, warnings } = parseConfig(base);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(config).toMatchObject({
      name: 'Kettle', mac: 'FC:58:FA:0F:C3:26', dbusAddress: 'auto', protocolVersion: 'auto', temperatureUnit: 'F',
      connectionMode: 'persistent', pollIntervalSeconds: 5, keepWarmMinutes: 30, delayStartMinutes: 30, debug: false,
      accessories: { onBaseSensor: true, keepWarmSwitch: true, delayStartSwitch: false, presets: { boil: true, greenTea: false } },
    });
    expect(config!.registrationKey!.toString('hex')).toBe('9903e01a3c3baa8f6c71cbb5167e7d5f');
  });

  it('rejects a missing or malformed MAC and a bad key', () => {
    expect(parseConfig({}).errors[0]).toMatch(/mac/);
    expect(parseConfig({ ...base, registrationKey: 'nope' }).errors[0]).toMatch(/registrationKey/);
  });

  it('allows a missing key (platform then explains how to get one)', () => {
    const { config, errors } = parseConfig({ mac: base.mac });
    expect(errors).toEqual([]);
    expect(config!.registrationKey).toBeUndefined();
  });

  it('replaces out-of-range numbers with defaults and warns', () => {
    const { config, warnings } = parseConfig({ ...base, pollInterval: 0, keepWarmMinutes: 90, delayStartMinutes: 'x' });
    expect(config).toMatchObject({ pollIntervalSeconds: 5, keepWarmMinutes: 30, delayStartMinutes: 30 });
    expect(warnings).toHaveLength(3);
  });

  it('accepts on-demand mode, Celsius and a forced protocol version', () => {
    expect(parseConfig({ ...base, connectionMode: 'onDemand', temperatureUnit: 'C', protocolVersion: '0' }).config)
      .toMatchObject({ connectionMode: 'onDemand', temperatureUnit: 'C', protocolVersion: 0 });
  });
});
