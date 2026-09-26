import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionManager, type ConnectionManagerOptions, formatDuration, KettleUnavailableError } from '../../src/kettle/ConnectionManager.js';
import { KettleClient } from '../../src/kettle/KettleClient.js';
import { buildFrame, Cmd, fromHex, parseFrame, parseKey } from '../../src/protocol/index.js';
import { type Logger, silentLogger } from '../../src/util/log.js';
import { EXTENDED_FRAMES } from '../fixtures/captures.js';
import { FakeTransport, type Responder } from './FakeTransport.js';

const KEY = parseKey('9903e01a3c3baa8f6c71cbb5167e7d5f');
const IDLE = parseFrame(fromHex(EXTENDED_FRAMES[4]!.hex))!.payload; // E5 idle on base
const HEATING = parseFrame(fromHex(EXTENDED_FRAMES[0]!.hex))!.payload; // E1 boiling

function kettle(opts: { poll?: Buffer; helloStatus?: number; silentPolls?: () => boolean } = {}): Responder {
  return (frame, fake) => {
    const cmd = frame.payload[1];
    if (cmd === Cmd.HELLO) {
      fake.ack(frame, [opts.helloStatus ?? 0]);
    } else if (cmd === Cmd.POLL) {
      if (!opts.silentPolls?.()) {
        fake.notify(buildFrame(0x12, frame.seq, opts.poll ?? IDLE));
      }
    } else {
      fake.ack(frame);
    }
  };
}

const managers: ConnectionManager[] = [];

function setup(respond: Responder, overrides: Partial<ConnectionManagerOptions> = {}) {
  const fake = new FakeTransport(respond);
  const client = new KettleClient(fake, { ackTimeoutMs: 50 });
  const manager = new ConnectionManager(client, {
    key: KEY,
    mode: 'persistent',
    pollIntervalMs: 20,
    onDemandPollIntervalMs: 10_000,
    idleDisconnectMs: 60,
    commandTimeoutMs: 500,
    backoff: { initialMs: 10, maxMs: 40, jitter: 0 },
    minAttemptIntervalMs: 0,
    log: silentLogger,
    ...overrides,
  });
  managers.push(manager);
  return { fake, client, manager };
}

const until = async (cond: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error('condition not met in time');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

function captureLog(): Logger & { lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (message: string) => {
    lines.push({ level, message });
  };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
});

