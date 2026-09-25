/**
 * Platform configuration (see config.schema.json). Parsing is defensive: invalid values are replaced
 * by defaults and reported, so a typo never crashes Homebridge.
 */
import {
  effectiveSetpointF, MAX_DELAY_SECONDS, MAX_HOLD_SECONDS, MAX_SETPOINT_F, MIN_SETPOINT_F, Mode, PRESET_TEMP_F, setpointFromC,
} from './protocol/constants.js';
import { isValidKeyString, parseKey } from './protocol/key.js';

export type ConnectionMode = 'persistent' | 'onDemand';

/** A user-defined switch that heats the kettle to one temperature. */
export interface TemperatureSwitch {
  name: string;
  /** The setpoint the kettle heats to: a preset's own temperature when the configured one snaps to it. */
  temperatureF: number;
  /** HAP subtype, derived from the name so reordering or retuning an item keeps its tile. */
  subtype: string;
}

/** The kettle's presets, with their old `accessories.presets` checkbox keys and pre-list defaults. */
const KETTLE_PRESETS = [
  { name: 'Green Tea', mode: Mode.GREEN_TEA, legacyKey: 'greenTea', legacyDefault: false },
  { name: 'Oolong', mode: Mode.OOLONG, legacyKey: 'oolong', legacyDefault: false },
  { name: 'Coffee', mode: Mode.COFFEE, legacyKey: 'coffee', legacyDefault: false },
  { name: 'Boil', mode: Mode.BOIL, legacyKey: 'boil', legacyDefault: true },
] as const;

/**
 * Letters, digits and single spaces, starting and ending with a letter or digit, so at least two characters
 * (HAP rejects other names). config.schema.json has a looser pattern that never blocks a name valid here.
 */
export const SWITCH_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ]*[\p{L}\p{N}]$/u;

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
  /**
   * The temperature switches, or undefined when the config has no list (missing or empty). The accessory then
   * uses DEFAULT_SWITCHES for a new install, and keeps an older install's preset tiles.
   */
  switches?: TemperatureSwitch[];
  /** Some switch entries were invalid and skipped: their tiles are kept rather than deleted. */
  switchesSkipped: boolean;
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

/** Names that differ only in capitals or spaces ("Tea 2", "tea2") count as the same switch. */
function switchKey(name: string): string {
  return name.toLowerCase().replace(/ /g, '');
}

function toSwitch(name: string, temperatureF: number): TemperatureSwitch {
  return { name, temperatureF: effectiveSetpointF(temperatureF), subtype: switchSubtype(name) };
}

/** The kettle's four presets: the switches of a new install with no list configured. */
export const DEFAULT_SWITCHES: readonly TemperatureSwitch[] = KETTLE_PRESETS.map((p) => toSwitch(p.name, PRESET_TEMP_F[p.mode]!));

/**
 * A switch temperature in °F. The °F range (104–212) and the °C range (40–100) don't overlap, so the value
 * itself says which unit it is: the default list works unchanged whatever temperatureUnit is set to.
 */
export function switchTemperatureF(value: number): number | undefined {
  if (value >= 40 && value <= 100) {
    return setpointFromC(value);
  }
  if (value >= MIN_SETPOINT_F && value <= MAX_SETPOINT_F) {
    return Math.round(value);
  }
  return undefined;
}

/** A row with neither name nor temperature: the settings form can save an untouched or cleared list like this. */
function isBlankEntry(item: unknown): boolean {
  const entry = (item ?? {}) as Record<string, unknown>;
  const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  return blank(entry.name) && blank(entry.temperature);
}

function parseSwitches(
  raw: Record<string, unknown>, accessoriesRaw: Record<string, unknown>, warnings: string[],
): { switches?: TemperatureSwitch[]; skipped: boolean } {
  let entries: { item: unknown; index: number }[] = [];
  // A "switches" value that is not a list is a broken list: keep the existing tiles rather than delete them.
  let notAList = false;
  if (Array.isArray(raw.switches)) {
    entries = raw.switches.map((item: unknown, index) => ({ item, index })).filter(({ item }) => !isBlankEntry(item));
  } else if (raw.switches !== undefined && raw.switches !== null) {
    warnings.push('"switches" must be a list; ignoring it (existing switch tiles are kept until this is fixed)');
    notAList = true;
  }

  if (entries.length === 0) {
    const presetsRaw = accessoriesRaw.presets;
    if (!presetsRaw || typeof presetsRaw !== 'object') {
      return { skipped: notAList };
    }
    // Pre-list config: keep the user's enabled presets (same tiles), and say how to move on.
    const legacy = presetsRaw as Record<string, unknown>;
    const switches = KETTLE_PRESETS.filter((p) => bool(legacy[p.legacyKey], p.legacyDefault)).map((p) => toSwitch(p.name, PRESET_TEMP_F[p.mode]!));
    warnings.push('"accessories.presets" is replaced by the "Temperature switches" list in the plugin settings; '
      + `using your enabled presets for now (${switches.map((i) => i.name).join(', ') || 'none'})`);
    if (legacy.myBrew === true) {
      warnings.push('The MyBrew switch was removed. To heat to your own temperature, add it to the "Temperature switches" list '
        + '(e.g. name "Pour Over", temperature 200)');
    }
    return { switches, skipped: notAList };
  }

  const out: TemperatureSwitch[] = [];
  let skipped = false;
  const skip = (message: string) => {
    warnings.push(`${message}; skipped (an existing tile for it is kept until this is fixed)`);
    skipped = true;
  };
  for (const { item, index } of entries) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim().replace(/\s+/g, ' ') : '';
    const where = `switch ${index + 1}${name ? ` ("${name}")` : ''}`;
    if (!SWITCH_NAME_RE.test(name)) {
      skip(`${where}: the name must be at least two characters, using only letters, digits and spaces`);
      continue;
    }
    const temperatureF = typeof entry.temperature === 'number' || typeof entry.temperature === 'string'
      ? switchTemperatureF(Number(entry.temperature))
      : undefined;
    if (temperatureF === undefined) {
      skip(`${where}: the temperature must be 104–212 °F or 40–100 °C`);
      continue;
    }
    // Duplicates are matched more loosely than subtypes ("Greentea" vs "Green Tea"), so the skipped one may have a
    // tile of its own: keep it like any other skipped entry's.
    const sameName = out.find((s) => switchKey(s.name) === switchKey(name));
    if (sameName) {
      skip(`${where}: "${sameName.name}" already has this name (capitals and spaces don't count)`);
      continue;
    }
    const sw = toSwitch(name, temperatureF);
    const sameTemp = out.find((s) => s.temperatureF === sw.temperatureF);
    if (sameTemp) {
      warnings.push(`${where} and "${sameTemp.name}" both heat to ${sw.temperatureF} °F, so both will show On together`);
    }
    out.push(sw);
  }
  return { switches: out, skipped };
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
  const { switches, skipped: switchesSkipped } = parseSwitches(raw, accessoriesRaw, warnings);

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
      switchesSkipped,
      debug: bool(raw.debug, false),
    },
  };
}
