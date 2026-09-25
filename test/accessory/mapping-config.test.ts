import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  currentFToC, firmwareRevision, targetCToF, targetFToC, TemperatureSmoother,
} from '../../src/accessory/mapping.js';
import { DEFAULT_SWITCHES, parseConfig, SWITCH_NAME_RE, switchSubtype, switchTemperatureF } from '../../src/config.js';

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
      connectionMode: 'persistent', pollIntervalSeconds: 5, keepWarmMinutes: 30, debug: false,
      accessories: { onBaseSensor: true, keepWarmSwitch: true },
      switchesSkipped: false,
    });
    expect(config!.switches).toBeUndefined(); // no list: the accessory picks the defaults
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
    const { config, warnings } = parseConfig({ ...base, pollInterval: 0, keepWarmMinutes: 90 });
    expect(config).toMatchObject({ pollIntervalSeconds: 5, keepWarmMinutes: 30 });
    expect(warnings).toHaveLength(2);
  });

  it('explains the Delay Start removal only to configs that had it on', () => {
    expect(parseConfig({ ...base, accessories: { delayStartSwitch: true }, delayStartMinutes: 25 }).warnings)
      .toEqual([expect.stringMatching(/Delay Start switch was removed.*Home app automation/)]);
    expect(parseConfig({ ...base, accessories: { delayStartSwitch: false }, delayStartMinutes: 25 }).warnings).toEqual([]);
  });

  it('accepts an adapter MAC (normalised) or hciN name, and warns on anything else', () => {
    expect(parseConfig({ ...base, adapter: ' 00-1a-7d-da-71-13 ' }).config!.adapter).toBe('00:1A:7D:DA:71:13');
    expect(parseConfig({ ...base, adapter: 'HCI1' }).config!.adapter).toBe('hci1');
    expect(parseConfig({ ...base, adapter: '' }).config!.adapter).toBeUndefined();
    const { config, warnings } = parseConfig({ ...base, adapter: 'usb dongle' });
    expect(config!.adapter).toBeUndefined();
    expect(warnings).toEqual([expect.stringMatching(/"adapter" must be/)]);
  });

  it('accepts on-demand mode, Celsius and a forced protocol version', () => {
    expect(parseConfig({ ...base, connectionMode: 'onDemand', temperatureUnit: 'C', protocolVersion: '0' }).config)
      .toMatchObject({ connectionMode: 'onDemand', temperatureUnit: 'C', protocolVersion: 0 });
  });

  describe('temperature switches', () => {
    it('parses a custom list, in °F or °C', () => {
      const { config, warnings } = parseConfig({ ...base, switches: [
        { name: 'Pour Over', temperature: 200 },
        { name: '  White   Tea ', temperature: 80 }, // °C, extra spaces
      ] });
      expect(warnings).toEqual([]);
      expect(config!.switches).toEqual([
        { name: 'Pour Over', temperatureF: 200, subtype: 'preset-pourOver' },
        { name: 'White Tea', temperatureF: 176, subtype: 'preset-whiteTea' },
      ]);
    });

    it('treats an empty list, or one with only blank rows, as no list', () => {
      for (const switches of [[], [{}], [{ name: ' ', temperature: '' }, null]]) {
        const { config, warnings } = parseConfig({ ...base, switches });
        expect(config!.switches).toBeUndefined();
        expect(warnings).toEqual([]);
      }
    });

    it('defaults to the kettle presets', () => {
      expect(DEFAULT_SWITCHES).toEqual([
        { name: 'Green Tea', temperatureF: 180, subtype: 'preset-greenTea' },
        { name: 'Oolong', temperatureF: 195, subtype: 'preset-oolong' },
        { name: 'Coffee', temperatureF: 205, subtype: 'preset-coffee' },
        { name: 'Boil', temperatureF: 212, subtype: 'preset-boil' },
      ]);
    });

    it('skips bad names, out-of-range temperatures and duplicate names, and warns about shared temperatures', () => {
      const { config, warnings } = parseConfig({ ...base, switches: [
        { name: 'Boil (212°F)', temperature: 212 },
        { name: 'Too Hot', temperature: 230 },
        { name: 'Between Units', temperature: 102 },
        { name: 'Tea', temperature: 180 },
        { name: 'tea', temperature: 190 },
        { name: 'Green Tea', temperature: 181 },
        { temperature: 200 },
        { name: 'A', temperature: 200 },
      ] });
      expect(config!.switches!.map((s) => s.name)).toEqual(['Tea', 'Green Tea']);
      expect(config!.switchesSkipped).toBe(true);
      const kept = '; skipped (an existing tile for it is kept until this is fixed)';
      expect(warnings).toEqual([
        `switch 1 ("Boil (212°F)"): the name must be at least two characters, using only letters, digits and spaces${kept}`,
        `switch 2 ("Too Hot"): the temperature must be 104–212 °F or 40–100 °C${kept}`,
        `switch 3 ("Between Units"): the temperature must be 104–212 °F or 40–100 °C${kept}`,
        `switch 5 ("tea"): "Tea" already has this name (capitals and spaces don't count)${kept}`,
        'switch 6 ("Green Tea") and "Tea" both heat to 180 °F, so both will show On together',
        `switch 7: the name must be at least two characters, using only letters, digits and spaces${kept}`,
        `switch 8 ("A"): the name must be at least two characters, using only letters, digits and spaces${kept}`,
      ]);
    });

    it('counts names that differ only in spaces as duplicates, and keeps the skipped one\'s tile (its subtype differs)', () => {
      const { config, warnings } = parseConfig({ ...base, switches: [{ name: 'Green Tea', temperature: 170 }, { name: 'Greentea', temperature: 175 }] });
      expect(config!.switches!.map((s) => s.subtype)).toEqual(['preset-greenTea']);
      expect(config!.switchesSkipped).toBe(true);
      expect(warnings).toEqual(['switch 2 ("Greentea"): "Green Tea" already has this name (capitals and spaces don\'t count); '
        + 'skipped (an existing tile for it is kept until this is fixed)']);
    });

    it('stores the setpoint the kettle heats to, so near-preset temperatures that share a preset are flagged', () => {
      const { config, warnings } = parseConfig({ ...base, switches: [{ name: 'Tea A', temperature: 179 }, { name: 'Tea B', temperature: 181 }] });
      expect(config!.switches!.map((s) => s.temperatureF)).toEqual([180, 180]);
      expect(warnings).toEqual(['switch 2 ("Tea B") and "Tea A" both heat to 180 °F, so both will show On together']);
      // Two MyBrew temperatures 1 °F apart are distinct.
      expect(parseConfig({ ...base, switches: [{ name: 'Tea A', temperature: 200 }, { name: 'Tea B', temperature: 201 }] }).warnings).toEqual([]);
    });

    it('migrates the old preset checkboxes, keeping their tiles, and explains the MyBrew removal', () => {
      const { config, warnings } = parseConfig({ ...base, accessories: { presets: { boil: true, greenTea: true, coffee: false, myBrew: true } } });
      expect(config!.switches!.map((s) => s.subtype)).toEqual(['preset-greenTea', 'preset-boil']);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatch(/"accessories\.presets" is replaced .* \(Green Tea, Boil\)/);
      expect(warnings[1]).toMatch(/MyBrew switch was removed/);
      // An old config that never touched the checkboxes had only Boil.
      expect(parseConfig({ ...base, accessories: { presets: {} } }).config!.switches!.map((s) => s.name)).toEqual(['Boil']);
    });

    it('ignores a "switches" value that is not a list, says so, and keeps the existing tiles', () => {
      const { config, warnings } = parseConfig({ ...base, switches: {}, accessories: { presets: { boil: true } } });
      expect(config!.switches!.map((s) => s.name)).toEqual(['Boil']);
      expect(config!.switchesSkipped).toBe(true);
      expect(warnings[0]).toBe('"switches" must be a list; ignoring it (existing switch tiles are kept until this is fixed)');
      const noLegacy = parseConfig({ ...base, switches: { name: 'Pour Over', temperature: 200 } }).config!;
      expect(noLegacy.switches).toBeUndefined();
      expect(noLegacy.switchesSkipped).toBe(true);
      // null is the same as no list.
      expect(parseConfig({ ...base, switches: null })).toMatchObject({ warnings: [], config: { switchesSkipped: false } });
    });

    it('the settings form accepts every name the plugin accepts, and rejects ASCII punctuation', () => {
      const schema = JSON.parse(readFileSync(new URL('../../config.schema.json', import.meta.url), 'utf8'));
      const pattern = new RegExp(schema.schema.properties.switches.items.properties.name.pattern, 'u');
      for (const name of ['Boil', 'Pour Over 200', 'Čaj', 'Чай', 'Őrlés', '緑茶 2', 'Té Verde', '  Tea  ', 'Tea  Two']) {
        expect(SWITCH_NAME_RE.test(name.trim().replace(/\s+/g, ' ')), name).toBe(true);
        expect(pattern.test(name), name).toBe(true);
      }
      for (const name of ['A', 'Boil!', 'Boil (212)', 'Tea/Coffee', ' ', '']) {
        expect(SWITCH_NAME_RE.test(name.trim()), name).toBe(false);
        expect(pattern.test(name), name).toBe(false);
      }
    });

    it('prefers the new list over the old checkboxes', () => {
      const { config, warnings } = parseConfig({ ...base, switches: [{ name: 'Boil', temperature: 212 }], accessories: { presets: { oolong: true } } });
      expect(config!.switches!.map((s) => s.name)).toEqual(['Boil']);
      expect(warnings).toEqual([]);
    });

    it('derives subtypes that match the old preset switches', () => {
      expect(['Green Tea', 'Oolong', 'Coffee', 'Boil'].map(switchSubtype)).toEqual(['preset-greenTea', 'preset-oolong', 'preset-coffee', 'preset-boil']);
      expect(switchSubtype('green  TEA')).toBe('preset-greenTea');
    });

    it('tells °C from °F by range', () => {
      expect([switchTemperatureF(100), switchTemperatureF(40), switchTemperatureF(91), switchTemperatureF(104), switchTemperatureF(212)])
        .toEqual([212, 104, 196, 104, 212]);
      expect([switchTemperatureF(39), switchTemperatureF(101), switchTemperatureF(213)]).toEqual([undefined, undefined, undefined]);
    });
  });
});
