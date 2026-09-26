/**
 * Keeps a KettleClient connected, authenticated and polled, and runs HomeKit commands against it.
 *
 * - persistent: stay connected; poll every pollIntervalMs; reconnect with exponential backoff.
 * - onDemand:   connect only for commands and for a slow periodic poll; stay connected while heating;
 *               disconnect after idleDisconnectMs so the VeSync app can connect in between.
 *
 * Commands run one at a time, in the order they were issued. A command cut off by a dropped link is
 * sent once more after the reconnect (see run()).
 *
 * Nothing here throws into Homebridge: the loop catches everything and logs it.
 */
import { EventEmitter } from 'node:events';

import { Backoff, type BackoffOptions } from '../util/backoff.js';
import { delay, errorMessage, Mutex } from '../util/async.js';
import { type Logger } from '../util/log.js';
import type { ConnectionMode } from '../config.js';
import { AckTimeoutError, InvalidRegistrationKeyError, NotConnectedError, WriteFailedError } from './errors.js';
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
  /**
   * How long a command cut off by a dropped link waits for the reconnect before it's sent once more
   * (default 30 s). If the kettle isn't back by then, the command fails.
   */
  resendWindowMs?: number;
  /** Consecutive failed polls before the link is considered dead (default 3). */
  failuresBeforeReconnect?: number;
  backoff?: BackoffOptions;
  /** Minimum time between connection attempts, even when commands wake the loop (default 2 s). */
  minAttemptIntervalMs?: number;
  /**
   * Log a warning when the link has been down this long, even between failed attempts that would
   * otherwise only log at debug level (default 1, 5, 15 and 30 min, then every hour).
   */
  downWarningsMs?: number[];
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

const DEFAULT_DOWN_WARNINGS_MS = [60_000, 300_000, 900_000, 1_800_000];

/**
 * Errors that mean the link went away under a command, not that the kettle refused it. The kettle
 * may or may not have acted on it, which is fine: every command is a "set to this state", so sending
 * it again is harmless.
 */
function isLinkFailure(err: unknown): boolean {
  return err instanceof NotConnectedError || err instanceof AckTimeoutError || err instanceof WriteFailedError;
}

