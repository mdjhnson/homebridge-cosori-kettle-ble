import { afterEach, describe, expect, it } from 'vitest';

import { KettleAccessory } from '../../src/accessory/KettleAccessory.js';
import { parseConfig, type KettlePluginConfig } from '../../src/config.js';
import { ConnectionManager } from '../../src/kettle/ConnectionManager.js';
import { KettleClient } from '../../src/kettle/KettleClient.js';
import { buildFrame, Cmd, type Frame, fromHex, Mode, parseFrame, parseKey } from '../../src/protocol/index.js';
import { silentLogger } from '../../src/util/log.js';
import { EXTENDED_FRAMES, OWN_KETTLE_FRAMES } from '../fixtures/captures.js';
import { FakeTransport } from '../kettle/FakeTransport.js';
import { fakeApi, hap, newAccessory } from './harness.js';

const { Service: S, Characteristic: C } = hap;
const KEY = '9903e01a3c3baa8f6c71cbb5167e7d5f';
const payload = (hex: string) => parseFrame(fromHex(hex))!.payload;
const IDLE = payload(OWN_KETTLE_FRAMES.extendedBackOnBase); // idle, on base, 117 °F, setpoint 180, mybrew 140
const OFF_BASE = payload(OWN_KETTLE_FRAMES.extendedOffBase);
const HEATING = payload(EXTENDED_FRAMES[0]!.hex); // boiling

function config(overrides: Record<string, unknown> = {}): KettlePluginConfig {
  const parsed = parseConfig({ platform: 'CosoriKettleBLE', mac: 'FC:58:FA:0F:C3:26', registrationKey: KEY, ...overrides });
  if (!parsed.config) {
    throw new Error(parsed.errors.join('; '));
  }
  return parsed.config;
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

const managers: ConnectionManager[] = [];

async function setup(opts: { status?: Buffer; overrides?: Record<string, unknown>; start?: boolean } = {}) {
  let status = opts.status ?? IDLE;
  const fake = new FakeTransport((frame, f) => {
    if (frame.payload[1] === Cmd.POLL) {
      f.notify(buildFrame(0x12, frame.seq, status));
    } else {
      f.ack(frame, frame.payload[1] === Cmd.HELLO ? [0] : []);
    }
  });
  const client = new KettleClient(fake, { ackTimeoutMs: 50 });
  const cfg = config(opts.overrides);
  const manager = new ConnectionManager(client, {
    key: parseKey(KEY), mode: 'persistent', pollIntervalMs: 20, onDemandPollIntervalMs: 60_000, idleDisconnectMs: 50,
    backoff: { initialMs: 10, maxMs: 20, jitter: 0 }, minAttemptIntervalMs: 0, commandTimeoutMs: 300, log: silentLogger,
  });
  managers.push(manager);
  const accessory = newAccessory();
  new KettleAccessory(fakeApi(), silentLogger, cfg, accessory, manager);
  if (opts.start !== false) {
    manager.start();
    await until(() => manager.status !== undefined);
  }
  const thermostat = () => accessory.getService(S.Thermostat)!;
  const sub = (type: typeof S.Switch | typeof S.OccupancySensor, subtype: string) => accessory.getServiceById(type, subtype);
  const sentCmds = () => fake.sent.map((f: Frame) => f.payload[1]).filter((c) => c !== Cmd.POLL && c !== Cmd.HELLO);
  const lastSent = (cmd: number) => [...fake.sent].reverse().find((f) => f.payload[1] === cmd);
  const setStatus = (s: Buffer) => {
    status = s;
  };
  return { fake, manager, accessory, thermostat, sub, sentCmds, lastSent, setStatus };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
});

