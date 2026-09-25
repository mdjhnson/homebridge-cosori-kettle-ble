/**
 * Platform configuration (see config.schema.json). Parsing is defensive: invalid values are replaced
 * by defaults and reported, so a typo never crashes Homebridge.
 */
import { MAX_DELAY_SECONDS, MAX_HOLD_SECONDS, MAX_SETPOINT_F, MIN_SETPOINT_F } from './protocol/constants.js';
import { isValidKeyString, parseKey } from './protocol/key.js';
import { cToF } from './util/temperature.js';

export type ConnectionMode = 'persistent' | 'onDemand';

/** A user-defined switch that heats the kettle to one temperature. */
export interface TemperatureSwitch {
  name: string;
  temperatureF: number;
  /** HAP subtype, derived from the name so reordering or retuning an item keeps its tile. */
  subtype: string;
}

/** The kettle's own presets: the default switch list, and the reference shown in the settings form. */
export const DEFAULT_SWITCHES: readonly { name: string; temperature: number }[] = [
  { name: 'Green Tea', temperature: 180 },
  { name: 'Oolong', temperature: 195 },
  { name: 'Coffee', temperature: 205 },
  { name: 'Boil', temperature: 212 },
];

/** Legacy `accessories.presets` keys (before the switch list), with their pre-list defaults. */
const LEGACY_PRESETS: readonly { key: string; name: string; temperature: number; enabledByDefault: boolean }[] = [
  { key: 'greenTea', name: 'Green Tea', temperature: 180, enabledByDefault: false },
  { key: 'oolong', name: 'Oolong', temperature: 195, enabledByDefault: false },
  { key: 'coffee', name: 'Coffee', temperature: 205, enabledByDefault: false },
  { key: 'boil', name: 'Boil', temperature: 212, enabledByDefault: true },
];

/** Letters, digits and single spaces, starting and ending with a letter or digit (HAP rejects other names). */
const SWITCH_NAME_RE = /^[\p{L}\p{N}]([\p{L}\p{N} ]*[\p{L}\p{N}])?$/u;

export interface KettlePluginConfig {
  name: string;
  mac: string;
  registrationKey?: Buffer;
  dbusAddress: string;
  adapter?: string;
  protocolVersion: 'auto' | 0 | 1;
  temperatureUnit: 'F' | 'C';
  connectionMode: ConnectionMode;
  pollIntervalSeconds: number;
  onDemandPollIntervalSeconds: number;
  idleDisconnectSeconds: number;
  keepWarmMinutes: number;
  delayStartMinutes: number;
  accessories: {
    onBaseSensor: boolean;
    keepWarmSwitch: boolean;
    delayStartSwitch: boolean;
  };
  switches: TemperatureSwitch[];
  debug: boolean;
}

export interface ParsedConfig {
  config?: KettlePluginConfig;
  errors: string[];
  warnings: string[];
}

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

function num(raw: unknown, name: string, def: number, min: number, max: number, warnings: string[]): number {
  if (raw === undefined || raw === null || raw === '') {
    return def;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    warnings.push(`${name} must be between ${min} and ${max}; using ${def}`);
    return def;
  }
  return n;
}

function bool(raw: unknown, def: boolean): boolean {
  return typeof raw === 'boolean' ? raw : def;
}

/** "Green Tea" → "preset-greenTea". Today's preset switches used exactly these subtypes, so their tiles carry over. */
export function switchSubtype(name: string): string {
  const words = name.toLowerCase().split(' ').filter(Boolean);
  return `preset-${words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('')}`;
}

/**
 * A switch temperature in °F. The °F range (104–212) and the °C range (40–100) don't overlap, so the value
 * itself says which unit it is: the default list works unchanged whatever temperatureUnit is set to.
 */
export function switchTemperatureF(value: number): number | undefined {
  if (value >= 40 && value <= 100) {
    return Math.min(MAX_SETPOINT_F, Math.max(MIN_SETPOINT_F, Math.round(cToF(value))));
  }
  if (value >= MIN_SETPOINT_F && value <= MAX_SETPOINT_F) {
    return Math.round(value);
  }
  return undefined;
}

