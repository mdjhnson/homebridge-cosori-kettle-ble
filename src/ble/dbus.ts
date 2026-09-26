/**
 * A thin promise wrapper around @homebridge/dbus-native: method calls with timeouts, signal
 * subscriptions, and variant decoding. The only file that imports the library, so the transport
 * can be tested against an in-memory `Bus`.
 *
 * We call BlueZ methods directly (no introspection proxies), so the library's XML parser never runs.
 */
import type { EventEmitter } from 'node:events';

import { errorMessage, TimeoutError } from '../util/async.js';

/** A value as dbus-native marshals it: variants are `[signature, value]` on the way in. */
export type DbusValue = unknown;

export interface MethodCall {
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature?: string;
  body?: DbusValue[];
}

export interface SignalMatch {
  /** Well-known sender name; the bus daemon filters on it. */
  sender: string;
  path: string;
  interface: string;
  member: string;
}

export type SignalHandler = (body: DbusValue[]) => void;

export interface Bus {
  /** True once the connection failed or was closed. A dead bus can't be reused. */
  readonly dead: boolean;
  /** Rejects with the first connection error, so callers fail fast instead of timing out. */
  readonly failure: Promise<never>;
  /** Call a method and resolve with the reply body. */
  call(msg: MethodCall, timeoutMs: number, label: string): Promise<DbusValue[]>;
  /** Subscribe to a signal (AddMatch). Resolves once the bus will deliver it; returns the unsubscribe function. */
  subscribe(match: SignalMatch, handler: SignalHandler): Promise<() => void>;
  close(): void;
}

/** An error reply from a D-Bus service, e.g. `org.bluez.Error.Failed: le-connection-abort-by-local`. */
export class DbusError extends Error {
  constructor(readonly dbusName: string, text: string) {
    super(text ? `${dbusName}: ${text}` : dbusName);
    this.name = 'DbusError';
  }
}

/** Encode a variant for a method argument, e.g. `variant('s', 'request')`. */
export function variant(signature: string, value: DbusValue): DbusValue {
  return [signature, value];
}

/** dbus-native decodes a variant as `[signatureTree, [value]]`, where the tree is `[{ type, child }]`. */
function isSignatureTree(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((node) => typeof node === 'object' && node !== null
    && !Array.isArray(node) && typeof (node as { type?: unknown }).type === 'string' && Array.isArray((node as { child?: unknown }).child));
}

/** Strip variant wrappers, recursively (so an `a{qv}` becomes `[[id, value], …]`). Buffers pass through. */
export function unwrap(value: DbusValue): DbusValue {
  if (!Array.isArray(value)) {
    return value;
  }
  if (value.length === 2 && isSignatureTree(value[0]) && Array.isArray(value[1]) && value[1].length === 1) {
    return unwrap(value[1][0]);
  }
  return value.map(unwrap);
}

export function matchRule(match: SignalMatch): string {
  return `type='signal',sender='${match.sender}',path='${match.path}',interface='${match.interface}',member='${match.member}'`;
}

// The slice of @homebridge/dbus-native we use. Its own index.d.ts doesn't declare createClient.
interface NativeMessage {
  type: number;
  path?: string;
  interface?: string;
  member?: string;
  body?: DbusValue[];
}

interface NativeError {
  name?: string;
  message?: string;
}

export interface NativeBus {
  connection: EventEmitter & { end(): void };
  /** Pending reply handlers by serial (internal, but stable across versions). */
  cookies?: Record<number, unknown>;
  invoke(msg: MethodCall & { serial?: number }, callback: (err: NativeError | null, ...body: DbusValue[]) => void): void;
}

interface DbusNative {
  createClient(options: { busAddress: string }): NativeBus;
  messageType: { signal: number };
}

const DEFAULT_SYSTEM_BUS = 'unix:path=/var/run/dbus/system_bus_socket';

/** `Bus` over a dbus-native client. Exported for tests. */
export class NativeDbusBus implements Bus {
  dead = false;
  readonly failure: Promise<never>;
  private fail: (err: Error) => void = () => undefined;
  private closed = false;
  private readonly pending = new Set<(err: Error) => void>();
  private readonly subscriptions = new Set<{ match: SignalMatch; handler: SignalHandler }>();

