import { describe, expect, it, vi } from 'vitest';

import {
  AckTimeoutError, CommandRejectedError, InvalidRegistrationKeyError, NotConnectedError, NotInPairingModeError,
} from '../../src/kettle/errors.js';
import { KettleClient } from '../../src/kettle/KettleClient.js';
import {
  buildFrame, Cmd, effectiveSetpointF, fromHex, Mode, parseFrame, parseKey, presetForTemp, ProtocolVersion,
} from '../../src/protocol/index.js';
import { COMPACT_FRAMES, COMPLETION_FRAMES, EXTENDED_FRAMES, OWN_KETTLE_FRAMES } from '../fixtures/captures.js';
import { FakeTransport, type Responder } from './FakeTransport.js';

const KEY = parseKey('9903e01a3c3baa8f6c71cbb5167e7d5f');
const extendedPayload = (i: number) => parseFrame(fromHex(EXTENDED_FRAMES[i]!.hex))!.payload;

/** A well-behaved kettle: ACKs everything with status 00 and answers polls with E2 (holding). */
const happyKettle: Responder = (frame, fake) => {
  const cmd = frame.payload[1];
  if (cmd === Cmd.POLL) {
    fake.extended(frame, extendedPayload(1));
  } else if (cmd === Cmd.SET_MY_TEMP) {
    fake.ack(frame); // captured F3 ACK has no status byte
  } else {
    fake.ack(frame, [0x00]);
  }
};

async function connected(respond: Responder = happyKettle, opts = {}) {
  const fake = new FakeTransport(respond);
  const client = new KettleClient(fake, { ackTimeoutMs: 200, ...opts });
  await client.connect();
  return { fake, client };
}