describe('ConnectionManager (persistent)', () => {
  it('connects, authenticates and polls', async () => {
    const { fake, manager } = setup(kettle());
    const connections: boolean[] = [];
    manager.on('connection', (c) => connections.push(c));
    manager.start();
    await until(() => fake.sent.filter((f) => f.payload[1] === Cmd.POLL).length >= 3);
    expect(fake.sent[0]!.payload[1]).toBe(Cmd.HELLO);
    expect(connections).toEqual([true]);
    expect(manager.isFresh()).toBe(true);
    expect(manager.status).toMatchObject({ onBase: true, active: false });
  });

  it('runs a command once connected, then refreshes status', async () => {
    const { fake, manager } = setup(kettle());
    manager.start();
    await manager.run('stop', (c) => c.stop());
    expect(fake.sent.some((f) => f.payload[1] === Cmd.STOP)).toBe(true);
  });

  it('queues a command issued before the connection is up', async () => {
    const { fake, manager } = setup(kettle());
    const p = manager.run('stop', (c) => c.stop());
    manager.start();
    await p;
    expect(fake.sent.findIndex((f) => f.payload[1] === Cmd.STOP)).toBeGreaterThan(0);
  });

  it('reconnects after the link drops', async () => {
    const { fake, manager } = setup(kettle());
    const connections: boolean[] = [];
    manager.on('connection', (c) => connections.push(c));
    manager.start();
    await until(() => manager.connected);
    fake.drop();
    await until(() => connections.length >= 3);
    expect(connections).toEqual([true, false, true]);
    expect(fake.connectCount).toBe(2);
  });

  it('retries failed connects with backoff', async () => {
    const { fake, manager } = setup(kettle());
    fake.connectError = new Error('le-connection-abort-by-local');
    manager.start();
    await until(() => fake.connectCount >= 3);
    expect(manager.connected).toBe(false);
    fake.connectError = undefined;
    await until(() => manager.connected);
  });

  it('treats 3 consecutive failed polls as a dead link and reconnects', async () => {
    let silent = false;
    const { fake, manager } = setup(kettle({ silentPolls: () => silent }));
    manager.start();
    await until(() => manager.connected);
    silent = true;
    await until(() => !manager.connected, 2000);
    silent = false;
    await until(() => manager.connected && fake.connectCount === 2, 2000);
  });

  it('fails commands fast and stops hammering when the key is rejected', async () => {
    const { fake, manager } = setup(kettle({ helloStatus: 0x01 }));
    manager.start();
    await until(() => manager.registrationKeyRejected);
    await expect(manager.run('boil', (c) => c.stop())).rejects.toBeInstanceOf(KettleUnavailableError);
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.connectCount).toBe(1);
  });

  it('times out a command when the kettle stays unreachable', async () => {
    const { fake, manager } = setup(kettle(), { commandTimeoutMs: 80 });
    fake.connectError = new Error('not found');
    manager.start();
    await expect(manager.run('boil', (c) => c.stop())).rejects.toThrow(/not reachable/);
  });

  it('stop() disconnects and ends the loop', async () => {
    const { fake, manager } = setup(kettle());
    manager.start();
    await until(() => manager.connected);
    await manager.stop();
    expect(fake.connected).toBe(false);
    const count = fake.connectCount;
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.connectCount).toBe(count);
  });

  it('reports stale status after the link has been down for a while', async () => {
    const { fake, manager } = setup(kettle());
    manager.start();
    await until(() => manager.connected);
    const s = manager.status!;
    fake.connectError = new Error('gone');
    fake.drop();
    await until(() => !manager.connected);
    expect(manager.isFresh(s.updatedAt + 60_000)).toBe(true);
    expect(manager.isFresh(s.updatedAt + 120_000)).toBe(false);
  });
});

