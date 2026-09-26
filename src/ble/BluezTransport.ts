/**
 * BLE transport that talks to BlueZ over D-Bus directly (via @homebridge/dbus-native).
 *
 * No raw HCI access, capabilities or native modules are needed: BlueZ on the host does the radio
 * work and we talk to it over the system D-Bus socket. In Docker, mount the host socket (see README)
 * and point `dbusAddress` at it.
 */
import { EventEmitter } from 'node:events';

import {
  DIS_HARDWARE_REVISION_UUID, DIS_MANUFACTURER_UUID, DIS_MODEL_NUMBER_UUID, DIS_SERVICE_UUID, DIS_SOFTWARE_REVISION_UUID,
  RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID,
} from '../protocol/constants.js';
import { delay, errorMessage, withTimeout } from '../util/async.js';
import { type Logger, silentLogger } from '../util/log.js';
import {
  ADAPTER_IFACE, type AdapterInfo, type AdapterSelection, adapterSource, BLUEZ, type BluezAdapter, type CharacteristicInfo, DEVICE_IFACE,
  describeAdapters, devicePath, devicesFrom, findCharacteristic, findServicePath, formatAdapters, GATT_CHAR_IFACE, type ManagedObjects,
  OBJECT_MANAGER_IFACE, parseManagedObjects, propertiesFrom, PROPERTIES_IFACE, resolveDbusAddress, selectAdapter,
} from './bluez.js';
import { type Bus, type BusFactory, type DbusValue, openBus, unwrap, variant } from './dbus.js';
import type { DeviceInfo, KettleTransport } from './Transport.js';

export {
  type AdapterInfo, AdapterNotFoundError, DOCKER_HOST_DBUS_SOCKET, formatAdapters, isAdapterAddress, resolveDbusAddress,
} from './bluez.js';

export type WriteMode = 'auto' | 'request' | 'command';

export interface BluezTransportOptions {
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
  /** Opens the D-Bus connection. Tests pass an in-memory BlueZ. */
  openBus?: BusFactory;
}

export interface ScanResult {
  address: string;
  name?: string;
  rssi?: number;
  /** Company identifiers present in the advertised manufacturer data. */
  manufacturerIds: number[];
}

/** Timeout for quick BlueZ calls (property reads, discovery start/stop, object lists). */
const CALL_TIMEOUT_MS = 10_000;

function bluezCall(bus: Bus, path: string, iface: string, member: string, timeoutMs: number, label: string,
  signature?: string, body?: DbusValue[]): Promise<DbusValue[]> {
  return bus.call({ destination: BLUEZ, path, interface: iface, member, signature, body }, timeoutMs, label);
}

async function managedObjects(bus: Bus, label = 'BlueZ object list'): Promise<ManagedObjects> {
  return parseManagedObjects(await bluezCall(bus, '/', OBJECT_MANAGER_IFACE, 'GetManagedObjects', CALL_TIMEOUT_MS, label));
}

async function getProperty(bus: Bus, path: string, iface: string, name: string): Promise<unknown> {
  const body = await bluezCall(bus, path, PROPERTIES_IFACE, 'Get', CALL_TIMEOUT_MS, `read ${name}`, 'ss', [iface, name]);
  return unwrap(body[0]);
}

function openSession(options: Pick<BluezTransportOptions, 'dbusAddress' | 'openBus'>, log: Logger): Promise<Bus> {
  const address = resolveDbusAddress(options.dbusAddress);
  log.debug(`Opening D-Bus session (${address ?? 'default system bus'})`);
  return (options.openBus ?? openBus)(address, (message) => log.debug(message));
}

const ADAPTER_LOOKUP = 'BlueZ adapter lookup (is bluetoothd running on the host?)';

async function lookupAdapter(bus: Bus, wanted: string | undefined): Promise<AdapterSelection<BluezAdapter>> {
  return selectAdapter(adapterSource(await managedObjects(bus, ADAPTER_LOOKUP)), wanted);
}

function poweredOffError(selection: AdapterSelection<unknown>): Error {
  const label = formatAdapters([selection]);
  return new Error(`Bluetooth adapter ${label} is powered off (on the host: \`sudo rfkill unblock bluetooth\`, then \`bluetoothctl power on\`)`);
}