function parseSwitches(raw: Record<string, unknown>, accessoriesRaw: Record<string, unknown>, warnings: string[]): TemperatureSwitch[] {
  let items: unknown[];
  if (Array.isArray(raw.switches)) {
    items = raw.switches;
  } else {
    if (raw.switches !== undefined) {
      warnings.push('"switches" must be a list; using the kettle presets');
    }
    const presetsRaw = accessoriesRaw.presets;
    if (presetsRaw && typeof presetsRaw === 'object') {
      // Pre-list config: keep the user's enabled presets (same tiles), and say how to move on.
      const legacy = presetsRaw as Record<string, unknown>;
      items = LEGACY_PRESETS.filter((p) => bool(legacy[p.key], p.enabledByDefault)).map(({ name, temperature }) => ({ name, temperature }));
      warnings.push('"accessories.presets" is replaced by the "Temperature switches" list in the plugin settings; '
        + `using your enabled presets for now (${items.map((i) => (i as { name: string }).name).join(', ') || 'none'})`);
      if (legacy.myBrew === true) {
        warnings.push('The MyBrew switch was removed. To heat to your own temperature, add it to the "Temperature switches" list '
          + '(e.g. name "Pour Over", temperature 200)');
      }
    } else {
      items = [...DEFAULT_SWITCHES];
    }
  }

  const out: TemperatureSwitch[] = [];
  items.forEach((item, index) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim().replace(/\s+/g, ' ') : '';
    const where = `switch ${index + 1}${name ? ` ("${name}")` : ''}`;
    if (!SWITCH_NAME_RE.test(name)) {
      warnings.push(`${where}: the name must use only letters, digits and spaces; skipped`);
      return;
    }
    const temperatureF = typeof entry.temperature === 'number' || typeof entry.temperature === 'string'
      ? switchTemperatureF(Number(entry.temperature))
      : undefined;
    if (temperatureF === undefined) {
      warnings.push(`${where}: the temperature must be 104–212 °F or 40–100 °C; skipped`);
      return;
    }
    const subtype = switchSubtype(name);
    if (out.some((s) => s.subtype === subtype)) {
      warnings.push(`${where}: another switch already has this name; skipped`);
      return;
    }
    const same = out.find((s) => Math.abs(s.temperatureF - temperatureF) <= 1);
    if (same) {
      warnings.push(`${where} and "${same.name}" heat to the same temperature, so both will show On together`);
    }
    out.push({ name, temperatureF, subtype });
  });
  return out;
}

export function parseConfig(raw: Record<string, unknown>): ParsedConfig {
  const errors: string[] = [];
  const warnings: string[] = [];

  const mac = typeof raw.mac === 'string' ? raw.mac.trim().toUpperCase().replace(/-/g, ':') : '';
  if (!MAC_RE.test(mac)) {
    errors.push('"mac" is required and must look like AA:BB:CC:DD:EE:FF (find it with `cosori-probe scan`)');
  }

  let registrationKey: Buffer | undefined;
  if (typeof raw.registrationKey === 'string' && raw.registrationKey.trim() !== '') {
    if (isValidKeyString(raw.registrationKey)) {
      registrationKey = parseKey(raw.registrationKey);
    } else {
      errors.push('"registrationKey" must be 32 hex characters');
    }
  }

  const accessoriesRaw = (raw.accessories ?? {}) as Record<string, unknown>;
  const switches = parseSwitches(raw, accessoriesRaw, warnings);

  const mode = raw.connectionMode === 'onDemand' ? 'onDemand' : 'persistent';
  if (raw.connectionMode !== undefined && raw.connectionMode !== 'onDemand' && raw.connectionMode !== 'persistent') {
    warnings.push(`unknown connectionMode "${String(raw.connectionMode)}"; using persistent`);
  }

  let adapter: string | undefined;
  if (typeof raw.adapter === 'string' && raw.adapter.trim()) {
    const value = raw.adapter.trim();
    const asMac = value.toUpperCase().replace(/-/g, ':');
    if (MAC_RE.test(asMac)) {
      adapter = asMac;
    } else if (/^hci\d+$/i.test(value)) {
      adapter = value.toLowerCase();
    } else {
      warnings.push('"adapter" must be an adapter MAC address (AA:BB:CC:DD:EE:FF, recommended) or a name like hci1; using the first adapter');
    }
  }

  const protocolRaw = raw.protocolVersion;
  const protocolVersion = protocolRaw === 0 || protocolRaw === '0' ? 0 : protocolRaw === 1 || protocolRaw === '1' ? 1 : 'auto';

  if (errors.length > 0) {
    return { errors, warnings };
  }

  return {
    errors,
    warnings,
    config: {
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Kettle',
      mac,
      registrationKey,
      dbusAddress: typeof raw.dbusAddress === 'string' && raw.dbusAddress.trim() ? raw.dbusAddress.trim() : 'auto',
      adapter,
      protocolVersion,
      temperatureUnit: raw.temperatureUnit === 'C' ? 'C' : 'F',
      connectionMode: mode,
      pollIntervalSeconds: num(raw.pollInterval, 'pollInterval', 5, 1, 300, warnings),
      onDemandPollIntervalSeconds: num(raw.onDemandPollInterval, 'onDemandPollInterval', 300, 30, 86_400, warnings),
      idleDisconnectSeconds: num(raw.idleDisconnect, 'idleDisconnect', 30, 5, 3600, warnings),
      keepWarmMinutes: num(raw.keepWarmMinutes, 'keepWarmMinutes', 30, 1, MAX_HOLD_SECONDS / 60, warnings),
      delayStartMinutes: num(raw.delayStartMinutes, 'delayStartMinutes', 30, 1, MAX_DELAY_SECONDS / 60, warnings),
      accessories: {
        onBaseSensor: bool(accessoriesRaw.onBaseSensor, true),
        keepWarmSwitch: bool(accessoriesRaw.keepWarmSwitch, true),
        delayStartSwitch: bool(accessoriesRaw.delayStartSwitch, false),
      },
      switches,
      debug: bool(raw.debug, false),
    },
  };
}