describe('ConnectionManager commands across a dropped link', () => {
  const commandsSent = (fake: FakeTransport, cmd: number) => fake.sent.filter((f) => f.payload[1] === cmd).length;

  /** A kettle that drops the link instead of answering the first `n` STOPs. */
  function dropsOnStop(n: number): Responder {
    let left = n;
    const base = kettle();
    return (frame, fake) => {
      if (frame.payload[1] === Cmd.STOP && left > 0) {
        left--;
        fake.drop();
        return;
      }
      base(frame, fake);
    };
  }

  it('sends a command again after the reconnect when the link dropped under it', async () => {
    const log = captureLog();
    const { fake, manager } = setup(dropsOnStop(1), { log });
    manager.start();
    await until(() => manager.connected);
    await manager.run('stop', (c) => c.stop());
    expect(commandsSent(fake, Cmd.STOP)).toBe(2);
    expect(fake.connectCount).toBe(2);
    expect(log.lines).toContainEqual({ level: 'info', message: 'Sending "stop" again: the link dropped before the kettle confirmed it' });
  });

  it('waits for a new link when the kettle went silent before the drop was noticed', async () => {
    // Both sends time out (KettleClient retries once) while the link still looks up; BlueZ ends it later.
    let ignoreStops = true;
    const base = kettle();
    const { fake, manager } = setup((frame, f) => {
      if (frame.payload[1] === Cmd.STOP && ignoreStops) {
        return;
      }
      base(frame, f);
    });
    manager.start();
    await until(() => manager.connected);
    const p = manager.run('stop', (c) => c.stop());
    await until(() => commandsSent(fake, Cmd.STOP) === 2);
    await new Promise((r) => setTimeout(r, 80)); // second ACK timeout (50 ms) has passed
    expect(commandsSent(fake, Cmd.STOP)).toBe(2); // no third send on the same link
    ignoreStops = false;
    fake.drop();
    await p;
    expect(commandsSent(fake, Cmd.STOP)).toBe(3);
    expect(fake.connectCount).toBe(2);
  });

  it('treats a failed write as a dying link: sent again once BlueZ ends it and the kettle is back', async () => {
    const log = captureLog();
    const { fake, manager } = setup(kettle(), { log });
    manager.start();
    await until(() => manager.connected);
    fake.nextWriteError = new Error('GATT write timed out after 5000 ms');
    const p = manager.run('stop', (c) => c.stop());
    await until(() => log.lines.some((l) => /write to the kettle failed: GATT write timed out/.test(l.message)));
    fake.drop();
    await p;
    expect(commandsSent(fake, Cmd.STOP)).toBe(1); // the failed write never reached the kettle
    expect(fake.connectCount).toBe(2);
  });

  it('fails queued commands at once when the plugin stops', async () => {
    const { fake, manager } = setup(kettle(), { commandTimeoutMs: 5_000 });
    fake.connectError = new Error('not found');
    manager.start();
    const results = Promise.allSettled([manager.run('a', (c) => c.stop()), manager.run('b', (c) => c.stop())]);
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await manager.stop();
    const settled = await results;
    expect(Date.now() - started).toBeLessThan(200);
    expect(settled.map((r) => (r.status === 'rejected' ? (r.reason as Error).message : 'ok'))).toEqual(['plugin is shutting down', 'plugin is shutting down']);
  });

  it('reports the missing ACK when the link never dropped', async () => {
    const base = kettle();
    const { fake, manager } = setup((frame, f) => {
      if (frame.payload[1] !== Cmd.STOP) {
        base(frame, f);
      }
    }, { resendWindowMs: 100 });
    manager.start();
    await until(() => manager.connected);
    await expect(manager.run('stop', (c) => c.stop())).rejects.toThrow(/no response from kettle/);
    expect(commandsSent(fake, Cmd.STOP)).toBe(2);
  });

  it('sends it only once more', async () => {
    const { fake, manager } = setup(dropsOnStop(2));
    manager.start();
    await until(() => manager.connected);
    await expect(manager.run('stop', (c) => c.stop())).rejects.toThrow(/not connected/);
    expect(commandsSent(fake, Cmd.STOP)).toBe(2);
  });

  it('gives up when the kettle does not reconnect within the resend window', async () => {
    const { fake, manager } = setup((frame, f) => {
      if (frame.payload[1] === Cmd.STOP) {
        f.connectError = new Error('not found');
        f.drop();
        return;
      }
      kettle()(frame, f);
    }, { resendWindowMs: 100 });
    manager.start();
    await until(() => manager.connected);
    await expect(manager.run('stop', (c) => c.stop())).rejects.toThrow(/^stop: kettle lost the link and did not reconnect/);
    expect(commandsSent(fake, Cmd.STOP)).toBe(1);
  });

  it('does not resend a command the kettle refused', async () => {
    const base = kettle();
    const { fake, manager } = setup((frame, f) => {
      if (frame.payload[1] === Cmd.STOP) {
        f.ack(frame, [0x01]);
        return;
      }
      base(frame, f);
    });
    manager.start();
    await until(() => manager.connected);
    await expect(manager.run('stop', (c) => c.stop())).rejects.toThrow(/rejected command/);
    expect(commandsSent(fake, Cmd.STOP)).toBe(1);
  });

  it('keeps the issue order: a later command waits behind the resend', async () => {
    let dropped = false;
    const base = kettle();
    const { fake, manager } = setup((frame, f) => {
      if (frame.payload[1] === Cmd.SET_MODE && !dropped) {
        dropped = true;
        f.drop();
        return;
      }
      base(frame, f);
    });
    manager.start();
    await until(() => manager.connected);
    // A custom temperature is two writes (F3, then F0); the Stop must not land between them.
    const heat = manager.run('heat to 188°F', (c) => c.heatTo(188));
    const stop = manager.run('stop', (c) => c.stop());
    await Promise.all([heat, stop]);
    const order = fake.sent.map((f) => f.payload[1]).filter((c) => c === Cmd.SET_MY_TEMP || c === Cmd.SET_MODE || c === Cmd.STOP);
    expect(order).toEqual([Cmd.SET_MY_TEMP, Cmd.SET_MODE, Cmd.SET_MY_TEMP, Cmd.SET_MODE, Cmd.STOP]);
  });

  it('gives a queued command its own timeout, counted from when it was issued', async () => {
    const { fake, manager } = setup(kettle(), { commandTimeoutMs: 100 });
    fake.connectError = new Error('not found');
    manager.start();
    const started = Date.now();
    const results = await Promise.allSettled([manager.run('a', (c) => c.stop()), manager.run('b', (c) => c.stop())]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(Date.now() - started).toBeLessThan(180);
  });
});

describe('ConnectionManager (onDemand)', () => {
  it('does not connect until the first poll is due or a command arrives', async () => {
    const { fake, manager } = setup(kettle(), { mode: 'onDemand' });
    // first poll is due immediately at start (nextPollAt = 0)
    manager.start();
    await until(() => fake.connectCount === 1);
    await until(() => !fake.connected, 1000); // idle disconnect
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.connectCount).toBe(1); // next poll is 10 s away
    await manager.run('stop', (c) => c.stop());
    expect(fake.connectCount).toBe(2);
    await until(() => !fake.connected, 1000);
  });

  it('stays connected while the kettle is heating', async () => {
    const { fake, manager } = setup(kettle({ poll: HEATING }), { mode: 'onDemand' });
    manager.start();
    await until(() => manager.status?.active === true);
    await new Promise((r) => setTimeout(r, 200)); // > idleDisconnectMs
    expect(fake.connected).toBe(true);
    expect(fake.connectCount).toBe(1);
  });

  it('keeps serving cached status while disconnected', async () => {
    const { fake, manager } = setup(kettle(), { mode: 'onDemand' });
    manager.start();
    await until(() => fake.connectCount === 1 && !fake.connected, 1000);
    expect(manager.isFresh(Date.now() + 3_600_000)).toBe(true);
  });
});

