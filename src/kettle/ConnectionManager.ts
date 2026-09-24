/**
 * Keeps a KettleClient connected, authenticated and polled, and runs HomeKit commands against it.
 *
 * - persistent: stay connected; poll every pollIntervalMs; reconnect with exponential backoff.
 * - onDemand:   connect only for commands and for a slow periodic poll; stay connected while heating;
 *               disconnect after idleDisconnectMs so the VeSync app can connect in between.
 *
 * Nothing here throws into Homebridge: the loop catches everything and logs it.
 */
import { EventEmitter } from 'node:events';

import { Backoff, type BackoffOptions } from '../util/backoff.js';
import { delay, errorMessage } from '../util/async.js';
import { type Logger } from '../util/log.js';
import type { ConnectionMode } from '../config.js';
import { InvalidRegistrationKeyError } from './errors.js';
import type { DeviceInfo } from '../ble/Transport.js';
import type { KettleClient, KettleStatus } from './KettleClient.js';

export interface ConnectionManagerOptions {
  key: Buffer;
  mode: ConnectionMode;
  pollIntervalMs: number;
  onDemandPollIntervalMs: number;
  idleDisconnectMs: number;
  /** How long a command waits for the kettle to become reachable (default 45 s). */
  commandTimeoutMs?: number;
  /** Consecutive failed polls before the link is considered dead (default 3). */
  failuresBeforeReconnect?: number;
  backoff?: BackoffOptions;
  /** Minimum time between connection attempts, even when commands wake the loop (default 2 s). */
  minAttemptIntervalMs?: number;
  log: Logger;
}

type Events = {
  status: [status: KettleStatus];
  connection: [connected: boolean];
  completion: [code: number];
};

export class KettleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KettleUnavailableError';
  }
}

export class ConnectionManager extends EventEmitter<Events> {
  private stopped = true;
  private loopPromise?: Promise<void>;
  private wakeController = new AbortController();
  private readonly backoff: Backoff;
  private readonly log: Logger;
  private pendingCommands = 0;
  private nextPollAt = 0;
  private lastActivityAt = 0;
  private lastAttemptAt = 0;
  private ready = false;
  private keyRejected = false;
  private consecutiveConnectFailures = 0;
  private everConnected = false;
  private readonly waiters = new Set<{ resolve: () => void; reject: (err: Error) => void }>();

  constructor(private readonly client: KettleClient, private readonly options: ConnectionManagerOptions) {
    super();
    this.log = options.log;
    this.backoff = new Backoff(options.backoff ?? { initialMs: 2_000, maxMs: 300_000 });
    client.on('status', (s) => this.emit('status', s));
    client.on('completion', (code) => this.emit('completion', code));
    client.on('compact', (_s, changed) => {
      if (changed) {
        // Stage/mode/setpoint changed: fetch the extended status (on-base, hold) right away.
        this.nextPollAt = 0;
        this.wake();
      }
    });
    client.on('disconnect', () => {
      this.setReady(false);
      this.wake();
    });
  }

  get connected(): boolean {
    return this.ready;
  }

  get status(): KettleStatus | undefined {
    return this.client.status;
  }

  get deviceInfo(): DeviceInfo {
    return this.client.deviceInfo;
  }

  get registrationKeyRejected(): boolean {
    return this.keyRejected;
  }

  /** Whether the cached status is recent enough to report to HomeKit. */
  isFresh(now = Date.now()): boolean {
    const s = this.client.status;
    if (!s) {
      return false;
    }
    if (this.options.mode === 'onDemand' || this.ready) {
      return true;
    }
    return now - s.updatedAt < Math.max(90_000, 6 * this.options.pollIntervalMs);
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.loopPromise = this.loop().catch((err) => this.log.error(`Connection loop crashed: ${errorMessage(err)}`));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
    this.rejectWaiters(new KettleUnavailableError('plugin is shutting down'));
    await this.loopPromise;
    await this.client.disconnect().catch(() => undefined);
  }

  /** Run a command once the kettle is connected and authenticated. */
  async run<T>(label: string, fn: (client: KettleClient) => Promise<T>): Promise<T> {
    this.pendingCommands++;
    this.lastActivityAt = Date.now();
    this.wake();
    try {
      await this.waitReady(label);
      const result = await fn(this.client);
      this.lastActivityAt = Date.now();
      this.nextPollAt = 0;
      this.wake();
      return result;
    } finally {
      this.pendingCommands--;
    }
  }

  // ---------------------------------------------------------------------------------------------

