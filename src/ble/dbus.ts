/**
 * A thin promise wrapper around @homebridge/dbus-native: method calls with timeouts, signal
 * subscriptions, and variant decoding. The only file that imports the library, so the transport
 * can be tested against an in-memory `Bus`.
 *
 * We call BlueZ methods directly (no introspection proxies), so the library's XML parser never runs.
 */
import type { EventEmitter } from 'node:events';

import { errorMessage, TimeoutError, withTimeout } from '../util/async.js';

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
  /** Well-known sender name. Only broadcast signals from its current owner are delivered. */
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
  /**
   * Subscribe to a signal (AddMatch). Resolves once the bus will deliver it; returns the unsubscribe function.
   * Looks up the sender's current owner each time, so a restarted service is picked up on the next subscribe.
   */
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
  sender?: string;
  destination?: string;
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
  connection: EventEmitter & { end(): void; state?: string };
  /** Pending reply handlers by serial (internal; the version is pinned and a test checks it on the real client). */
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
  /** Well-known name → the unique name that owns it (e.g. org.bluez → :1.7). */
  private readonly owners = new Map<string, string>();

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
    // AddMatch only filters broadcasts: any peer may address a signal to us directly, and BlueZ never does.
    if (msg.destination) {
      return;
    }
    for (const { match, handler } of this.subscriptions) {
      if (match.path === msg.path && match.interface === msg.interface && match.member === msg.member
        && msg.sender !== undefined && this.owners.get(match.sender) === msg.sender) {
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
      try {
        this.bus.invoke(out, (err, ...body) => {
          settle();
          if (err) {
            reject(new DbusError(err.name ?? 'org.freedesktop.DBus.Error.Failed', err.message ?? ''));
          } else {
            resolve(body);
          }
        });
      } catch {
        // dbus-native's encoding errors quote the whole body, which for a hello write holds the key: don't pass them on.
        settle();
        if (out.serial !== undefined && this.bus.cookies) {
          delete this.bus.cookies[out.serial];
        }
        reject(new Error(`${label}: D-Bus message could not be encoded`));
      }
    });
  }

  /**
   * Resolves once the handshake is done. Before that dbus-native queues messages and encodes them later, outside
   * `call()`'s try/catch, so an encoding error would be an uncaught exception.
   */
  ready(timeoutMs: number): Promise<void> {
    if (this.bus.connection.state === 'connected') {
      return Promise.resolve();
    }
    const connected = new Promise<void>((resolve) => this.bus.connection.once('connect', () => resolve()));
    return withTimeout(Promise.race([connected, this.failure]), timeoutMs, `D-Bus connection to ${this.where}`);
  }

  private async lookupOwner(name: string): Promise<void> {
    const [owner] = await this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus',
      member: 'GetNameOwner', signature: 's', body: [name] }, 5_000, `D-Bus GetNameOwner ${name}`);
    if (typeof owner !== 'string') {
      throw new Error(`D-Bus GetNameOwner ${name}: unexpected reply`);
    }
    this.owners.set(name, owner);
  }

  async subscribe(match: SignalMatch, handler: SignalHandler): Promise<() => void> {
    await this.lookupOwner(match.sender);
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

/** Open the system bus (or `address`) and wait for the handshake. Rejects if the bus can't be reached. */
export const openBus: BusFactory = async (address, onError) => {
  const { default: dbus } = await import('@homebridge/dbus-native') as unknown as { default: DbusNative };
  const busAddress = address ?? DEFAULT_SYSTEM_BUS;
  const bus = new NativeDbusBus(dbus.createClient({ busAddress }), dbus.messageType.signal, address ?? 'default system bus', onError);
  try {
    await bus.ready(10_000);
  } catch (err) {
    bus.close();
    throw err;
  }
  return bus;
};