describe('ConnectionManager logging', () => {
  const visible = (log: ReturnType<typeof captureLog>) => log.lines.filter((l) => l.level !== 'debug');

  it('logs the first connect as "Connected", not as a reconnect', async () => {
    const log = captureLog();
    const { manager } = setup(kettle(), { log });
    manager.start();
    await until(() => manager.connected);
    expect(visible(log)).toEqual([{ level: 'info', message: expect.stringMatching(/^Connected to the kettle \(\d+\.\d s\)$/) }]);
  });

  it('logs a drop and the quick recovery at info level, so it reads as recovered', async () => {
    const log = captureLog();
    const { fake, manager } = setup(kettle(), { log });
    manager.start();
    await until(() => manager.connected);
    log.lines.length = 0;
    fake.drop();
    await until(() => fake.connectCount === 2 && manager.connected);
    expect(visible(log)).toEqual([
      { level: 'warn', message: 'Lost connection to the kettle; reconnecting' },
      { level: 'info', message: expect.stringMatching(/^Reconnected to the kettle after \d+\.\d s \(1 attempt, last connect \d+\.\d s\)$/) },
    ]);
  });

  it('warns with the elapsed time while the link stays down, then reports the attempts on recovery', async () => {
    const log = captureLog();
    const { fake, manager } = setup(kettle(), { log, downWarningsMs: [40, 80] });
    manager.start();
    await until(() => manager.connected);
    log.lines.length = 0;
    fake.connectError = new Error('not found while scanning');
    fake.drop();
    await until(() => log.lines.filter((l) => l.level === 'warn').length >= 4, 2000);
    const warnings = log.lines.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(warnings[0]).toBe('Lost connection to the kettle; reconnecting');
    expect(warnings[1]).toMatch(/^Kettle not reachable for \d+\.\d s \(not found while scanning\)/);
    expect(warnings.slice(2).every((w) => /not reachable for .* \[\d+ attempts\]$/.test(w))).toBe(true);
    // Failures between the thresholds stay at debug level.
    expect(log.lines.some((l) => l.level === 'debug' && /not reachable/.test(l.message))).toBe(true);
    fake.connectError = undefined;
    await until(() => manager.connected, 2000);
    expect(log.lines.at(-1)).toEqual({ level: 'info', message: expect.stringMatching(/^Reconnected to the kettle after .* \(\d+ attempts, /) });
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(4_140)).toBe('4.1 s');
    expect(formatDuration(59_999)).toBe('59.9 s');
    expect(formatDuration(60_000)).toBe('1 min');
    expect(formatDuration(12 * 60_000 + 30_000)).toBe('12 min');
    expect(formatDuration(3_600_000)).toBe('1 h');
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min');
  });
});
