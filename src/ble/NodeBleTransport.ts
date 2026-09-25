/**
 * BLE transport using node-ble (BlueZ over D-Bus).
 *
 * No raw HCI access, capabilities or native modules are needed: BlueZ on the host does the radio
 * work and we talk to it over the system D-Bus socket. In Docker, mount the host socket (see README)
 * and point `dbusAddress` at it.
 */
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';

import type NodeBle from 'node-ble';

import {
  DIS_HARDWARE_REVISION_UUID, DIS_MANUFACTURER_UUID, DIS_MODEL_NUMBER_UUID, DIS_SERVICE_UUID, DIS_SOFTWARE_REVISION_UUID,
  RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID,
} from '../protocol/constants.js';
import { delay, errorMessage, withTimeout } from '../util/async.js';
import { type Logger, silentLogger } from '../util/log.js';
import type { DeviceInfo, KettleTransport } from './Transport.js';

/** Where the README tells Docker users to mount the host bus. */
export const DOCKER_HOST_DBUS_SOCKET = '/run/dbus-host/system_bus_socket';

export type WriteMode = 'auto' | 'request' | 'command';

export interface NodeBleTransportOptions {
  /** e.g. "unix:path=/run/dbus-host/system_bus_socket". "auto" (default) picks the Docker mount if present, else the system default. */
  dbusAddress?: string;
  /** BlueZ adapter: an hciN name or the adapter's MAC address (stable across reboots). First adapter if omitted. */
  adapter?: string;
  /** How long to scan for the kettle when BlueZ doesn't already know it. */
  discoveryTimeoutMs?: number;
  /** BLE connect timeout (default 30 s; weak links can need 20 s+). */
  connectTimeoutMs?: number;
  /** GATT service-discovery timeout (default 30 s). */
  gattTimeoutMs?: number;
  /** GATT write type for FFF2. "auto" prefers write-with-response when the characteristic supports it. */
  writeMode?: WriteMode;
  log?: Logger;
}

export interface ScanResult {
  address: string;
  name?: string;
  rssi?: number;
  /** Company identifiers present in the advertised manufacturer data. */
  manufacturerIds: number[];
}

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

interface Session {
  bluetooth: NodeBle.Bluetooth;
  destroy: () => void;
  dead: boolean;
  /** Rejects with the first D-Bus connection error, so callers fail fast instead of timing out. */
  failure: Promise<never>;
}

/**
 * node-ble reads DBUS_SYSTEM_BUS_ADDRESS once, inside createBluetooth(). We set it only for that call
 * and restore it afterwards so it doesn't leak to anything else in the process.
 */
async function createSession(dbusAddress: string | undefined, log: Logger): Promise<Session> {
  const { default: nodeBle } = await import('node-ble');
  const previous = process.env.DBUS_SYSTEM_BUS_ADDRESS;
  if (dbusAddress) {
    process.env.DBUS_SYSTEM_BUS_ADDRESS = dbusAddress;
  }
  let created: { bluetooth: NodeBle.Bluetooth; destroy(): void };
  try {
    created = nodeBle.createBluetooth();
  } finally {
    if (previous === undefined) {
      delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
    } else {
      process.env.DBUS_SYSTEM_BUS_ADDRESS = previous;
    }
  }
  let fail: (err: Error) => void = () => undefined;
  const failure = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failure.catch(() => undefined);
  const session: Session = { bluetooth: created.bluetooth, destroy: created.destroy, dead: false, failure };
  // dbus-next emits 'error' on socket problems; an unhandled 'error' event would crash Homebridge.
  const bus = (created.bluetooth as unknown as { dbus?: EventEmitter }).dbus;
  bus?.on?.('error', (err: unknown) => {
    const where = dbusAddress ?? 'default system bus';
    if (!session.dead) {
      log.debug(`D-Bus connection error (${where}): ${errorMessage(err)}`);
    }
    session.dead = true;
    fail(new Error(`D-Bus connection to ${where} failed: ${errorMessage(err)}`, { cause: err }));
  });
  return session;
}

const ADAPTER_MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

