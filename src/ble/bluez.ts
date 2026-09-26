/**
 * Pure helpers for BlueZ's D-Bus object tree: path names, GetManagedObjects parsing, adapter
 * selection. No I/O here, so all of it is unit-tested without a bus.
 */
import { existsSync } from 'node:fs';

import { type DbusValue, unwrap } from './dbus.js';

/** Where the README tells Docker users to mount the host bus. */
export const DOCKER_HOST_DBUS_SOCKET = '/run/dbus-host/system_bus_socket';

export const BLUEZ = 'org.bluez';
export const ADAPTER_IFACE = 'org.bluez.Adapter1';
export const DEVICE_IFACE = 'org.bluez.Device1';
export const GATT_SERVICE_IFACE = 'org.bluez.GattService1';
export const GATT_CHAR_IFACE = 'org.bluez.GattCharacteristic1';
export const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
export const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';

/** Resolve the D-Bus address option to a concrete address (or undefined for the library default). */
export function resolveDbusAddress(option: string | undefined): string | undefined {
  if (option && option !== 'auto') {
    return option.startsWith('unix:') ? option : `unix:path=${option}`;
  }
  if (process.env.DBUS_SYSTEM_BUS_ADDRESS) {
    return process.env.DBUS_SYSTEM_BUS_ADDRESS;
  }
  return existsSync(DOCKER_HOST_DBUS_SOCKET) ? `unix:path=${DOCKER_HOST_DBUS_SOCKET}` : undefined;
}

/** Properties of one interface, with variants unwrapped. */
export type Properties = Record<string, unknown>;
/** path → interface → properties. */
export type ManagedObjects = Map<string, Map<string, Properties>>;

/** Turn an `a{sv}` (pairs of name and variant) into a plain object. */
export function propertiesFrom(pairs: DbusValue): Properties {
  const out: Properties = {};
  if (Array.isArray(pairs)) {
    for (const pair of pairs) {
      if (Array.isArray(pair) && typeof pair[0] === 'string') {
        out[pair[0]] = unwrap(pair[1]);
      }
    }
  }
  return out;
}

/** Parse the body of ObjectManager.GetManagedObjects (`a{oa{sa{sv}}}`). */
export function parseManagedObjects(body: DbusValue[]): ManagedObjects {
  const objects: ManagedObjects = new Map();
  const entries = body[0];
  if (!Array.isArray(entries)) {
    return objects;
  }
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
      continue;
    }
    const interfaces = new Map<string, Properties>();
    for (const iface of entry[1]) {
      if (Array.isArray(iface) && typeof iface[0] === 'string') {
        interfaces.set(iface[0], propertiesFrom(iface[1]));
      }
    }
    objects.set(entry[0], interfaces);
  }
  return objects;
}

/** `/org/bluez/hci0` + `FC:58:FA:0F:C3:26` → `/org/bluez/hci0/dev_FC_58_FA_0F_C3_26`. */
export function devicePath(adapterPath: string, mac: string): string {
  return `${adapterPath}/dev_${mac.toUpperCase().replace(/[:-]/g, '_')}`;
}

export interface BluezAdapter {
  /** hciN */
  name: string;
  path: string;
  address?: string;
  powered?: boolean;
  discovering?: boolean;
  getAddress(): Promise<string>;
}

