import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Duplex } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { DbusError, type MethodCall, NativeDbusBus, type NativeBus } from '../../src/ble/dbus.js';
import { roundTrip } from './FakeBluez.js';

const SIGNAL = 4;
const BLUEZ_OWNER = ':1.7';
const MATCH = { sender: 'org.bluez', path: '/org/bluez/hci0/dev_X', interface: 'org.freedesktop.DBus.Properties', member: 'PropertiesChanged' };

/** A signal message as dbus-native emits it on the connection (from BlueZ, broadcast, unless overridden). */
function signal(path: string, body: unknown[], extra: { type?: number; sender?: string; destination?: string } = {}) {
  return { type: SIGNAL, sender: BLUEZ_OWNER, path, interface: MATCH.interface, member: MATCH.member, body, ...extra };
}

type Callback = (err: { name?: string; message?: string } | null, ...body: unknown[]) => void;

/**
 * A stand-in for a dbus-native client: records invokes and lets tests reply. The bus daemon's own calls
 * (GetNameOwner, AddMatch, RemoveMatch) are answered automatically unless a test overrides them.
 */
class FakeNative implements NativeBus {
  readonly connection = Object.assign(new EventEmitter(), { ended: false, state: undefined as string | undefined, end() {
    this.ended = true;
  } });
  cookies: Record<number, Callback> = {};
  readonly invoked: (MethodCall & { serial?: number })[] = [];
  readonly auto = new Map<string, unknown[] | { name: string; message: string }>([
    ['GetNameOwner', [BLUEZ_OWNER]], ['AddMatch', []], ['RemoveMatch', []],
  ]);
  throwOnInvoke?: Error;
  private serial = 1;

