import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { DbusError, type MethodCall, NativeDbusBus, type NativeBus } from '../../src/ble/dbus.js';
import { roundTrip } from './FakeBluez.js';

const SIGNAL = 4;
const MATCH = { sender: 'org.bluez', path: '/org/bluez/hci0/dev_X', interface: 'org.freedesktop.DBus.Properties', member: 'PropertiesChanged' };

/** A signal message as dbus-native emits it on the connection. */
function signal(path: string, body: unknown[], type = SIGNAL) {
  return { type, path, interface: MATCH.interface, member: MATCH.member, body };
}

type Callback = (err: { name?: string; message?: string } | null, ...body: unknown[]) => void;

/** A stand-in for a dbus-native client: records invokes and lets tests reply. */
class FakeNative implements NativeBus {
  readonly connection = Object.assign(new EventEmitter(), { ended: false, end() {
    this.ended = true;
  } });
  cookies: Record<number, Callback> = {};
  readonly invoked: (MethodCall & { serial?: number })[] = [];
  private serial = 1;

  invoke(msg: MethodCall & { serial?: number }, callback: Callback): void {
    msg.serial = this.serial++;
    this.invoked.push(msg);
    this.cookies[msg.serial] = callback;
  }

  reply(serial: number, ...body: unknown[]): void {
    const handler = this.cookies[serial];
    delete this.cookies[serial];
    handler?.(null, ...body);
  }

  error(serial: number, name: string, message: string): void {
    const handler = this.cookies[serial];
    delete this.cookies[serial];
    handler?.({ name, message });
  }
}

function setup() {
  const native = new FakeNative();
  const errors: string[] = [];
  const bus = new NativeDbusBus(native, SIGNAL, 'unix:path=/tmp/test', (m) => errors.push(m));
  return { native, bus, errors };
}

const GET: MethodCall = {
  destination: 'org.bluez', path: '/org/bluez/hci0', interface: 'org.freedesktop.DBus.Properties',
  member: 'Get', signature: 'ss', body: ['org.bluez.Adapter1', 'Powered'],
};

describe('NativeDbusBus.call', () => {
  it('resolves with the reply body', async () => {
    const { native, bus } = setup();
    const result = bus.call(GET, 1_000, 'read Powered');
    native.reply(1, ...roundTrip('v', [['b', true]]));
    expect(await result).toEqual(roundTrip('v', [['b', true]]));
  });

  it('turns an error reply into a DbusError named after the D-Bus error', async () => {
    const { native, bus } = setup();
    const result = bus.call(GET, 1_000, 'BLE connect');
    native.error(1, 'org.bluez.Error.Failed', 'le-connection-abort-by-local');
    await expect(result).rejects.toBeInstanceOf(DbusError);
    await expect(result).rejects.toThrow('org.bluez.Error.Failed: le-connection-abort-by-local');
  });

  it('times out, and drops the reply handler so a late reply is ignored', async () => {
    const { native, bus } = setup();
    await expect(bus.call(GET, 20, 'BLE connect')).rejects.toThrow('BLE connect timed out after 20 ms');
    expect(native.cookies[1]).toBeUndefined();
  });

  it('rejects pending and later calls when the socket fails, and reports it once', async () => {
    const { native, bus, errors } = setup();
    const pending = bus.call(GET, 5_000, 'read Powered');
    native.connection.emit('error', new Error('ECONNREFUSED'));
    native.connection.emit('end');
    await expect(pending).rejects.toThrow('D-Bus connection to unix:path=/tmp/test failed: ECONNREFUSED');
    await expect(bus.failure).rejects.toThrow('ECONNREFUSED');
    await expect(bus.call(GET, 1_000, 'read Powered')).rejects.toThrow('closed');
    expect(bus.dead).toBe(true);
    expect(errors).toEqual(['D-Bus connection error (unix:path=/tmp/test): ECONNREFUSED']);
  });

  it('close() ends the connection without reporting an error', async () => {
    const { native, bus, errors } = setup();
    const pending = bus.call(GET, 5_000, 'read Powered');
    bus.close();
    native.connection.emit('end');
    await expect(pending).rejects.toThrow('closed');
    expect(native.connection.ended).toBe(true);
    expect(errors).toEqual([]);
  });
});

describe('NativeDbusBus.subscribe', () => {
  const match = MATCH;

  it('adds a match rule, routes matching signals, and removes the rule on unsubscribe', async () => {
    const { native, bus } = setup();
    const received: unknown[][] = [];
    const subscribing = bus.subscribe(match, (body) => received.push(body));
    expect(native.invoked[0]).toMatchObject({ member: 'AddMatch', body: [expect.stringContaining(`path='${match.path}'`)] });
    native.reply(1);
    const unsubscribe = await subscribing;

    native.connection.emit('message', signal(match.path, ['org.bluez.Device1', [], []]));
    native.connection.emit('message', signal('/other', []));
    native.connection.emit('message', signal(match.path, [], 2));
    expect(received).toEqual([['org.bluez.Device1', [], []]]);

    unsubscribe();
    expect(native.invoked[1]).toMatchObject({ member: 'RemoveMatch', body: native.invoked[0]!.body });
    native.connection.emit('message', signal(match.path, []));
    expect(received).toHaveLength(1);
  });

  it('does not keep the handler when AddMatch fails', async () => {
    const { native, bus } = setup();
    const received: unknown[] = [];
    const subscribing = bus.subscribe(match, (body) => received.push(body));
    native.error(1, 'org.freedesktop.DBus.Error.AccessDenied', 'nope');
    await expect(subscribing).rejects.toThrow('AccessDenied');
    native.connection.emit('message', signal(match.path, []));
    expect(received).toEqual([]);
  });

  it('a throwing handler does not break delivery to others', async () => {
    const { native, bus } = setup();
    const received: unknown[] = [];
    const first = bus.subscribe(match, () => {
      throw new Error('bug');
    });
    native.reply(1);
    await first;
    const second = bus.subscribe(match, (body) => received.push(body));
    native.reply(2);
    await second;
    native.connection.emit('message', signal(match.path, ['x']));
    expect(received).toEqual([['x']]);
  });
});