describe('KettleClient', () => {
  it('detects protocol version from device info', async () => {
    const fake = new FakeTransport(happyKettle);
    fake.deviceInfo = { hardwareRevision: '0.9.00', softwareRevision: 'R0006V0003' };
    const client = new KettleClient(fake);
    await client.connect();
    expect(client.protocolVersion).toBe(ProtocolVersion.V0);
    await client.poll();
    expect(fake.sent[0]!.payload[0]).toBe(0x00);
  });

  it('honours a forced protocol version', async () => {
    const fake = new FakeTransport(happyKettle);
    fake.deviceInfo = {};
    const client = new KettleClient(fake, { protocolVersion: ProtocolVersion.V0 });
    await client.connect();
    expect(client.protocolVersion).toBe(ProtocolVersion.V0);
  });

  it('hello sends a 42-byte frame as 20 + 20 + 2 chunks and authenticates', async () => {
    const { fake, client } = await connected();
    await client.hello(KEY);
    expect(fake.writes.map((w) => w.length)).toEqual([20, 20, 2]);
    expect(fake.sent[0]!.payload.subarray(0, 4)).toEqual(Buffer.from([0x01, 0x81, 0xd1, 0x00]));
    expect(fake.sent[0]!.payload.subarray(4).toString('ascii')).toBe('9903e01a3c3baa8f6c71cbb5167e7d5f');
    expect(client.isAuthenticated).toBe(true);
  });

  it('maps hello status 01 to InvalidRegistrationKeyError', async () => {
    const { client } = await connected((f, fake) => fake.ack(f, [0x01]));
    await expect(client.hello(KEY)).rejects.toBeInstanceOf(InvalidRegistrationKeyError);
    expect(client.isAuthenticated).toBe(false);
  });

  it('maps register status 01 to NotInPairingModeError', async () => {
    const { client } = await connected((f, fake) => fake.ack(f, [0x01]));
    await expect(client.register(KEY)).rejects.toBeInstanceOf(NotInPairingModeError);
  });

  it('pairing sends register before hello', async () => {
    const { fake, client } = await connected();
    await client.register(KEY);
    await client.hello(KEY);
    expect(fake.sent.map((f) => f.payload[1])).toEqual([Cmd.REGISTER, Cmd.HELLO]);
  });

  it('increments and wraps the TX sequence number', async () => {
    const { fake, client } = await connected();
    for (let i = 0; i < 258; i++) {
      await client.stop();
    }
    expect(fake.sent.slice(0, 2).map((f) => f.seq)).toEqual([0, 1]);
    expect(fake.sent[255]!.seq).toBe(255);
    expect(fake.sent[256]!.seq).toBe(0);
  });

  it('poll returns decoded extended status and emits status', async () => {
    const { client } = await connected();
    const onStatus = vi.fn();
    client.on('status', onStatus);
    const s = await client.poll();
    expect(s).toMatchObject({
      stage: 3, mode: 1, setpointF: 180, tempF: 181, myTempF: 175, configuredHoldSeconds: 300, remainingHoldSeconds: 159, onBase: true, active: true,
    });
    expect(onStatus).toHaveBeenCalledOnce();
  });

  it('reassembles a poll reply split across notifications', async () => {
    const { client } = await connected((f, fake) => {
      fake.notify(buildFrame(0x12, f.seq, extendedPayload(3)), [5, 20]);
    });
    const s = await client.poll();
    expect(s.onBase).toBe(false);
  });

  it('ignores an ACK whose command does not match the pending request', async () => {
    const { client } = await connected((f, fake) => {
      const wrong = Buffer.from(f.payload.subarray(0, 4));
      wrong[1] = Cmd.SET_HOLD;
      fake.ack({ ...f, payload: wrong }, [0x00]);
    });
    await expect(client.stop()).rejects.toBeInstanceOf(AckTimeoutError);
  });

  it('retries once on ACK timeout, then fails', async () => {
    const { fake, client } = await connected(() => undefined);
    await expect(client.poll()).rejects.toBeInstanceOf(AckTimeoutError);
    expect(fake.sent).toHaveLength(2);
  });

  it('succeeds when the retry is answered', async () => {
    let n = 0;
    const { client } = await connected((f, fake) => {
      if (n++ > 0) {
        happyKettle(f, fake);
      }
    });
    await expect(client.poll()).resolves.toMatchObject({ stage: 3 });
  });

  it('does not retry hello/register', async () => {
    const { fake, client } = await connected(() => undefined);
    await expect(client.hello(KEY)).rejects.toBeInstanceOf(AckTimeoutError);
    expect(fake.sent).toHaveLength(1);
  });

  it('throws CommandRejectedError on non-zero control status', async () => {
    const { client } = await connected((f, fake) => fake.ack(f, [0x02]));
    await expect(client.setHold(600)).rejects.toBeInstanceOf(CommandRejectedError);
  });

  it('accepts ACKs without a status byte (F3)', async () => {
    const { client } = await connected();
    await expect(client.setMyTemp(179)).resolves.toBeUndefined();
  });

  it('serialises concurrent commands', async () => {
    const { fake, client } = await connected();
    await Promise.all([client.poll(), client.stop(), client.setHold(300), client.poll()]);
    expect(fake.sent.map((f) => f.payload[1])).toEqual([Cmd.POLL, Cmd.STOP, Cmd.SET_HOLD, Cmd.POLL]);
  });

  it('heatTo uses a preset for preset temperatures', async () => {
    const { fake, client } = await connected();
    expect(await client.heatTo(205)).toBe(Mode.COFFEE);
    expect(fake.sent.map((f) => f.payload[1])).toEqual([Cmd.SET_MODE]);
    expect(fake.sent[0]!.payload[4]).toBe(Mode.COFFEE);
  });

  it('heatTo sets MyBrew temperature then starts MyBrew for other temperatures', async () => {
    const { fake, client } = await connected();
    expect(await client.heatTo(170, 600)).toBe(Mode.MY_BREW);
    expect(fake.sent.map((f) => f.payload[1])).toEqual([Cmd.SET_MY_TEMP, Cmd.SET_MODE]);
    expect([...fake.sent[1]!.payload]).toEqual([0x01, 0xf0, 0xa3, 0x00, 0x05, 170, 0x01, 0x58, 0x02]);
  });

  it('merges unsolicited compact status and flags changes', async () => {
    const { fake, client } = await connected();
    await client.poll();
    const onCompact = vi.fn();
    client.on('compact', onCompact);
    fake.notify(COMPACT_FRAMES[5]!.hex); // stage 1, boil, 212, 123
    expect(onCompact).toHaveBeenCalledWith(expect.objectContaining({ stage: 1, mode: 4, setpointF: 212, tempF: 123, onBase: true }), true);
    fake.notify(COMPACT_FRAMES[5]!.hex);
    expect(onCompact).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it('delayedStart sends F1 and a pushed stage-5 status reads as scheduled, not active', async () => {
    const { fake, client } = await connected();
    await client.poll();
    await client.delayedStart(1500, Mode.GREEN_TEA, { holdSeconds: 1800 });
    expect([...fake.sent[1]!.payload]).toEqual([0x01, 0xf1, 0xa3, 0x00, 0xdc, 0x05, 0x01, 0x00, 0x01, 0x08, 0x07]);
    fake.notify(OWN_KETTLE_FRAMES.compactDelayScheduled);
    expect(client.status).toMatchObject({ stage: 5, scheduled: true, active: false });
  });

  it('emits completion notifications', async () => {
    const { fake, client } = await connected();
    const onCompletion = vi.fn();
    client.on('completion', onCompletion);
    fake.notify(COMPLETION_FRAMES[0]!.hex);
    expect(onCompletion).toHaveBeenCalledWith(0x20);
  });

  it('rejects in-flight commands when the link drops', async () => {
    const { fake, client } = await connected(() => undefined);
    const onDisconnect = vi.fn();
    client.on('disconnect', onDisconnect);
    const p = client.poll();
    await Promise.resolve();
    await Promise.resolve();
    fake.drop();
    await expect(p).rejects.toBeInstanceOf(NotConnectedError);
    expect(onDisconnect).toHaveBeenCalledOnce();
    await expect(client.stop()).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('survives random notification bytes', async () => {
    const { fake, client } = await connected();
    fake.notify(Buffer.from([0xa5, 0xa5, 0xff, 0x00, 0x13]));
    fake.notify(Buffer.from([0x01, 0x02, 0x03]));
    await expect(client.poll()).resolves.toMatchObject({ stage: 3 });
  });
});

describe('presetForTemp', () => {
  it.each([
    [212, Mode.BOIL], [211.6, Mode.BOIL], [205, Mode.COFFEE], [204.8, Mode.COFFEE], [196, Mode.OOLONG], [180, Mode.GREEN_TEA],
    [179.6, Mode.GREEN_TEA], [170, undefined], [200, undefined], [104, undefined],
  ])('%s °F → %s', (t, mode) => {
    expect(presetForTemp(t)).toBe(mode);
  });

  it('effectiveSetpointF snaps preset-adjacent targets to the preset and keeps others', () => {
    expect([181, 179, 196, 211, 200, 201, 104].map(effectiveSetpointF)).toEqual([180, 180, 195, 212, 200, 201, 104]);
  });
});
