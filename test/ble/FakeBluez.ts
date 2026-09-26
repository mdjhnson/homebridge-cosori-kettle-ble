import { createRequire } from 'node:module';

import type { Bus, DbusValue, MethodCall, SignalHandler, SignalMatch } from '../../src/ble/dbus.js';
import { DbusError } from '../../src/ble/dbus.js';
import { ETEKCITY_COMPANY_ID, fromHex } from '../../src/protocol/index.js';
import { TimeoutError } from '../../src/util/async.js';
import { OWN_KETTLE_MANUFACTURER_DATA } from '../fixtures/captures.js';

const require = createRequire(import.meta.url);
const marshall = require('@homebridge/dbus-native/lib/marshall.js') as (signature: string, data: DbusValue[], offset: number) => Buffer;
const DBusBuffer = require('@homebridge/dbus-native/lib/dbus-buffer.js') as new (buffer: Buffer, start: number) => { read(signature: string): DbusValue[] };

/** Marshal and unmarshal through dbus-native, so tests see exactly what the library hands the transport. */
export function roundTrip(signature: string, body: DbusValue[]): DbusValue[] {
  return new DBusBuffer(marshall(signature, body, 0), 0).read(signature);
}

/** A property value as a variant: [signature, value]. */
export type Prop = [string, DbusValue];
export type ObjectTree = Map<string, Record<string, Record<string, Prop>>>;

export const ADAPTER_PATH = '/org/bluez/hci0';
export const ADAPTER_MAC = '00:1A:7D:DA:71:13';
export const KETTLE_MAC = 'FC:58:FA:0F:C3:26';
export const DEVICE_PATH = `${ADAPTER_PATH}/dev_FC_58_FA_0F_C3_26`;
export const RX_PATH = `${DEVICE_PATH}/service000c/char000d`;
export const TX_PATH = `${DEVICE_PATH}/service000c/char0010`;

/** The kettle's advertised manufacturer data after the 0x06D0 company id (real capture). */
export const KETTLE_MANUFACTURER_DATA = fromHex(OWN_KETTLE_MANUFACTURER_DATA);

function uuid16(short: string): string {
  return `0000${short}-0000-1000-8000-00805f9b34fb`;
}

export function kettleDevice(): Record<string, Record<string, Prop>> {
  return {
    'org.bluez.Device1': {
      Address: ['s', KETTLE_MAC],
      Name: ['s', 'Cosori Gooseneck Kettle'],
      Adapter: ['o', ADAPTER_PATH],
      RSSI: ['n', -80],
      ManufacturerData: ['a{qv}', [[ETEKCITY_COMPANY_ID, ['ay', KETTLE_MANUFACTURER_DATA]]]],
      Connected: ['b', false],
      ServicesResolved: ['b', false],
    },
  };
}

/** GATT objects BlueZ adds once services are resolved: FFF0 (FFF1 notify, FFF2 write) and the DIS. */
export function kettleGatt(): ObjectTree {
  const svc = `${DEVICE_PATH}/service000c`;
  const dis = `${DEVICE_PATH}/service0020`;
  const disChar = (n: string, short: string, value: string): [string, Record<string, Record<string, Prop>>] => [`${dis}/char00${n}`, {
    'org.bluez.GattCharacteristic1': { UUID: ['s', uuid16(short)], Service: ['o', dis], Flags: ['as', ['read']], Value: ['ay', Buffer.from(value)] },
  }];
  return new Map([
    [svc, { 'org.bluez.GattService1': { UUID: ['s', uuid16('fff0')], Device: ['o', DEVICE_PATH], Primary: ['b', true] } }],
    [RX_PATH, { 'org.bluez.GattCharacteristic1': { UUID: ['s', uuid16('fff1')], Service: ['o', svc], Flags: ['as', ['notify']] } }],
    [TX_PATH, { 'org.bluez.GattCharacteristic1': { UUID: ['s', uuid16('fff2')], Service: ['o', svc], Flags: ['as', ['write-without-response', 'write']] } }],
    [dis, { 'org.bluez.GattService1': { UUID: ['s', uuid16('180a')], Device: ['o', DEVICE_PATH], Primary: ['b', true] } }],
    disChar('21', '2a24', 'CS108-NK'),
    disChar('23', '2a27', '1.0.00\0'),
    disChar('25', '2a28', 'R0007V0012'),
  ]);
}

/** A GetManagedObjects reply body for a tree, as dbus-native decodes it. */
export function managedObjectsReply(tree: ObjectTree): DbusValue[] {
  const body = [...tree].map(([path, ifaces]) => [path, Object.entries(ifaces).map(([name, props]) => [name, Object.entries(props)])]);
  return roundTrip('a{oa{sa{sv}}}', [body]);
}

/** Reply override: return a body, throw to reply with an error, or return 'hang' to never reply. */
export type Override = (msg: MethodCall) => DbusValue[] | 'hang' | undefined | Promise<DbusValue[] | 'hang' | undefined>;

/**
 * In-memory BlueZ behind the `Bus` interface. Default behaviour: a powered hci0 that already knows
 * the kettle; Connect succeeds and resolves services right after; StartNotify and WriteValue succeed.
 */
export class FakeBluez implements Bus {
  dead = false;
  readonly failure: Promise<never>;
  readonly calls: MethodCall[] = [];
  readonly objects: ObjectTree = new Map();
  readonly overrides = new Map<string, Override>();
  /** Added to the tree once StartDiscovery runs (for "not cached" tests). */
  onDiscovery?: () => void;
  /** Connect sets Connected and then ServicesResolved (via PropertiesChanged). */
  autoResolve = true;
  closed = false;
  private fail: (err: Error) => void = () => undefined;
  private readonly subscriptions = new Set<{ match: SignalMatch; handler: SignalHandler }>();

