/**
 * HomeKit services for one kettle.
 *
 *  - Thermostat (primary): current / target temperature, heat on/off
 *  - Occupancy sensor "On Base" (optional)
 *  - Switches: presets, Keep Warm, Delay Start (each optional)
 *
 * GET handlers answer from cached state (or "No Response" when it is stale). SET handlers validate,
 * update the tile optimistically and run the kettle command in the background: a BLE connection can
 * take 10–40 s, far longer than HomeKit waits for a SET response. If the command fails, the tiles are
 * re-synced to the kettle's real state and the reason is logged.
 */
import type { API, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { KettlePluginConfig } from '../config.js';
import type { ConnectionManager } from '../kettle/ConnectionManager.js';
import { describeCompletion, type KettleClient, type KettleStatus } from '../kettle/KettleClient.js';
import { Mode, PRESET_TEMP_F } from '../protocol/constants.js';
import { errorMessage } from '../util/async.js';
import type { Logger } from '../util/log.js';
import {
  currentFToC, firmwareRevision, PRESETS, type PresetDefinition, TARGET_MAX_C, TARGET_MIN_C, TARGET_STEP_C, targetCToF, targetFToC,
  TemperatureSmoother,
} from './mapping.js';

/** Names the Home app assigns by itself: the service type, optionally followed by a number. */
export function isHomeAppDefaultName(name: string): boolean {
  return /^(Switch|Occupancy Sensor|Thermostat|Kettle)( \d+)?$/.test(name.trim());
}

interface KettleContext {
  mac: string;
  /** Last target temperature chosen in HomeKit (°F). */
  targetF?: number;
  /** Keep-warm preference applied when heating starts. */
  keepWarm?: boolean;
}

export class KettleAccessory {
  private readonly thermostat: Service;
  private readonly onBase?: Service;
  private readonly keepWarm?: Service;
  private readonly delayStart?: Service;
  private readonly presetSwitches = new Map<PresetDefinition['key'], Service>();
  private readonly smoother = new TemperatureSmoother();
  private readonly ctx: KettleContext;
  private infoUpdated = false;

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly config: KettlePluginConfig,
    private readonly accessory: PlatformAccessory,
    private readonly manager: ConnectionManager,
  ) {
    const { Service: S, Characteristic: C } = api.hap;
    this.ctx = accessory.context as KettleContext;
    this.ctx.mac = config.mac;
    this.ctx.keepWarm ??= true;

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Cosori')
      .setCharacteristic(C.Model, 'Smart Gooseneck Kettle')
      .setCharacteristic(C.SerialNumber, config.mac);

    // --- Thermostat -----------------------------------------------------------------------------
    this.thermostat = accessory.getService(S.Thermostat) ?? accessory.addService(S.Thermostat, config.name);
    this.thermostat.setPrimaryService(true);
    this.applyName(this.thermostat, config.name);
    this.thermostat.getCharacteristic(C.CurrentHeatingCoolingState)
      .onGet(() => this.read((s) => (s.active ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF)));
    this.thermostat.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.HEAT] })
      .onGet(() => this.read((s) => (s.active ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF)))
      .onSet((v) => this.setHeating(v === C.TargetHeatingCoolingState.HEAT));
    this.thermostat.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.read((s) => currentFToC(this.smoother.value ?? s.tempF)));
    // Widen the range in steps so the default value (10 °C) is never outside the props, which HAP warns about.
    this.thermostat.getCharacteristic(C.TargetTemperature)
      .setProps({ maxValue: TARGET_MAX_C, minStep: TARGET_STEP_C })
      .updateValue(TARGET_MAX_C)
      .setProps({ minValue: TARGET_MIN_C })
      .onGet(() => this.read((s) => targetFToC(this.displayTargetF(s))))
      .onSet((v) => this.setTarget(Number(v)));
    this.thermostat.getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(() => (config.temperatureUnit === 'C' ? C.TemperatureDisplayUnits.CELSIUS : C.TemperatureDisplayUnits.FAHRENHEIT))
      .onSet(() => undefined);

    // --- On-base sensor ------------------------------------------------------------------------
    this.onBase = this.optionalService(config.accessories.onBaseSensor, S.OccupancySensor, 'on-base', 'On Base');
    this.onBase?.getCharacteristic(C.OccupancyDetected)
      .onGet(() => this.read((s) => (s.onBase === false
        ? C.OccupancyDetected.OCCUPANCY_NOT_DETECTED
        : C.OccupancyDetected.OCCUPANCY_DETECTED)));

    // --- Preset switches -----------------------------------------------------------------------
    for (const preset of PRESETS) {
      const svc = this.optionalService(config.accessories.presets[preset.key], S.Switch, `preset-${preset.key}`, preset.label);
      if (!svc) {
        continue;
      }
      this.presetSwitches.set(preset.key, svc);
      svc.getCharacteristic(C.On)
        .onGet(() => this.read((s) => s.active && s.mode === preset.mode))
        .onSet((v) => this.setPreset(preset, Boolean(v)));
    }

    // --- Keep warm -----------------------------------------------------------------------------
    this.keepWarm = this.optionalService(config.accessories.keepWarmSwitch, S.Switch, 'keep-warm', 'Keep Warm');
    this.keepWarm?.getCharacteristic(C.On)
      .onGet(() => this.read((s) => this.keepWarmOn(s)))
      .onSet((v) => this.setKeepWarm(Boolean(v)));

    // --- Delay start ---------------------------------------------------------------------------
    this.delayStart = this.optionalService(config.accessories.delayStartSwitch, S.Switch, 'delay-start', 'Delay Start');
    this.delayStart?.getCharacteristic(C.On)
      .onGet(() => this.read((s) => s.scheduled))
      .onSet((v) => this.setDelayStart(Boolean(v)));

    manager.on('status', (s) => this.push(s));
    manager.on('connection', (connected) => {
      if (connected) {
        this.updateInfo();
      }
    });
    manager.on('completion', (code) => this.log.info(`${config.name}: ${describeCompletion(code)}`));
  }

  // ---------------------------------------------------------------------------------------------
  // GET helpers

  private read<T extends CharacteristicValue>(fn: (s: KettleStatus) => T): T {
    const s = this.manager.status;
    if (!s || !this.manager.isFresh()) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return fn(s);
  }

  private displayTargetF(s: KettleStatus): number {
    return s.active || s.scheduled ? s.setpointF : this.ctx.targetF ?? s.setpointF;
  }

  private keepWarmOn(s: KettleStatus): boolean {
    return s.active || s.scheduled ? s.configuredHoldSeconds > 0 : this.ctx.keepWarm !== false;
  }

  private holdSeconds(): number {
    return this.ctx.keepWarm === false ? 0 : this.config.keepWarmMinutes * 60;
  }

  // ---------------------------------------------------------------------------------------------
  // SET handlers

  /**
   * Refuse commands up front (HomeKit shows "No Response") when they cannot succeed soon: the key was
   * rejected, or the link has been down long enough that this is not just a quick reconnect.
   */
  private assertCanCommand(): void {
    if (this.manager.registrationKeyRejected || this.manager.unreachableForMs() > 15_000) {
      this.log.warn(`${this.config.name}: not reachable right now; command refused`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private assertOnBase(): void {
    if (this.manager.status?.onBase === false) {
      this.log.warn(`${this.config.name}: the kettle is off its base; put it back before heating`);
      setTimeout(() => this.resync(), 500);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
  }

  private setHeating(on: boolean): void {
    this.assertCanCommand();
    if (on) {
      this.assertOnBase();
      const targetF = this.ctx.targetF ?? this.manager.status?.setpointF ?? PRESET_TEMP_F[Mode.BOIL]!;
      this.exec(`heat to ${targetF}°F`, (c) => c.heatTo(targetF, this.holdSeconds()));
    } else {
      this.exec('stop', (c) => c.stop(), () => !!(this.manager.status?.active || this.manager.status?.scheduled));
    }
  }

  private setTarget(c: number): void {
    const targetF = targetCToF(c);
    this.ctx.targetF = targetF;
    this.api.updatePlatformAccessories([this.accessory]);
    const s = this.manager.status;
    if (s?.active) {
      this.assertCanCommand();
      this.exec(`change target to ${targetF}°F`, (client) => client.heatTo(targetF, this.holdSeconds()));
    } else {
      this.log.debug(`${this.config.name}: target set to ${targetF}°F (applies when heating starts)`);
    }
  }

  private setPreset(preset: PresetDefinition, on: boolean): void {
    this.assertCanCommand();
    if (!on) {
      this.exec(`stop ${preset.key}`, (c) => c.stop(), () => !!this.manager.status?.active && this.manager.status.mode === preset.mode);
      return;
    }
    this.assertOnBase();
    if (preset.mode === Mode.MY_BREW) {
      const myTempF = this.manager.status?.myTempF ?? this.ctx.targetF;
      if (!myTempF) {
        this.log.warn(`${this.config.name}: MyBrew temperature unknown yet; set a target temperature first`);
        setTimeout(() => this.resync(), 500);
        return;
      }
      this.ctx.targetF = myTempF;
      this.exec(`MyBrew ${myTempF}°F`, async (c) => {
        await c.setMyTemp(myTempF);
        await c.setMode(Mode.MY_BREW, { tempF: myTempF, holdSeconds: this.holdSeconds() });
      });
    } else {
      this.ctx.targetF = PRESET_TEMP_F[preset.mode];
      this.exec(`${preset.key}`, (c) => c.setMode(preset.mode, { holdSeconds: this.holdSeconds() }));
    }
    this.api.updatePlatformAccessories([this.accessory]);
  }

  private setKeepWarm(on: boolean): void {
    this.ctx.keepWarm = on;
    this.api.updatePlatformAccessories([this.accessory]);
    const s = this.manager.status;
    if (s?.active) {
      this.assertCanCommand();
      this.exec(`keep warm ${on ? 'on' : 'off'}`, (c) => c.setHold(on ? this.config.keepWarmMinutes * 60 : 0));
    }
  }

  private setDelayStart(on: boolean): void {
    this.assertCanCommand();
    if (!on) {
      this.exec('cancel delay start', (c) => c.stop(), () => !!this.manager.status?.scheduled);
      return;
    }
    this.assertOnBase();
    const targetF = this.ctx.targetF ?? this.manager.status?.setpointF ?? PRESET_TEMP_F[Mode.BOIL]!;
    const delaySeconds = this.config.delayStartMinutes * 60;
    this.exec(`delay start ${targetF}°F in ${this.config.delayStartMinutes} min`, (c) => c.heatToLater(delaySeconds, targetF, this.holdSeconds()));
  }

  /** Run a command in the background; log and re-sync on failure. */
  private exec(label: string, fn: (c: KettleClient) => Promise<unknown>, onlyIf?: () => boolean): void {
    if (onlyIf && !onlyIf()) {
      this.log.debug(`${this.config.name}: ${label} skipped (not applicable in current state)`);
      setTimeout(() => this.resync(), 200);
      return;
    }
    this.log.info(`${this.config.name}: ${label}`);
    void this.manager.run(label, fn).then(
      () => this.resync(),
      (err) => {
        this.log.error(`${this.config.name}: ${label} failed: ${errorMessage(err)}`);
        this.resync();
      },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Pushing state to HomeKit

  private resync(): void {
    const s = this.manager.status;
    if (s) {
      this.push(s);
    }
  }

  private push(s: KettleStatus): void {
    const { Characteristic: C } = this.api.hap;
    const shownF = this.smoother.update(s.tempF);
    this.thermostat.updateCharacteristic(C.CurrentTemperature, currentFToC(shownF));
    this.thermostat.updateCharacteristic(C.CurrentHeatingCoolingState,
      s.active ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF);
    this.thermostat.updateCharacteristic(C.TargetHeatingCoolingState,
      s.active ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF);
    this.thermostat.updateCharacteristic(C.TargetTemperature, targetFToC(this.displayTargetF(s)));
    if (s.onBase !== undefined) {
      this.onBase?.updateCharacteristic(C.OccupancyDetected,
        s.onBase ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    }
    for (const preset of PRESETS) {
      this.presetSwitches.get(preset.key)?.updateCharacteristic(C.On, s.active && s.mode === preset.mode);
    }
    this.keepWarm?.updateCharacteristic(C.On, this.keepWarmOn(s));
    this.delayStart?.updateCharacteristic(C.On, s.scheduled);
  }

  private updateInfo(): void {
    if (this.infoUpdated) {
      return;
    }
    const { Service: S, Characteristic: C } = this.api.hap;
    const info = this.manager.deviceInfo;
    const fw = firmwareRevision(info.softwareRevision, info.hardwareRevision);
    const svc = this.accessory.getService(S.AccessoryInformation)!;
    if (fw) {
      svc.updateCharacteristic(C.FirmwareRevision, fw);
    }
    if (info.hardwareRevision) {
      svc.updateCharacteristic(C.HardwareRevision, info.hardwareRevision);
    }
    this.infoUpdated = true;
  }

  // ---------------------------------------------------------------------------------------------

  /** Add (or keep) a named sub-service when enabled; remove a cached one when disabled. */
  private optionalService(enabled: boolean, type: WithUUID<typeof Service>, subtype: string, name: string): Service | undefined {
    const existing = this.accessory.getServiceById(type, subtype);
    if (!enabled) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }
    const svc = existing ?? this.accessory.addService(type, name, subtype);
    this.applyName(svc, name);
    return svc;
  }

  /**
   * Set Name and ConfiguredName. The Home app shows ConfiguredName and, when a bridge is added, may overwrite
   * it with generic defaults ("Switch 3", "Occupancy Sensor"). Restore ours in that case, but keep any name
   * the user chose.
   */
  private applyName(svc: Service, name: string): void {
    const { Characteristic: C } = this.api.hap;
    svc.setCharacteristic(C.Name, name);
    if (!svc.testCharacteristic(C.ConfiguredName)) {
      svc.addOptionalCharacteristic(C.ConfiguredName);
    }
    const current = svc.getCharacteristic(C.ConfiguredName).value;
    if (typeof current !== 'string' || current.trim() === '' || isHomeAppDefaultName(current)) {
      svc.updateCharacteristic(C.ConfiguredName, name);
    }
  }
}