  invoke(msg: MethodCall & { serial?: number }, callback: Callback): void {
    msg.serial = this.serial++;
    this.cookies[msg.serial] = callback;
    if (this.throwOnInvoke) {
      throw this.throwOnInvoke;
    }
    this.invoked.push(msg);
    const answer = this.auto.get(msg.member);
    if (answer) {
      const serial = msg.serial;
      queueMicrotask(() => (Array.isArray(answer) ? this.reply(serial, ...answer) : this.error(serial, answer.name, answer.message)));
    }
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

  members(): string[] {
    return this.invoked.map((m) => m.member);
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

  it('does not pass on encoding errors, which quote the message body', async () => {
    const { native, bus } = setup();
    native.throwOnInvoke = new Error('message body does not match message signature. Body:[[165,18,0,1,129,"secret"]]');
    const result = bus.call({ ...GET, member: 'WriteValue' }, 1_000, 'GATT write');
    await expect(result).rejects.toThrow('GATT write: D-Bus message could not be encoded');
    await expect(result).rejects.not.toThrow(/secret|Body/);
    expect(native.cookies).toEqual({});
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

describe('NativeDbusBus.ready', () => {
  it('waits for the handshake', async () => {
    const { native, bus } = setup();
    let ready = false;
    const waiting = bus.ready(1_000).then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    native.connection.emit('connect');
    await waiting;
    expect(ready).toBe(true);
  });

  it('resolves at once when already connected', async () => {
    const { native, bus } = setup();
    native.connection.state = 'connected';
    await bus.ready(1_000);
  });

  it('rejects when the socket fails first, or the handshake never finishes', async () => {
    const failing = setup();
    const waiting = failing.bus.ready(1_000);
    failing.native.connection.emit('error', new Error('connect ENOENT /tmp/test'));
    await expect(waiting).rejects.toThrow('D-Bus connection to unix:path=/tmp/test failed: connect ENOENT /tmp/test');
    await expect(setup().bus.ready(20)).rejects.toThrow('D-Bus connection to unix:path=/tmp/test timed out after 20 ms');
  });
});

describe('NativeDbusBus.subscribe', () => {
  const match = MATCH;

  it('looks up the sender, adds a match rule, routes matching signals, and removes the rule on unsubscribe', async () => {
    const { native, bus } = setup();
    const received: unknown[][] = [];
    const unsubscribe = await bus.subscribe(match, (body) => received.push(body));
    expect(native.invoked[0]).toMatchObject({ member: 'GetNameOwner', body: ['org.bluez'] });
    expect(native.invoked[1]).toMatchObject({ member: 'AddMatch', body: [expect.stringContaining(`path='${match.path}'`)] });

    native.connection.emit('message', signal(match.path, ['org.bluez.Device1', [], []]));
    native.connection.emit('message', signal('/other', []));
    native.connection.emit('message', signal(match.path, [], { type: 2 }));
    expect(received).toEqual([['org.bluez.Device1', [], []]]);

    unsubscribe();
    expect(native.invoked[2]).toMatchObject({ member: 'RemoveMatch', body: native.invoked[1]!.body });
    native.connection.emit('message', signal(match.path, []));
    expect(received).toHaveLength(1);
  });

  it('ignores signals from any other peer, and signals addressed to us directly', async () => {
    const { native, bus } = setup();
    const received: unknown[] = [];
    await bus.subscribe(match, (body) => received.push(body));
    native.connection.emit('message', signal(match.path, ['spoofed'], { sender: ':1.99' }));
    native.connection.emit('message', signal(match.path, ['unicast'], { destination: ':1.42' }));
    native.connection.emit('message', signal(match.path, ['no sender'], { sender: undefined }));
    native.connection.emit('message', signal(match.path, ['real']));
    expect(received).toEqual([['real']]);
  });

  it('follows a new owner (bluetoothd restarted) on the next subscribe', async () => {
    const { native, bus } = setup();
    const received: unknown[] = [];
    await bus.subscribe(match, (body) => received.push(body));
    native.auto.set('GetNameOwner', [':1.50']);
    await bus.subscribe({ ...match, path: '/org/bluez/hci0/dev_Y' }, () => undefined);
    native.connection.emit('message', signal(match.path, ['old owner']));
    native.connection.emit('message', signal(match.path, ['new owner'], { sender: ':1.50' }));
    expect(received).toEqual([['new owner']]);
  });

  it('fails, keeping no handler, when BlueZ is not on the bus or AddMatch is refused', async () => {
    const noBluez = setup();
    noBluez.native.auto.set('GetNameOwner', { name: 'org.freedesktop.DBus.Error.NameHasNoOwner', message: 'no such name' });
    await expect(noBluez.bus.subscribe(match, () => undefined)).rejects.toThrow('NameHasNoOwner');
    expect(noBluez.native.members()).not.toContain('AddMatch');

    const { native, bus } = setup();
    const received: unknown[] = [];
    native.auto.set('AddMatch', { name: 'org.freedesktop.DBus.Error.AccessDenied', message: 'nope' });
    await expect(bus.subscribe(match, (body) => received.push(body))).rejects.toThrow('AccessDenied');
    native.connection.emit('message', signal(match.path, []));
    expect(received).toEqual([]);
  });

  it('a throwing handler does not break delivery to others', async () => {
    const { native, bus } = setup();
    const received: unknown[] = [];
    await bus.subscribe(match, () => {
      throw new Error('bug');
    });
    await bus.subscribe(match, (body) => received.push(body));
    native.connection.emit('message', signal(match.path, ['x']));
    expect(received).toEqual([['x']]);
  });
});

describe('the real dbus-native client', () => {
  const require = createRequire(import.meta.url);
  const dbus = require('@homebridge/dbus-native') as { createClient(options: { stream: Duplex }): NativeBus };

  /** A socket that swallows everything, so the handshake never completes and no reply ever comes. */
  function silentStream(): Duplex {
    const stream = new Duplex({ read: () => undefined, write: (_chunk, _encoding, done) => done() });
    return Object.assign(stream, { setNoDelay: () => stream });
  }

  it('keeps pending replies in `cookies`, which call() clears on timeout', async () => {
    const client = dbus.createClient({ stream: silentStream() });
    try {
      expect(typeof client.cookies).toBe('object');
      const before = Object.keys(client.cookies!).length; // Hello
      const bus = new NativeDbusBus(client, SIGNAL, 'test', () => undefined);
      await expect(bus.call(GET, 20, 'read Powered')).rejects.toThrow('timed out');
      expect(Object.keys(client.cookies!)).toHaveLength(before);
    } finally {
      client.connection.end();
    }
  });
});