  constructor({ deviceKnown = true, powered = true }: { deviceKnown?: boolean; powered?: boolean } = {}) {
    this.failure = new Promise<never>((_, reject) => {
      this.fail = reject;
    });
    this.failure.catch(() => undefined);
    this.objects.set(ADAPTER_PATH, {
      'org.bluez.Adapter1': { Address: ['s', ADAPTER_MAC], Powered: ['b', powered], Discovering: ['b', false] },
    });
    if (deviceKnown) {
      this.objects.set(DEVICE_PATH, kettleDevice());
    }
  }

  /** Method calls by member name, e.g. `members()` → ['GetManagedObjects', 'Get', 'Connect', …]. */
  members(): string[] {
    return this.calls.map((c) => c.member);
  }

  subscriptionCount(): number {
    return this.subscriptions.size;
  }

  setProp(path: string, iface: string, name: string, value: Prop, emit = true): void {
    const props = this.objects.get(path)?.[iface];
    if (!props) {
      throw new Error(`no ${iface} at ${path}`);
    }
    props[name] = value;
    if (emit) {
      this.emitPropertiesChanged(path, iface, { [name]: value });
    }
  }

  emitPropertiesChanged(path: string, iface: string, changed: Record<string, Prop>): void {
    const [ifaceName, pairs, invalidated] = roundTrip('sa{sv}as', [iface, Object.entries(changed), []]);
    for (const { match, handler } of [...this.subscriptions]) {
      if (match.path === path && match.interface === 'org.freedesktop.DBus.Properties' && match.member === 'PropertiesChanged') {
        handler([ifaceName, pairs, invalidated]);
      }
    }
  }

  /** A notification from FFF1. */
  notify(data: Buffer): void {
    this.emitPropertiesChanged(RX_PATH, 'org.bluez.GattCharacteristic1', { Value: ['ay', data] });
  }

  /** The kettle dropped the link. */
  dropLink(): void {
    this.setProp(DEVICE_PATH, 'org.bluez.Device1', 'ServicesResolved', ['b', false], false);
    this.setProp(DEVICE_PATH, 'org.bluez.Device1', 'Connected', ['b', false]);
  }

  /** The D-Bus socket failed. */
  kill(message = 'socket hang up'): void {
    this.dead = true;
    this.fail(new Error(`D-Bus connection to fake failed: ${message}`));
  }

  async call(msg: MethodCall, timeoutMs: number, label: string): Promise<DbusValue[]> {
    this.calls.push(msg);
    if (this.dead) {
      throw new Error('D-Bus connection to fake is closed');
    }
    const override = this.overrides.get(msg.member);
    const reply = override ? await override(msg) : undefined;
    if (reply === 'hang') {
      return Promise.race([new Promise<never>((_, reject) => setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs)), this.failure]);
    }
    return reply ?? this.defaultReply(msg);
  }

  private defaultReply(msg: MethodCall): DbusValue[] {
    const device = 'org.bluez.Device1';
    switch (msg.member) {
    case 'GetManagedObjects':
      return managedObjectsReply(this.objects);
    case 'Get': {
      const [iface, name] = msg.body as [string, string];
      const prop = this.objects.get(msg.path)?.[iface]?.[name];
      if (!prop) {
        throw new DbusError('org.freedesktop.DBus.Error.InvalidArgs', `No such property '${name}'`);
      }
      return roundTrip('v', [prop]);
    }
    case 'StartDiscovery':
      this.setProp(msg.path, 'org.bluez.Adapter1', 'Discovering', ['b', true], false);
      this.onDiscovery?.();
      return [];
    case 'StopDiscovery':
      this.setProp(msg.path, 'org.bluez.Adapter1', 'Discovering', ['b', false], false);
      return [];
    case 'Connect':
      if (!this.objects.has(msg.path)) {
        throw new DbusError('org.freedesktop.DBus.Error.UnknownObject', `Method "Connect" with signature "" on interface "${device}" doesn't exist`);
      }
      this.setProp(msg.path, device, 'Connected', ['b', true]);
      if (this.autoResolve) {
        setImmediate(() => this.resolveServices());
      }
      return [];
    case 'Disconnect':
      if (this.objects.get(msg.path)?.[device]?.Connected?.[1] === true) {
        this.dropLink();
      }
      return [];
    case 'ReadValue': {
      const value = this.objects.get(msg.path)?.['org.bluez.GattCharacteristic1']?.Value;
      return roundTrip('ay', [value?.[1] ?? Buffer.alloc(0)]);
    }
    default:
      // StartNotify, StopNotify, WriteValue, AddMatch, RemoveMatch
      return [];
    }
  }

  /** BlueZ finished GATT discovery. */
  resolveServices(): void {
    for (const [path, ifaces] of kettleGatt()) {
      this.objects.set(path, ifaces);
    }
    this.setProp(DEVICE_PATH, 'org.bluez.Device1', 'ServicesResolved', ['b', true]);
  }

  async subscribe(match: SignalMatch, handler: SignalHandler): Promise<() => void> {
    const entry = { match, handler };
    this.subscriptions.add(entry);
    const bus = { destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus' };
    await this.call({ ...bus, member: 'AddMatch' }, 5_000, 'AddMatch');
    return () => {
      if (this.subscriptions.delete(entry)) {
        this.calls.push({ ...bus, member: 'RemoveMatch' });
      }
    };
  }

  close(): void {
    this.closed = true;
    this.dead = true;
    this.subscriptions.clear();
  }
}
