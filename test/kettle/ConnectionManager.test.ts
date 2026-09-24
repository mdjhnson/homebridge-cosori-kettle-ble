import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionManager, KettleUnavailableError, type ConnectionManagerOptions } from '../../src/kettle/ConnectionManager.js';
import { KettleClient } from '../../src/kettle/KettleClient.js';
import { buildFrame, Cmd, fromHex, parseFrame, parseKey } from '../../src/protocol/index.js';
import { silentLogger } from '../../src/util/log.js';
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