async function startDiscoverySafe(bus: Bus, adapter: BluezAdapter): Promise<boolean> {
  try {
    if (await getProperty(bus, adapter.path, ADAPTER_IFACE, 'Discovering') === true) {
      return false;
    }
    await bluezCall(bus, adapter.path, ADAPTER_IFACE, 'StartDiscovery', CALL_TIMEOUT_MS, 'StartDiscovery');
    return true;
  } catch (err) {
    if (/already in progress|InProgress/i.test(errorMessage(err))) {
      return false;
    }
    throw err;
  }
}

async function stopDiscoverySafe(bus: Bus, adapter: BluezAdapter): Promise<void> {
  try {
    await bluezCall(bus, adapter.path, ADAPTER_IFACE, 'StopDiscovery', CALL_TIMEOUT_MS, 'StopDiscovery');
  } catch {
    // not discovering / owned by another client
  }
}

/** The PropertiesChanged signal: `(interface, changed a{sv}, invalidated as)`. */
function changedProperties(body: DbusValue[], iface: string): Record<string, unknown> | undefined {
  return body[0] === iface ? propertiesFrom(body[1]) : undefined;
}

function propertiesChanged(path: string) {
  return { sender: BLUEZ, path, interface: PROPERTIES_IFACE, member: 'PropertiesChanged' };
}

export class BluezTransport extends EventEmitter implements KettleTransport {
  private bus?: Bus;
  private devicePath?: string;
  private rx?: CharacteristicInfo;
  private tx?: CharacteristicInfo;
  private unsubscribes: (() => void)[] = [];
  private resolvedWriteType: 'request' | 'command' = 'request';
  private isConnected = false;
  private closing = false;
  /** Set while connect() runs; a drop then only marks `lostDuringConnect`, and connect() fails and cleans up. */
  private connecting = false;
  private lostDuringConnect = false;
  private adapterNote?: string;
  /** Watchers for the device's Connected / ServicesResolved properties while connecting. */
  private readonly deviceEvents = new EventEmitter();
  private readonly log: Logger;
  private readonly mac: string;

