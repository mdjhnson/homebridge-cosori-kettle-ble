/**
 * Platform configuration (see config.schema.json). Parsing is defensive: invalid values are replaced
 * by defaults and reported, so a typo never crashes Homebridge.
 */
import { MAX_DELAY_SECONDS, MAX_HOLD_SECONDS } from './protocol/constants.js';
import { isValidKeyString, parseKey } from './protocol/key.js';

export type ConnectionMode = 'persistent' | 'onDemand';

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
    presets: Record<'boil' | 'greenTea' | 'oolong' | 'coffee' | 'myBrew', boolean>;
  };
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
  const presetsRaw = (accessoriesRaw.presets ?? {}) as Record<string, unknown>;

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
        presets: {
          boil: bool(presetsRaw.boil, true),
          greenTea: bool(presetsRaw.greenTea, false),
          oolong: bool(presetsRaw.oolong, false),
          coffee: bool(presetsRaw.coffee, false),
          myBrew: bool(presetsRaw.myBrew, false),
        },
      },
      debug: bool(raw.debug, false),
    },
  };
}