  private waitReady(label: string): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    if (this.keyRejected) {
      return Promise.reject(new KettleUnavailableError('the kettle rejected the registration key; check "registrationKey" in the config'));
    }
    const timeoutMs = this.options.commandTimeoutMs ?? 45_000;
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined = undefined;
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new KettleUnavailableError(`${label}: kettle not reachable within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  private rejectWaiters(err: Error): void {
    for (const w of this.waiters) {
      w.reject(err);
    }
    this.waiters.clear();
  }

  private setReady(ready: boolean): void {
    if (ready === this.ready) {
      return;
    }
    this.ready = ready;
    this.emit('connection', ready);
    if (ready) {
      for (const w of this.waiters) {
        w.resolve();
      }
      this.waiters.clear();
    }
  }

  private wake(): void {
    this.wakeController.abort();
    this.wakeController = new AbortController();
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await delay(ms, this.wakeController.signal).catch(() => undefined);
  }

  private wantConnection(): boolean {
    return this.pendingCommands > 0 || Date.now() >= this.nextPollAt;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.options.mode === 'onDemand' && !this.wantConnection()) {
        await this.sleep(this.nextPollAt - Date.now());
        continue;
      }

      // Don't hammer BlueZ if commands keep waking us during backoff.
      const minGap = this.options.minAttemptIntervalMs ?? 2_000;
      const sinceLast = Date.now() - this.lastAttemptAt;
      if (sinceLast < minGap) {
        await delay(minGap - sinceLast);
      }

      let outcome: 'idle' | 'lost' | 'failed' = 'failed';
      try {
        await this.connectOnce();
        outcome = await this.session();
      } catch (err) {
        this.reportFailure(err);
      }
      this.setReady(false);
      await this.client.disconnect().catch(() => undefined);
      if (this.stopped) {
        break;
      }

      if (outcome === 'idle') {
        this.log.debug('On-demand: idle, disconnected');
        this.nextPollAt = Date.now() + this.options.onDemandPollIntervalMs;
        continue;
      }
      if (outcome === 'lost') {
        this.log.warn('Lost connection to the kettle; reconnecting');
      }
      const wait = this.keyRejected ? 300_000 : this.backoff.next();
      this.log.debug(`Next connection attempt in ${Math.round(wait / 1000)} s`);
      if (this.keyRejected) {
        // A rejected key won't fix itself: ignore wake-ups from HomeKit taps, but still honour stop().
        const until = Date.now() + wait;
        while (!this.stopped && Date.now() < until) {
          await delay(Math.min(1_000, until - Date.now()));
        }
      } else {
        await this.sleep(wait);
      }
    }
  }

  private async connectOnce(): Promise<void> {
    this.lastAttemptAt = Date.now();
    const started = Date.now();
    this.log.debug('Connecting to the kettle…');
    await this.client.connect();
    try {
      await this.client.hello(this.options.key);
    } catch (err) {
      if (err instanceof InvalidRegistrationKeyError) {
        if (!this.keyRejected) {
          this.log.error('The kettle rejected the registration key. Use the key from the VeSync app (cosori-probe key-from-log), '
            + 'or pair a new one (cosori-probe pair). Retrying every 5 minutes.');
        }
        this.keyRejected = true;
        this.rejectWaiters(new KettleUnavailableError('the kettle rejected the registration key'));
      }
      throw err;
    }
    this.keyRejected = false;
    this.backoff.reset();
    if (this.consecutiveConnectFailures > 0 || !this.everConnected) {
      this.log.info(`Connected to the kettle (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    } else {
      this.log.debug(`Connected (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    }
    this.everConnected = true;
    this.consecutiveConnectFailures = 0;
    this.lastActivityAt = Date.now();
    this.nextPollAt = 0;
    this.setReady(true);
  }

  private async session(): Promise<'idle' | 'lost'> {
    const maxFailures = this.options.failuresBeforeReconnect ?? 3;
    let failures = 0;
    while (!this.stopped && this.client.isAuthenticated) {
      const now = Date.now();
      if (now >= this.nextPollAt) {
        try {
          await this.client.poll();
          failures = 0;
        } catch (err) {
          failures++;
          this.log.debug(`Poll failed (${failures}/${maxFailures}): ${errorMessage(err)}`);
          if (failures >= maxFailures || !this.client.isAuthenticated) {
            return 'lost';
          }
        }
        this.nextPollAt = Date.now() + this.options.pollIntervalMs;
      }

      if (this.options.mode === 'onDemand' && this.pendingCommands === 0 && !this.client.status?.active) {
        const idleFor = Date.now() - this.lastActivityAt;
        if (idleFor >= this.options.idleDisconnectMs) {
          return 'idle';
        }
        await this.sleep(Math.min(this.nextPollAt - Date.now(), this.options.idleDisconnectMs - idleFor));
      } else {
        await this.sleep(this.nextPollAt - Date.now());
      }
    }
    return this.stopped ? 'idle' : 'lost';
  }

  private reportFailure(err: unknown): void {
    this.consecutiveConnectFailures++;
    if (err instanceof InvalidRegistrationKeyError) {
      return; // already logged
    }
    const n = this.consecutiveConnectFailures;
    const message = `Kettle not reachable (${errorMessage(err)}). Is it in range, and is the VeSync app closed? Will keep retrying.`;
    if (n === 1 || n === 5 || n === 20 || n % 50 === 0) {
      this.log.warn(n === 1 ? message : `${message} [${n} attempts]`);
    } else {
      this.log.debug(message);
    }
  }
}