  constructor(private readonly bus: NativeBus, signalType: number, private readonly where: string, private readonly onError: (message: string) => void) {
    this.failure = new Promise<never>((_, reject) => {
      this.fail = reject;
    });
    this.failure.catch(() => undefined);
    // An unhandled 'error' event would crash Homebridge.
    bus.connection.on('error', (err: unknown) => this.die(err));
    bus.connection.on('end', () => this.die(new Error('connection closed')));
    bus.connection.on('message', (msg: NativeMessage) => {
      if (msg.type === signalType) {
        this.dispatch(msg);
      }
    });
  }

  private die(err: unknown): void {
    if (this.dead) {
      return;
    }
    this.dead = true;
    if (this.closed) {
      return;
    }
    this.onError(`D-Bus connection error (${this.where}): ${errorMessage(err)}`);
    const error = new Error(`D-Bus connection to ${this.where} failed: ${errorMessage(err)}`, { cause: err });
    this.fail(error);
    for (const reject of this.pending) {
      reject(error);
    }
    this.pending.clear();
  }

  private dispatch(msg: NativeMessage): void {
    for (const { match, handler } of this.subscriptions) {
      if (match.path === msg.path && match.interface === msg.interface && match.member === msg.member) {
        try {
          handler(msg.body ?? []);
        } catch {
          // a handler bug must not break the connection's message loop
        }
      }
    }
  }

  call(msg: MethodCall, timeoutMs: number, label: string): Promise<DbusValue[]> {
    if (this.dead) {
      return Promise.reject(new Error(`D-Bus connection to ${this.where} is closed`));
    }
    return new Promise<DbusValue[]>((resolve, reject) => {
      const out: MethodCall & { serial?: number } = { ...msg };
      let timer: NodeJS.Timeout | undefined = undefined;
      const settle = () => {
        clearTimeout(timer);
        this.pending.delete(reject);
      };
      timer = setTimeout(() => {
        settle();
        // Forget the reply handler so a late reply is dropped.
        if (out.serial !== undefined && this.bus.cookies) {
          delete this.bus.cookies[out.serial];
        }
        reject(new TimeoutError(label, timeoutMs));
      }, timeoutMs);
      this.pending.add(reject);
      this.bus.invoke(out, (err, ...body) => {
        settle();
        if (err) {
          reject(new DbusError(err.name ?? 'org.freedesktop.DBus.Error.Failed', err.message ?? ''));
        } else {
          resolve(body);
        }
      });
    });
  }

  async subscribe(match: SignalMatch, handler: SignalHandler): Promise<() => void> {
    const entry = { match, handler };
    this.subscriptions.add(entry);
    const rule = matchRule(match);
    try {
      await this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus',
        member: 'AddMatch', signature: 's', body: [rule] }, 5_000, 'D-Bus AddMatch');
    } catch (err) {
      this.subscriptions.delete(entry);
      throw err;
    }
    return () => {
      if (!this.subscriptions.delete(entry) || this.dead) {
        return;
      }
      this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus',
        member: 'RemoveMatch', signature: 's', body: [rule] }, 5_000, 'D-Bus RemoveMatch').catch(() => undefined);
    };
  }

  close(): void {
    this.closed = true;
    this.dead = true;
    this.subscriptions.clear();
    for (const reject of this.pending) {
      reject(new Error('D-Bus connection closed'));
    }
    this.pending.clear();
    try {
      this.bus.connection.end();
    } catch {
      // already closed
    }
  }
}

export type BusFactory = (address: string | undefined, onError: (message: string) => void) => Promise<Bus>;

/** Open the system bus (or `address`). Connection errors surface through `failure`, not as a throw. */
export const openBus: BusFactory = async (address, onError) => {
  const { default: dbus } = await import('@homebridge/dbus-native') as unknown as { default: DbusNative };
  const busAddress = address ?? DEFAULT_SYSTEM_BUS;
  return new NativeDbusBus(dbus.createClient({ busAddress }), dbus.messageType.signal, address ?? 'default system bus', onError);
};