describe('KettleAccessory services', () => {
  it('creates the default services', async () => {
    const { accessory } = await setup();
    expect(accessory.getService(S.Thermostat)).toBeDefined();
    expect(accessory.getServiceById(S.OccupancySensor, 'on-base')).toBeDefined();
    expect(accessory.getServiceById(S.Switch, 'keep-warm')).toBeDefined();
    expect(accessory.getServiceById(S.Switch, 'preset-boil')).toBeDefined();
    expect(accessory.getServiceById(S.Switch, 'preset-greenTea')).toBeUndefined();
    expect(accessory.getServiceById(S.Switch, 'delay-start')).toBeUndefined();
    expect((accessory as unknown as { services: unknown[] }).services).toHaveLength(5); // info, thermostat, on-base, boil, keep-warm
    expect(accessory.getService(S.AccessoryInformation)!.getCharacteristic(C.SerialNumber).value).toBe('FC:58:FA:0F:C3:26');
  });

  it('honours accessory toggles', async () => {
    const { accessory } = await setup({
      overrides: { accessories: { onBaseSensor: false, keepWarmSwitch: false, delayStartSwitch: true, presets: { boil: false, coffee: true } } },
    });
    expect(accessory.getServiceById(S.OccupancySensor, 'on-base')).toBeUndefined();
    expect(accessory.getServiceById(S.Switch, 'keep-warm')).toBeUndefined();
    expect(accessory.getServiceById(S.Switch, 'preset-boil')).toBeUndefined();
    expect(accessory.getServiceById(S.Switch, 'preset-coffee')).toBeDefined();
    expect(accessory.getServiceById(S.Switch, 'delay-start')).toBeDefined();
  });

  it('uses HAP-valid service names and raises no characteristic warnings', async () => {
    const warnings: unknown[] = [];
    const accessory = newAccessory();
    (accessory as unknown as { hapAccessory: { on: (e: string, cb: (w: unknown) => void) => void } })
      .hapAccessory.on('characteristic-warning', (w) => warnings.push(w));
    const fake = new FakeTransport();
    const manager = new ConnectionManager(new KettleClient(fake), {
      key: parseKey(KEY), mode: 'persistent', pollIntervalMs: 1000, onDemandPollIntervalMs: 1000, idleDisconnectMs: 1000, log: silentLogger,
    });
    new KettleAccessory(fakeApi(), silentLogger, config({ accessories: { delayStartSwitch: true, presets: { greenTea: true, oolong: true, coffee: true,
      myBrew: true } } }), accessory, manager);
    const names = (accessory as unknown as { services: Array<{ displayName: string }> }).services.map((s) => s.displayName).filter(Boolean);
    expect(names).toEqual(['Kettle', 'On Base', 'Green Tea', 'Oolong', 'Coffee', 'Boil', 'MyBrew', 'Keep Warm', 'Delay Start']);
    for (const name of names) {
      expect(name).toMatch(/^[\p{L}\p{N}][\p{L}\p{N} ',.-]*[\p{L}\p{N}]$/u);
    }
    expect(warnings).toEqual([]);
  });

  it('restores names the Home app overwrote with defaults, but keeps names the user chose', async () => {
    const accessory = newAccessory();
    const first = new ConnectionManager(new KettleClient(new FakeTransport()), {
      key: parseKey(KEY), mode: 'persistent', pollIntervalMs: 1000, onDemandPollIntervalMs: 1000, idleDisconnectMs: 1000, log: silentLogger,
    });
    const cfg = config({ accessories: { presets: { coffee: true } } });
    new KettleAccessory(fakeApi(), silentLogger, cfg, accessory, first);
    // Simulate the Home app renaming during pairing, and the user renaming one tile.
    accessory.getServiceById(S.Switch, 'preset-boil')!.updateCharacteristic(C.ConfiguredName, 'Switch');
    accessory.getServiceById(S.Switch, 'keep-warm')!.updateCharacteristic(C.ConfiguredName, 'Switch 2');
    accessory.getServiceById(S.Switch, 'preset-coffee')!.updateCharacteristic(C.ConfiguredName, 'Morning Coffee');
    accessory.getServiceById(S.OccupancySensor, 'on-base')!.updateCharacteristic(C.ConfiguredName, 'Occupancy Sensor');
    // Restart: a new accessory handler on the same (cached) accessory.
    new KettleAccessory(fakeApi(), silentLogger, cfg, accessory, first);
    const name = (svc: { getCharacteristic: (c: typeof C.ConfiguredName) => { value: unknown } } | undefined) =>
      svc!.getCharacteristic(C.ConfiguredName).value;
    expect(name(accessory.getServiceById(S.Switch, 'preset-boil'))).toBe('Boil');
    expect(name(accessory.getServiceById(S.Switch, 'keep-warm'))).toBe('Keep Warm');
    expect(name(accessory.getServiceById(S.Switch, 'preset-coffee'))).toBe('Morning Coffee');
    expect(name(accessory.getServiceById(S.OccupancySensor, 'on-base'))).toBe('On Base');
    expect(name(accessory.getService(S.Thermostat))).toBe('Kettle');
  });

  it('thermostat range is 40–100 °C with 0.5 °C steps and OFF/HEAT only', async () => {
    const { thermostat } = await setup();
    const props = thermostat().getCharacteristic(C.TargetTemperature).props;
    expect([props.minValue, props.maxValue, props.minStep]).toEqual([40, 100, 0.5]);
    expect(thermostat().getCharacteristic(C.TargetHeatingCoolingState).props.validValues).toEqual([0, 1]);
  });
});

describe('KettleAccessory reads', () => {
  it('reports kettle state', async () => {
    const { thermostat, sub } = await setup();
    expect(await thermostat().getCharacteristic(C.CurrentTemperature).handleGetRequest()).toBe(47.2); // 117 °F
    expect(await thermostat().getCharacteristic(C.TargetTemperature).handleGetRequest()).toBe(82); // 180 °F
    expect(await thermostat().getCharacteristic(C.CurrentHeatingCoolingState).handleGetRequest()).toBe(C.CurrentHeatingCoolingState.OFF);
    expect(await thermostat().getCharacteristic(C.TemperatureDisplayUnits).handleGetRequest()).toBe(C.TemperatureDisplayUnits.FAHRENHEIT);
    expect(await sub(S.OccupancySensor, 'on-base')!.getCharacteristic(C.OccupancyDetected).handleGetRequest())
      .toBe(C.OccupancyDetected.OCCUPANCY_DETECTED);
  });

  it('reports heating', async () => {
    const { thermostat, sub } = await setup({ status: HEATING });
    expect(await thermostat().getCharacteristic(C.CurrentHeatingCoolingState).handleGetRequest()).toBe(C.CurrentHeatingCoolingState.HEAT);
    expect(await sub(S.Switch, 'preset-boil')!.getCharacteristic(C.On).handleGetRequest()).toBe(true);
  });

  it('answers No Response before any status arrives', async () => {
    const { thermostat } = await setup({ start: false });
    await expect(thermostat().getCharacteristic(C.CurrentTemperature).handleGetRequest())
      .rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it('updates the on-base sensor when the kettle is lifted', async () => {
    const { sub, setStatus } = await setup();
    const occ = sub(S.OccupancySensor, 'on-base')!.getCharacteristic(C.OccupancyDetected);
    setStatus(OFF_BASE);
    await until(() => occ.value === C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });
});

describe('KettleAccessory commands', () => {
  it('target 100 °C + HEAT → boil preset with keep-warm hold', async () => {
    const { thermostat, lastSent } = await setup();
    await thermostat().getCharacteristic(C.TargetTemperature).handleSetRequest(100);
    await thermostat().getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(C.TargetHeatingCoolingState.HEAT);
    await until(() => lastSent(Cmd.SET_MODE) !== undefined);
    expect([...lastSent(Cmd.SET_MODE)!.payload]).toEqual([0x01, 0xf0, 0xa3, 0x00, Mode.BOIL, 0x00, 0x01, 0x08, 0x07]);
  });

  it('non-preset target → set MyBrew temp, then start MyBrew', async () => {
    const { thermostat, sentCmds, lastSent } = await setup();
    await thermostat().getCharacteristic(C.TargetTemperature).handleSetRequest(75); // 167 °F
    await thermostat().getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(C.TargetHeatingCoolingState.HEAT);
    await until(() => lastSent(Cmd.SET_MODE) !== undefined);
    expect(sentCmds()).toEqual([Cmd.SET_MY_TEMP, Cmd.SET_MODE]);
    expect(lastSent(Cmd.SET_MY_TEMP)!.payload[4]).toBe(167);
  });

  it('changing the target while idle does not talk to the kettle', async () => {
    const { thermostat, sentCmds } = await setup();
    await thermostat().getCharacteristic(C.TargetTemperature).handleSetRequest(90);
    await new Promise((r) => setTimeout(r, 50));
    expect(sentCmds()).toEqual([]);
  });

  it('OFF while heating → stop', async () => {
    const { thermostat, lastSent } = await setup({ status: HEATING });
    await thermostat().getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(C.TargetHeatingCoolingState.OFF);
    await until(() => lastSent(Cmd.STOP) !== undefined);
  });

  it('OFF while idle sends nothing', async () => {
    const { thermostat, sentCmds } = await setup();
    await thermostat().getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(C.TargetHeatingCoolingState.OFF);
    await new Promise((r) => setTimeout(r, 50));
    expect(sentCmds()).toEqual([]);
  });

  it('refuses commands immediately when the kettle has been unreachable for a while', async () => {
    const { fake, manager, thermostat, sentCmds } = await setup();
    fake.connectError = new Error('not found while scanning');
    fake.drop();
    await until(() => !manager.connected);
    expect(manager.unreachableForMs()).toBeLessThan(15_000);
    expect(manager.unreachableForMs(Date.now() + 20_000)).toBeGreaterThan(15_000);
    // Within the grace period a tap is queued; past it, it is refused up front.
    const realNow = Date.now;
    Date.now = () => realNow() + 20_000;
    try {
      await expect(thermostat().getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(C.TargetHeatingCoolingState.HEAT))
        .rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      Date.now = realNow;
    }
    expect(sentCmds()).toEqual([]);
  });

  it('refuses to heat when the kettle is off its base', async () => {
    const { thermostat, sentCmds } = await setup({ status: OFF_BASE });
    await expect(thermostat().getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(C.TargetHeatingCoolingState.HEAT))
      .rejects.toBe(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    expect(sentCmds()).toEqual([]);
  });

  it('Keep Warm off → next heat has no hold', async () => {
    const { sub, lastSent } = await setup();
    await sub(S.Switch, 'keep-warm')!.getCharacteristic(C.On).handleSetRequest(false);
    await sub(S.Switch, 'preset-boil')!.getCharacteristic(C.On).handleSetRequest(true);
    await until(() => lastSent(Cmd.SET_MODE) !== undefined);
    expect([...lastSent(Cmd.SET_MODE)!.payload.subarray(4)]).toEqual([Mode.BOIL, 0x00, 0x00, 0x00, 0x00]);
  });

  it('Keep Warm toggled while heating → set hold (F2)', async () => {
    const { sub, lastSent } = await setup({ status: HEATING });
    await sub(S.Switch, 'keep-warm')!.getCharacteristic(C.On).handleSetRequest(true);
    await until(() => lastSent(Cmd.SET_HOLD) !== undefined);
    expect(lastSent(Cmd.SET_HOLD)!.payload.readUInt16LE(6)).toBe(1800);
  });

  it('MyBrew switch uses the kettle\'s stored MyBrew temperature', async () => {
    const { sub, sentCmds, lastSent } = await setup({ overrides: { accessories: { presets: { myBrew: true } } } });
    await sub(S.Switch, 'preset-myBrew')!.getCharacteristic(C.On).handleSetRequest(true);
    await until(() => lastSent(Cmd.SET_MODE) !== undefined);
    expect(sentCmds()).toEqual([Cmd.SET_MY_TEMP, Cmd.SET_MODE]);
    expect(lastSent(Cmd.SET_MY_TEMP)!.payload[4]).toBe(140);
    expect(lastSent(Cmd.SET_MODE)!.payload[4]).toBe(Mode.MY_BREW);
  });

  it('Delay Start switch schedules the current target with the configured delay', async () => {
    const { sub, lastSent } = await setup({ overrides: { delayStartMinutes: 25, accessories: { delayStartSwitch: true } } });
    await sub(S.Switch, 'delay-start')!.getCharacteristic(C.On).handleSetRequest(true);
    await until(() => lastSent(Cmd.DELAYED_START) !== undefined);
    // 180 °F setpoint → green tea preset; 25 min; hold 30 min — identical to the VeSync app capture
    expect(lastSent(Cmd.DELAYED_START)!.payload).toEqual(payload(OWN_KETTLE_FRAMES.delayStartGreen25Hold30));
  });

  it('Delay Start off while scheduled → stop; scheduled is not "heating"', async () => {
    const scheduled = payload(OWN_KETTLE_FRAMES.extendedScheduled297);
    const { thermostat, sub, lastSent } = await setup({ status: scheduled, overrides: { accessories: { delayStartSwitch: true } } });
    expect(await sub(S.Switch, 'delay-start')!.getCharacteristic(C.On).handleGetRequest()).toBe(true);
    expect(await thermostat().getCharacteristic(C.CurrentHeatingCoolingState).handleGetRequest()).toBe(C.CurrentHeatingCoolingState.OFF);
    await sub(S.Switch, 'delay-start')!.getCharacteristic(C.On).handleSetRequest(false);
    await until(() => lastSent(Cmd.STOP) !== undefined);
  });
});