/** Adapters in hciN order, so "the first adapter" is hci0 when there is one. */
export function adaptersFrom(objects: ManagedObjects): BluezAdapter[] {
  const out: BluezAdapter[] = [];
  for (const [path, interfaces] of objects) {
    const props = interfaces.get(ADAPTER_IFACE);
    if (!props) {
      continue;
    }
    const name = path.slice(path.lastIndexOf('/') + 1);
    const address = typeof props.Address === 'string' ? props.Address.toUpperCase() : undefined;
    out.push({
      name,
      path,
      address,
      powered: typeof props.Powered === 'boolean' ? props.Powered : undefined,
      discovering: typeof props.Discovering === 'boolean' ? props.Discovering : undefined,
      getAddress: async () => {
        if (address === undefined) {
          throw new Error(`adapter ${name} has no address`);
        }
        return address;
      },
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/** Lowercase full UUIDs, as BlueZ reports them. */
function sameUuid(value: unknown, uuid: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === uuid.toLowerCase();
}

/** Object path of a GATT service under a device, by UUID. */
export function findServicePath(objects: ManagedObjects, deviceObjectPath: string, serviceUuid: string): string | undefined {
  for (const [path, interfaces] of objects) {
    const props = interfaces.get(GATT_SERVICE_IFACE);
    if (props && path.startsWith(`${deviceObjectPath}/`) && sameUuid(props.UUID, serviceUuid)) {
      return path;
    }
  }
  return undefined;
}

export interface CharacteristicInfo {
  path: string;
  flags: string[];
}

/** A characteristic of a service, by UUID. */
export function findCharacteristic(objects: ManagedObjects, servicePath: string, charUuid: string): CharacteristicInfo | undefined {
  for (const [path, interfaces] of objects) {
    const props = interfaces.get(GATT_CHAR_IFACE);
    if (props && props.Service === servicePath && sameUuid(props.UUID, charUuid)) {
      const flags = Array.isArray(props.Flags) ? props.Flags.filter((f): f is string => typeof f === 'string') : [];
      return { path, flags };
    }
  }
  return undefined;
}

export interface DeviceSummary {
  path: string;
  address: string;
  name?: string;
  rssi?: number;
  /** Company identifiers present in the advertised manufacturer data. */
  manufacturerIds: number[];
}

/** Devices under one adapter, for scan results. */
export function devicesFrom(objects: ManagedObjects, adapterPath: string): DeviceSummary[] {
  const out: DeviceSummary[] = [];
  for (const [path, interfaces] of objects) {
    const props = interfaces.get(DEVICE_IFACE);
    if (!props || props.Adapter !== adapterPath || typeof props.Address !== 'string') {
      continue;
    }
    const manufacturer = Array.isArray(props.ManufacturerData) ? props.ManufacturerData : [];
    out.push({
      path,
      address: props.Address.toUpperCase(),
      name: typeof props.Name === 'string' ? props.Name : undefined,
      rssi: typeof props.RSSI === 'number' ? props.RSSI : undefined,
      manufacturerIds: manufacturer.map((pair) => (Array.isArray(pair) ? pair[0] : undefined)).filter((id): id is number => typeof id === 'number'),
    });
  }
  return out;
}

const ADAPTER_MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

/** True if an `adapter` option is a controller MAC address rather than an hciN name. */
export function isAdapterAddress(option: string): boolean {
  return ADAPTER_MAC_RE.test(option.toUpperCase().replace(/-/g, ':'));
}

/** What adapter selection needs (kept small for tests). */
export interface AdapterSource<A extends { getAddress(): Promise<string> }> {
  adapters(): Promise<string[]>;
  getAdapter(name: string): Promise<A>;
}

export interface AdapterInfo {
  name: string;
  address?: string;
  powered?: boolean;
}

export interface AdapterSelection<A> {
  adapter: A;
  name: string;
  address?: string;
  /** Every adapter BlueZ reported, for logging. */
  all: AdapterInfo[];
}

export class AdapterNotFoundError extends Error {}

export async function describeAdapters<A extends { getAddress(): Promise<string> }>(
  source: AdapterSource<A>,
): Promise<{ info: AdapterInfo; adapter: A }[]> {
  const names = await source.adapters();
  const out: { info: AdapterInfo; adapter: A }[] = [];
  for (const name of names) {
    const adapter = await source.getAdapter(name);
    const address = await adapter.getAddress().then((a) => a.toUpperCase(), () => undefined);
    out.push({ info: { name, address }, adapter });
  }
  return out;
}

export function formatAdapters(all: AdapterInfo[]): string {
  return all.length ? all.map((a) => (a.address ? `${a.name} (${a.address})` : a.name)).join(', ') : 'none';
}

/**
 * Pick a BlueZ adapter. `wanted` may be an hciN name or the controller's MAC address. hciN numbers
 * follow probe order and can change across reboots when there are several adapters; a MAC can't.
 * With no `wanted`, the first adapter is used.
 */
export async function selectAdapter<A extends { getAddress(): Promise<string> }>(
  source: AdapterSource<A>,
  wanted: string | undefined,
): Promise<AdapterSelection<A>> {
  const found = await describeAdapters(source);
  const all = found.map((f) => f.info);
  if (found.length === 0) {
    throw new AdapterNotFoundError('no Bluetooth adapters found in BlueZ (is one plugged in and powered? `bluetoothctl list` on the host)');
  }
  let match: { info: AdapterInfo; adapter: A } | undefined;
  if (!wanted) {
    match = found[0];
  } else if (isAdapterAddress(wanted)) {
    const address = wanted.toUpperCase().replace(/-/g, ':');
    match = found.find((f) => f.info.address === address);
  } else {
    match = found.find((f) => f.info.name === wanted);
  }
  if (!match) {
    throw new AdapterNotFoundError(`Bluetooth adapter "${wanted}" not found. Available: ${formatAdapters(all)}`);
  }
  return { adapter: match.adapter, name: match.info.name, address: match.info.address, all };
}

/** An AdapterSource over a GetManagedObjects snapshot. */
export function adapterSource(objects: ManagedObjects): AdapterSource<BluezAdapter> {
  const adapters = adaptersFrom(objects);
  return {
    adapters: async () => adapters.map((a) => a.name),
    getAdapter: async (name) => {
      const adapter = adapters.find((a) => a.name === name);
      if (!adapter) {
        throw new Error(`no adapter ${name}`);
      }
      return adapter;
    },
  };
}