  constructor(mac: string, private readonly options: BluezTransportOptions = {}) {
    super();
    this.mac = mac.toUpperCase();
    this.log = options.log ?? silentLogger;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  private async getBus(): Promise<Bus> {
    if (!this.bus || this.bus.dead) {
      this.bus?.close();
      const bus = await openSession(this.options, this.log);
      // A dead bus means no more notifications or Connected changes: treat it as a dropped link.
      bus.failure.catch(() => {
        if (this.bus === bus) {
          this.handleUnexpectedDisconnect();
        }
      });
      this.bus = bus;
    }
    return this.bus;
  }

  private async getAdapter(bus: Bus): Promise<BluezAdapter> {
    const selection = await lookupAdapter(bus, this.options.adapter);
    this.noteAdapter(selection);
    if (selection.adapter.powered === false) {
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
  private async findDevice(bus: Bus, adapter: BluezAdapter): Promise<string> {
    const path = devicePath(adapter.path, this.mac);
    const known = async () => (await managedObjects(bus)).get(path)?.has(DEVICE_IFACE) ?? false;
    if (await known()) {
      return path;
    }
    const timeout = this.options.discoveryTimeoutMs ?? 20_000;
    this.log.debug(`Kettle ${this.mac} not known to BlueZ, scanning for up to ${timeout / 1000}s`);
    const startedHere = await startDiscoverySafe(bus, adapter);
    try {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await delay(500);
        if (await known()) {
          return path;
        }
      }
      throw new Error(`kettle ${this.mac} not found while scanning — is it in range, powered, and not connected to the VeSync app? `
        + `(not seen within ${timeout} ms)`);
    } finally {
      if (startedHere) {
        await stopDiscoverySafe(bus, adapter);
      }
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    this.closing = false;
    const bus = await this.getBus();
    const adapter = await this.getAdapter(bus);
    const path = await this.findDevice(bus, adapter);
    // Connecting while discovery runs is a common cause of le-connection-abort on the Pi.
    if (await getProperty(bus, adapter.path, ADAPTER_IFACE, 'Discovering').catch(() => false) === true) {
      await stopDiscoverySafe(bus, adapter);
    }
    this.devicePath = path;
    this.connecting = true;
    this.lostDuringConnect = false;

    try {
      // Subscribe before connecting so no Connected / ServicesResolved change is missed.
      this.unsubscribes.push(await bus.subscribe(propertiesChanged(path), (body) => this.onDeviceProperties(body)));
      await bluezCall(bus, path, DEVICE_IFACE, 'Connect', this.options.connectTimeoutMs ?? 30_000, 'BLE connect');
      // A signal that arrives in the same socket read as a reply is handled before the await resumes.
      this.failIfLost('connect');
      await this.waitServicesResolved(bus, path, this.options.gattTimeoutMs ?? 30_000);
      const objects = await managedObjects(bus);
      this.failIfLost('GATT service discovery');
      const servicePath = findServicePath(objects, path, SERVICE_UUID);
      if (!servicePath) {
        throw new Error(`service ${SERVICE_UUID} not found — is ${this.mac} really a Cosori kettle?`);
      }
      const rx = findCharacteristic(objects, servicePath, RX_CHAR_UUID);
      const tx = findCharacteristic(objects, servicePath, TX_CHAR_UUID);
      if (!rx || !tx) {
        throw new Error(`characteristic ${rx ? TX_CHAR_UUID : RX_CHAR_UUID} not found on ${this.mac}`);
      }
      this.tx = tx;
      this.resolvedWriteType = this.pickWriteType(tx.flags);
      await this.startNotify(bus, rx);
      this.failIfLost('notification setup');
      this.isConnected = true;
      this.log.debug(`Connected to ${this.mac} (TX write type: ${this.resolvedWriteType})`);
    } catch (err) {
      // Disconnect also cancels a Connect that BlueZ is still attempting.
      await this.cleanup(true);
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  private failIfLost(phase: string): void {
    if (this.lostDuringConnect) {
      throw new Error(`${this.mac} disconnected during ${phase}`);
    }
  }

  private onDeviceProperties(body: DbusValue[]): void {
    const changed = changedProperties(body, DEVICE_IFACE);
    if (!changed) {
      return;
    }
    if (changed.ServicesResolved === true) {
      this.deviceEvents.emit('servicesResolved');
    }
    if (changed.Connected === false) {
      if (this.connecting) {
        this.lostDuringConnect = true;
        this.deviceEvents.emit('disconnected');
      } else {
        this.handleUnexpectedDisconnect();
      }
    }
  }

  /** GATT discovery is done when BlueZ sets ServicesResolved. Fails at once if the link drops meanwhile. */
  private async waitServicesResolved(bus: Bus, path: string, timeoutMs: number): Promise<void> {
    let onResolved = () => undefined as void;
    let onDisconnected = () => undefined as void;
    const resolved = new Promise<void>((resolve, reject) => {
      onResolved = () => resolve();
      onDisconnected = () => reject(new Error(`${this.mac} disconnected during GATT service discovery`));
      this.deviceEvents.once('servicesResolved', onResolved);
      this.deviceEvents.once('disconnected', onDisconnected);
    });
    resolved.catch(() => undefined);
    try {
      this.failIfLost('GATT service discovery');
      const already = await getProperty(bus, path, DEVICE_IFACE, 'ServicesResolved') === true;
      this.failIfLost('GATT service discovery');
      if (already) {
        return;
      }
      await withTimeout(Promise.race([resolved, bus.failure]), timeoutMs, 'GATT service discovery');
    } finally {
      this.deviceEvents.removeListener('servicesResolved', onResolved);
      this.deviceEvents.removeListener('disconnected', onDisconnected);
    }
  }

  private pickWriteType(flags: string[]): 'request' | 'command' {
    const mode = this.options.writeMode ?? 'auto';
    if (mode !== 'auto') {
      return mode;
    }
    if (flags.includes('write')) {
      return 'request';
    }
    if (flags.includes('write-without-response')) {
      return 'command';
    }
    return 'request';
  }

  private async startNotify(bus: Bus, rx: CharacteristicInfo): Promise<void> {
    this.unsubscribes.push(await bus.subscribe(propertiesChanged(rx.path), (body) => {
      const value = changedProperties(body, GATT_CHAR_IFACE)?.Value;
      if (Buffer.isBuffer(value)) {
        // dbus-native hands out a slice of the message buffer; copy it.
        this.emit('data', Buffer.from(value));
      }
    }));
    this.rx = rx;
    const start = () => bluezCall(bus, rx.path, GATT_CHAR_IFACE, 'StartNotify', CALL_TIMEOUT_MS, 'StartNotify');
    try {
      await start();
    } catch (err) {
      // BlueZ can report "NotPermitted: Notify acquired" / "InProgress" after a fast reconnect.
      this.log.debug(`startNotifications failed (${errorMessage(err)}), retrying once`);
      await bluezCall(bus, rx.path, GATT_CHAR_IFACE, 'StopNotify', CALL_TIMEOUT_MS, 'StopNotify').catch(() => undefined);
      await delay(500);
      await start();
    }
  }

  async write(chunk: Buffer): Promise<void> {
    if (!this.tx || !this.bus || !this.isConnected) {
      throw new Error('not connected');
    }
    await bluezCall(this.bus, this.tx.path, GATT_CHAR_IFACE, 'WriteValue', 5_000, 'GATT write', 'aya{sv}',
      [chunk, [['type', variant('s', this.resolvedWriteType)]]]);
  }

  async txFlags(): Promise<string[]> {
    if (!this.tx) {
      throw new Error('not connected');
    }
    return [...this.tx.flags];
  }

  async readDeviceInfo(): Promise<DeviceInfo> {
    const info: DeviceInfo = { address: this.mac };
    const { bus, devicePath: path } = this;
    if (!bus || !path) {
      return info;
    }
    let objects: ManagedObjects;
    try {
      objects = await managedObjects(bus);
    } catch {
      return info;
    }
    const name = objects.get(path)?.get(DEVICE_IFACE)?.Name;
    info.name = typeof name === 'string' ? name : undefined;
    const dis = findServicePath(objects, path, DIS_SERVICE_UUID);
    if (!dis) {
      return info;
    }
    const read = async (uuid: string): Promise<string | undefined> => {
      const ch = findCharacteristic(objects, dis, uuid);
      if (!ch) {
        return undefined;
      }
      try {
        const [value] = await bluezCall(bus, ch.path, GATT_CHAR_IFACE, 'ReadValue', 5_000, `read ${uuid}`, 'a{sv}', [[]]);
        if (!Buffer.isBuffer(value)) {
          return undefined;
        }
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
    this.bus?.close();
    this.bus = undefined;
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
    const { bus, rx, devicePath: path } = this;
    this.rx = undefined;
    this.tx = undefined;
    this.devicePath = undefined;
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
    if (!bus || bus.dead || !disconnectDevice) {
      return;
    }
    if (rx) {
      await bluezCall(bus, rx.path, GATT_CHAR_IFACE, 'StopNotify', 3_000, 'stopNotifications').catch(() => undefined);
    }
    if (path) {
      await bluezCall(bus, path, DEVICE_IFACE, 'Disconnect', 5_000, 'BLE disconnect').catch(() => undefined);
    }
  }

  /** List the Bluetooth adapters BlueZ knows, with address and power state. */
  static async listAdapters(options: Pick<BluezTransportOptions, 'dbusAddress' | 'log' | 'openBus'> = {}): Promise<AdapterInfo[]> {
    const bus = await openSession(options, options.log ?? silentLogger);
    try {
      const found = await describeAdapters(adapterSource(await managedObjects(bus, ADAPTER_LOOKUP)));
      return found.map(({ info, adapter }) => ({ ...info, powered: adapter.powered }));
    } finally {
      bus.close();
    }
  }

  /** Scan for nearby devices. Returns everything BlueZ saw; callers filter by name. */
  static async scan(options: BluezTransportOptions & { durationMs?: number } = {}): Promise<ScanResult[]> {
    const log = options.log ?? silentLogger;
    const bus = await openSession(options, log);
    try {
      const selection = await lookupAdapter(bus, options.adapter);
      const { adapter } = selection;
      log.debug(`Scanning on ${formatAdapters([selection])}`);
      if (adapter.powered === false) {
        throw poweredOffError(selection);
      }
      const startedHere = await startDiscoverySafe(bus, adapter);
      await delay(options.durationMs ?? 10_000);
      // Read properties while discovery is still running: BlueZ drops RSSI once it stops.
      const results: ScanResult[] = devicesFrom(await managedObjects(bus), adapter.path)
        .map(({ address, name, rssi, manufacturerIds }) => ({ address, name, rssi, manufacturerIds }));
      if (startedHere) {
        await stopDiscoverySafe(bus, adapter);
      }
      return results;
    } finally {
      bus.close();
    }
  }
}