/** True if an `adapter` option is a controller MAC address rather than an hciN name. */
export function isAdapterAddress(option: string): boolean {
  return ADAPTER_MAC_RE.test(option.toUpperCase().replace(/-/g, ':'));
}

/** The slice of node-ble's Bluetooth object that adapter selection needs (kept small for tests). */
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

async function describeAdapters<A extends { getAddress(): Promise<string> }>(
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
 * With no `wanted`, the first adapter is used (the same one node-ble's defaultAdapter() returns).
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

async function lookupAdapter(session: Session, wanted: string | undefined): Promise<AdapterSelection<NodeBle.Adapter>> {
  return Promise.race([
    withTimeout(selectAdapter(session.bluetooth, wanted), 10_000, 'BlueZ adapter lookup (is bluetoothd running on the host?)'),
    session.failure,
  ]);
}

function poweredOffError(selection: AdapterSelection<unknown>): Error {
  const label = formatAdapters([selection]);
  return new Error(`Bluetooth adapter ${label} is powered off (on the host: \`sudo rfkill unblock bluetooth\`, then \`bluetoothctl power on\`)`);
}

async function startDiscoverySafe(adapter: NodeBle.Adapter): Promise<boolean> {
  try {
    if (await adapter.isDiscovering()) {
      return false;
    }
    await adapter.startDiscovery();
    return true;
  } catch (err) {
    if (/already in progress|InProgress/i.test(errorMessage(err))) {
      return false;
    }
    throw err;
  }
}

async function stopDiscoverySafe(adapter: NodeBle.Adapter): Promise<void> {
  try {
    await adapter.stopDiscovery();
  } catch {
    // not discovering / owned by another client
  }
}

export class NodeBleTransport extends EventEmitter implements KettleTransport {
  private session?: Session;
  private device?: NodeBle.Device;
  private gatt?: NodeBle.GattServer;
  private rx?: NodeBle.GattCharacteristic;
  private tx?: NodeBle.GattCharacteristic;
  private resolvedWriteType: 'request' | 'command' = 'request';
  private isConnected = false;
  private closing = false;
  private adapterNote?: string;
  private readonly log: Logger;
  private readonly mac: string;

  private readonly onValue = (buf: Buffer) => this.emit('data', buf);
  private readonly onDeviceDisconnect = () => this.handleUnexpectedDisconnect();

  constructor(mac: string, private readonly options: NodeBleTransportOptions = {}) {
    super();
    this.mac = mac.toUpperCase();
    this.log = options.log ?? silentLogger;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  private async getSession(): Promise<Session> {
    if (!this.session || this.session.dead) {
      if (this.session) {
        try {
          this.session.destroy();
        } catch {
          // ignore
        }
      }
      const address = resolveDbusAddress(this.options.dbusAddress);
      this.log.debug(`Opening D-Bus session (${address ?? 'default system bus'})`);
      this.session = await createSession(address, this.log);
    }
    return this.session;
  }

  private async getAdapter(): Promise<NodeBle.Adapter> {
    const session = await this.getSession();
    const selection = await lookupAdapter(session, this.options.adapter);
    this.noteAdapter(selection);
    if (!(await selection.adapter.isPowered())) {
      throw poweredOffError(selection);
    }
    return selection.adapter;
  }

  /** Log which adapter is in use once, and again whenever it changes (e.g. hciN renumbered after a reboot). */
  private noteAdapter(selection: AdapterSelection<unknown>): void {
    const key = `${selection.name}/${selection.address ?? ''}/${selection.all.length}`;
    if (key === this.adapterNote) {
      return;
    }
    this.adapterNote = key;
    const label = formatAdapters([selection]);
    if (!this.options.adapter && selection.all.length > 1) {
      this.log.warn(`Found ${selection.all.length} Bluetooth adapters (${formatAdapters(selection.all)}); using the first, ${label}. `
        + 'Set "adapter" to the MAC address of the one you want so the choice survives reboots.');
    } else {
      this.log.info(`Using Bluetooth adapter ${label}`);
    }
  }

  /** Find the device object in BlueZ, running discovery if it isn't already known. */
  private async findDevice(adapter: NodeBle.Adapter): Promise<NodeBle.Device> {
    try {
      return await adapter.getDevice(this.mac);
    } catch {
      // not cached by BlueZ yet
    }
    const timeout = this.options.discoveryTimeoutMs ?? 20_000;
    this.log.debug(`Kettle ${this.mac} not known to BlueZ, scanning for up to ${timeout / 1000}s`);
    const startedHere = await startDiscoverySafe(adapter);
    try {
      return await adapter.waitDevice(this.mac, timeout, 500);
    } catch (err) {
      throw new Error(`kettle ${this.mac} not found while scanning — is it in range, powered, and not connected to the VeSync app? (${errorMessage(err)})`, {
        cause: err,
      });
    } finally {
      if (startedHere) {
        await stopDiscoverySafe(adapter);
      }
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    this.closing = false;
    const adapter = await this.getAdapter();
    const device = await this.findDevice(adapter);
    // Connecting while discovery runs is a common cause of le-connection-abort on the Pi.
    if (await adapter.isDiscovering().catch(() => false)) {
      await stopDiscoverySafe(adapter);
    }
    this.device = device;
    device.on('disconnect', this.onDeviceDisconnect);

    try {
      await withTimeout(device.connect(), this.options.connectTimeoutMs ?? 30_000, 'BLE connect');
      this.gatt = await withTimeout(device.gatt(), this.options.gattTimeoutMs ?? 30_000, 'GATT service discovery');
      const service = await this.gatt.getPrimaryService(SERVICE_UUID).catch(() => {
        throw new Error(`service ${SERVICE_UUID} not found — is ${this.mac} really a Cosori kettle?`);
      });
      this.rx = await service.getCharacteristic(RX_CHAR_UUID);
      this.tx = await service.getCharacteristic(TX_CHAR_UUID);
      this.resolvedWriteType = await this.pickWriteType(this.tx);
      await this.startNotify(this.rx);
      this.isConnected = true;
      this.log.debug(`Connected to ${this.mac} (TX write type: ${this.resolvedWriteType})`);
    } catch (err) {
      await this.cleanup(true);
      throw err;
    }
  }

  private async pickWriteType(tx: NodeBle.GattCharacteristic): Promise<'request' | 'command'> {
    const mode = this.options.writeMode ?? 'auto';
    if (mode !== 'auto') {
      return mode;
    }
    const flags = await tx.getFlags().catch(() => [] as string[]);
    if (flags.includes('write')) {
      return 'request';
    }
    if (flags.includes('write-without-response')) {
      return 'command';
    }
    return 'request';
  }

  private async startNotify(rx: NodeBle.GattCharacteristic): Promise<void> {
    rx.on('valuechanged', this.onValue);
    try {
      await rx.startNotifications();
    } catch (err) {
      // BlueZ can report "NotPermitted: Notify acquired" / "InProgress" after a fast reconnect.
      this.log.debug(`startNotifications failed (${errorMessage(err)}), retrying once`);
      await rx.stopNotifications().catch(() => undefined);
      await delay(500);
      await rx.startNotifications();
    }
  }

  async write(chunk: Buffer): Promise<void> {
    if (!this.tx || !this.isConnected) {
      throw new Error('not connected');
    }
    await withTimeout(this.tx.writeValue(chunk, { type: this.resolvedWriteType }), 5_000, 'GATT write');
  }

  async txFlags(): Promise<string[]> {
    if (!this.tx) {
      throw new Error('not connected');
    }
    return this.tx.getFlags();
  }

  async readDeviceInfo(): Promise<DeviceInfo> {
    const info: DeviceInfo = { address: this.mac };
    if (this.device) {
      info.name = await this.device.getName().catch(() => undefined);
    }
    if (!this.gatt) {
      return info;
    }
    let dis: NodeBle.GattService;
    try {
      dis = await this.gatt.getPrimaryService(DIS_SERVICE_UUID);
    } catch {
      return info;
    }
    const read = async (uuid: string): Promise<string | undefined> => {
      try {
        const ch = await dis.getCharacteristic(uuid);
        const value = await withTimeout(ch.readValue(), 5_000, `read ${uuid}`);
        const text = value.toString('utf8').replace(/\0+$/, '').trim();
        return text || undefined;
      } catch {
        return undefined;
      }
    };
    info.model = await read(DIS_MODEL_NUMBER_UUID);
    info.manufacturer = await read(DIS_MANUFACTURER_UUID);
    info.hardwareRevision = await read(DIS_HARDWARE_REVISION_UUID);
    info.softwareRevision = await read(DIS_SOFTWARE_REVISION_UUID);
    return info;
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    await this.cleanup(true);
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    if (this.session) {
      try {
        this.session.destroy();
      } catch {
        // ignore
      }
      this.session = undefined;
    }
    this.removeAllListeners();
  }

  private handleUnexpectedDisconnect(): void {
    if (this.closing) {
      return;
    }
    const wasConnected = this.isConnected;
    void this.cleanup(false).finally(() => {
      if (wasConnected) {
        this.emit('disconnect');
      }
    });
  }

  private async cleanup(disconnectDevice: boolean): Promise<void> {
    this.isConnected = false;
    const { rx, device } = this;
    this.rx = undefined;
    this.tx = undefined;
    this.gatt = undefined;
    this.device = undefined;
    if (rx) {
      rx.removeListener('valuechanged', this.onValue);
      if (disconnectDevice) {
        await withTimeout(rx.stopNotifications(), 3_000, 'stopNotifications').catch(() => undefined);
      }
    }
    if (device) {
      device.removeListener('disconnect', this.onDeviceDisconnect);
      if (disconnectDevice) {
        await withTimeout(device.disconnect(), 5_000, 'BLE disconnect').catch(() => undefined);
      }
    }
  }

  /** List the Bluetooth adapters BlueZ knows, with address and power state. */
  static async listAdapters(options: Pick<NodeBleTransportOptions, 'dbusAddress' | 'log'> = {}): Promise<AdapterInfo[]> {
    const session = await createSession(resolveDbusAddress(options.dbusAddress), options.log ?? silentLogger);
    try {
      const found = await Promise.race([
        withTimeout(describeAdapters(session.bluetooth), 10_000, 'BlueZ adapter lookup (is bluetoothd running on the host?)'),
        session.failure,
      ]);
      const out: AdapterInfo[] = [];
      for (const { info, adapter } of found) {
        out.push({ ...info, powered: await adapter.isPowered().catch(() => undefined) });
      }
      return out;
    } finally {
      session.destroy();
    }
  }

  /** Scan for nearby devices. Returns everything BlueZ saw; callers filter by name. */
  static async scan(options: NodeBleTransportOptions & { durationMs?: number } = {}): Promise<ScanResult[]> {
    const log = options.log ?? silentLogger;
    const session = await createSession(resolveDbusAddress(options.dbusAddress), log);
    try {
      const selection = await lookupAdapter(session, options.adapter);
      const { adapter } = selection;
      log.debug(`Scanning on ${formatAdapters([selection])}`);
      if (!(await adapter.isPowered())) {
        throw poweredOffError(selection);
      }
      const startedHere = await startDiscoverySafe(adapter);
      await delay(options.durationMs ?? 10_000);
      // Read properties while discovery is still running: BlueZ drops RSSI once it stops.
      const results: ScanResult[] = [];
      for (const address of await adapter.devices()) {
        const device = await adapter.getDevice(address).catch(() => undefined);
        if (!device) {
          continue;
        }
        const name = await device.getName().catch(() => undefined);
        const rssiRaw = await device.getRSSI().catch(() => undefined);
        const rssi = rssiRaw === undefined ? undefined : Number(rssiRaw);
        const manufacturer = await device.getManufacturerData().catch(() => undefined);
        results.push({
          address,
          name,
          rssi: Number.isFinite(rssi) ? rssi : undefined,
          manufacturerIds: manufacturer ? Object.keys(manufacturer).map(Number).filter(Number.isFinite) : [],
        });
      }
      if (startedHere) {
        await stopDiscoverySafe(adapter);
      }
      return results;
    } finally {
      session.destroy();
    }
  }
}