/** "4.1 s", "12 min", "2 h 5 min". */
export function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${(Math.floor(Math.max(0, ms) / 100) / 10).toFixed(1)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

export class ConnectionManager extends EventEmitter<Events> {
  private stopped = true;
  /** Set by stop(): commands still queued fail at once instead of waiting for a link. */
  private shuttingDown = false;
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
  /** Set when an established link drops, cleared by the next successful connect. */
  private reconnecting = false;
  private downWarningsGiven = 0;
  /** When the link was last lost (or the manager started without a link); 0 while connected. */
  private downSince = Date.now();
  /** Counts successful connects, so a resend can wait for a new link rather than the one that failed. */
  private connectionId = 0;
  private readonly commands = new Mutex();
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

  /**
   * How long the kettle has been unreachable, in ms (0 while connected). In on-demand mode being
   * disconnected is normal, so this is 0 unless the most recent connection attempt failed.
   */
  unreachableForMs(now = Date.now()): number {
    if (this.ready) {
      return 0;
    }
    if (this.options.mode === 'onDemand' && this.consecutiveConnectFailures === 0) {
      return 0;
    }
    return this.everConnected || this.consecutiveConnectFailures > 0 ? now - this.downSince : 0;
  }

  /** Whether a command is queued or running (so the cached status may be about to change). */
  get busy(): boolean {
    return this.pendingCommands > 0;
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
    this.shuttingDown = false;
    this.loopPromise = this.loop().catch((err) => this.log.error(`Connection loop crashed: ${errorMessage(err)}`));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.shuttingDown = true;
    this.wake();
    this.rejectWaiters(new KettleUnavailableError('plugin is shutting down'));
    await this.loopPromise;
    await this.client.disconnect().catch(() => undefined);
  }

  /**
   * Run a command once the kettle is connected and authenticated. Commands run one at a time, in the
   * order they were issued. Each waits at most commandTimeoutMs (counted from now) for the link; one
   * that reaches the front of the queue with the link up runs even if that time has passed, so a Stop
   * queued behind a slow Heat is never dropped while the Heat goes through.
   *
   * If the link drops under the command (it was never acknowledged), it's sent once more on the next
   * connection, provided that comes within resendWindowMs. The queue keeps a later command (a Stop
   * after a Heat, say) behind the resend, so the kettle still ends up in the last requested state.
   */
  async run<T>(label: string, fn: (client: KettleClient) => Promise<T>): Promise<T> {
    this.pendingCommands++;
    this.lastActivityAt = Date.now();
    this.wake();
    const timeoutMs = this.options.commandTimeoutMs ?? 45_000;
    const deadline = Date.now() + timeoutMs;
    try {
      return await this.commands.run(async () => {
        await this.waitReady(deadline - Date.now(), `${label}: kettle not reachable within ${formatDuration(timeoutMs)}`);
        const attemptOn = this.connectionId;
        let result: T;
        try {
          result = await fn(this.client);
        } catch (err) {
          if (!isLinkFailure(err) || this.shuttingDown) {
            throw err;
          }
          const windowMs = this.options.resendWindowMs ?? 30_000;
          this.log.debug(`${label}: ${errorMessage(err)}; will send again after the reconnect`);
          // Check the link now rather than at the next scheduled poll, so a dead one is noticed sooner.
          this.nextPollAt = 0;
          this.wake();
          const message = `${label}: kettle lost the link and did not reconnect within ${formatDuration(windowMs)}`;
          await this.waitReady(windowMs, message, attemptOn).catch((waitErr: unknown) => {
            // Still on the same link: the kettle just didn't answer, so report that instead.
            throw this.ready && this.connectionId === attemptOn ? err : waitErr;
          });
          this.log.info(`Sending "${label}" again: the link dropped before the kettle confirmed it`);
          result = await fn(this.client);
        }
        this.lastActivityAt = Date.now();
        this.nextPollAt = 0;
        this.wake();
        return result;
      });
    } finally {
      this.pendingCommands--;
    }
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * Resolve once the kettle is connected and authenticated. With `after`, wait for a connection newer
   * than that one (the link a command just failed on may not have been declared dead yet).
   */
  private waitReady(timeoutMs: number, timeoutMessage: string, after?: number): Promise<void> {
    if (this.shuttingDown) {
      return Promise.reject(new KettleUnavailableError('plugin is shutting down'));
    }
    if (this.ready && (after === undefined || this.connectionId > after)) {
      return Promise.resolve();
    }
    if (this.keyRejected) {
      return Promise.reject(new KettleUnavailableError('the kettle rejected the registration key; check "registrationKey" in the config'));
    }
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
        reject(new KettleUnavailableError(timeoutMessage));
      }, Math.max(0, timeoutMs));
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
    this.downSince = ready ? 0 : Date.now();
    if (ready) {
      this.connectionId++;
    }
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
        this.reconnecting = true;
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
    const took = ((Date.now() - started) / 1000).toFixed(1);
    if (this.reconnecting) {
      // A drop followed by a quick reconnect should read as recovered, not as a dead link.
      const attempts = this.consecutiveConnectFailures + 1;
      this.log.info(`Reconnected to the kettle after ${formatDuration(Date.now() - this.downSince)} `
        + `(${attempts} attempt${attempts === 1 ? '' : 's'}, last connect ${took} s)`);
    } else if (this.consecutiveConnectFailures > 0 || !this.everConnected) {
      this.log.info(`Connected to the kettle (${took} s)`);
    } else {
      this.log.debug(`Connected (${took} s)`);
    }
    this.everConnected = true;
    this.reconnecting = false;
    this.downWarningsGiven = 0;
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
    const downFor = Date.now() - this.downSince;
    const since = this.everConnected ? ` for ${formatDuration(downFor)}` : '';
    const message = `Kettle not reachable${since} (${errorMessage(err)}). Is it in range, and is the VeSync app closed? Will keep retrying.`;
    // Warn on the first failure, then by elapsed time, so a long outage never goes quiet.
    let warn = n === 1;
    while (downFor >= this.downWarningThreshold(this.downWarningsGiven)) {
      this.downWarningsGiven++;
      warn = true;
    }
    if (warn) {
      this.log.warn(n === 1 ? message : `${message} [${n} attempts]`);
    } else {
      this.log.debug(message);
    }
  }

  private downWarningThreshold(index: number): number {
    const thresholds = this.options.downWarningsMs ?? DEFAULT_DOWN_WARNINGS_MS;
    if (index < thresholds.length) {
      return thresholds[index]!;
    }
    return (thresholds.at(-1) ?? 0) + (index - thresholds.length + 1) * 3_600_000;
  }
}
