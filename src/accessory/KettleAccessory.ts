/**
 * HomeKit services for one kettle.
 *
 *  - Thermostat (primary): current / target temperature, heat on/off
 *  - Occupancy sensor "On Base" (optional)
 *  - Switches: the user's temperature switches (default: the kettle presets), Keep Warm, Delay Start
 *
 * GET handlers answer from cached state (or "No Response" when it is stale). SET handlers validate,
 * update the tile optimistically and run the kettle command in the background: a BLE connection can
 * take 10–40 s, far longer than HomeKit waits for a SET response. If the command fails, the tiles are
 * re-synced to the kettle's real state and the reason is logged.
 */
import type { API, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';

import { DEFAULT_SWITCHES, type KettlePluginConfig, type TemperatureSwitch } from '../config.js';
import type { ConnectionManager } from '../kettle/ConnectionManager.js';
import { describeCompletion, type KettleClient, type KettleStatus } from '../kettle/KettleClient.js';
import { effectiveSetpointF, Mode, PRESET_TEMP_F } from '../protocol/constants.js';
import { errorMessage } from '../util/async.js';
import type { Logger } from '../util/log.js';
import {
  currentFToC, firmwareRevision, TARGET_MAX_C, TARGET_MIN_C, TARGET_STEP_C, targetCToF, targetFToC, TemperatureSmoother,
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
  /**
   * Created by a version with the switch list (set once, when the platform creates the accessory). Such an install
   * with no list configured gets DEFAULT_SWITCHES; an older one keeps its preset tiles.
   */
  createdWithSwitchList?: boolean;
}

export class KettleAccessory {
  private readonly thermostat: Service;
  private readonly onBase?: Service;
  private readonly keepWarm?: Service;
  private readonly delayStart?: Service;
  private readonly temperatureSwitches: { item: TemperatureSwitch; service: Service }[] = [];
  private readonly smoother = new TemperatureSmoother();
  private readonly ctx: KettleContext;
  private infoUpdated = false;

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly config: KettlePluginConfig,
    private readonly accessory: PlatformAccessory,
    private readonly manager: ConnectionManager,
    /** True when the platform just created this accessory, false when it was restored from the cache. */
    created: boolean,
  ) {
    const { Service: S, Characteristic: C } = api.hap;
    this.ctx = accessory.context as KettleContext;
    if (created) {
      this.ctx.createdWithSwitchList = true;
    }
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

    // --- Temperature switches ------------------------------------------------------------------
    const switches = config.switches ?? this.defaultSwitches();
    const wanted = new Set(switches.map((item) => item.subtype));
    const unlisted = accessory.services.filter((svc) => svc.UUID === S.Switch.UUID && svc.subtype?.startsWith('preset-') && !wanted.has(svc.subtype));
    if (config.switchesSkipped && unlisted.length > 0) {
      // A typo in a switch entry must not delete its tile (and with it the tile's room and automations).
      log.warn(`${config.name}: keeping ${unlisted.map((svc) => `"${svc.displayName}"`).join(', ')} until the skipped switch entries `
        + 'are fixed; they do nothing meanwhile');
      for (const svc of unlisted) {
        svc.getCharacteristic(C.On)
          .onGet(() => false)
          .onSet(() => {
            log.warn(`${config.name}: "${svc.displayName}" is not in the switch list; fix the skipped entries in the plugin settings`);
            setTimeout(() => svc.updateCharacteristic(C.On, false), 200);
            // Fail the SET so an automation or Siri reports it instead of claiming success.
            throw new api.hap.HapStatusError(api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
          });
      }
    } else {
      // Drop tiles for switches that were removed from the config (and the retired MyBrew switch).
      for (const svc of unlisted) {
        accessory.removeService(svc);
      }
    }
    for (const item of switches) {
      const service = this.ensureService(S.Switch, item.subtype, item.name);
      this.temperatureSwitches.push({ item, service });
      service.getCharacteristic(C.On)
        .onGet(() => this.read((s) => this.switchOn(item, s)))
        .onSet((v) => this.setSwitch(item, Boolean(v)));
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
    return s.active || s.scheduled ? this.heatingToF(s) : this.ctx.targetF ?? s.setpointF;
  }

  /**
   * The temperature the kettle is heating to. A preset mode fixes it: an F3 during a preset heat already changes
   * byte 6 before the mode follows. In MyBrew mode, bytes 6 and 8 both hold the MyBrew temperature (captured
   * 2026-09-25); compact statuses have no byte 8.
   */
  private heatingToF(s: KettleStatus): number {
    const preset = PRESET_TEMP_F[s.mode];
    if (preset !== undefined) {
      return preset;
    }
    return s.mode === Mode.MY_BREW && s.myTempF !== undefined ? s.myTempF : s.setpointF;
  }

  /** On while the kettle is heating or holding at this switch's temperature. */
  private switchOn(item: TemperatureSwitch, s: KettleStatus): boolean {
    return s.active && effectiveSetpointF(this.heatingToF(s)) === item.temperatureF;
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

  private setSwitch(item: TemperatureSwitch, on: boolean): void {
    this.assertCanCommand();
    if (!on) {
      this.exec(`stop ${item.name}`, (c) => c.stop(), () => !!this.manager.status && this.switchOn(item, this.manager.status));
      return;
    }
    this.assertOnBase();
    this.ctx.targetF = item.temperatureF;
    this.api.updatePlatformAccessories([this.accessory]);
    // heatTo uses the kettle's preset when the temperature is one (±1 °F), otherwise MyBrew.
    this.exec(`${item.name} (${item.temperatureF}°F)`, (c) => c.heatTo(item.temperatureF, this.holdSeconds()));
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
    for (const { item, service } of this.temperatureSwitches) {
      service.updateCharacteristic(C.On, this.switchOn(item, s));
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

  /**
   * Switches when the config has no list: the kettle presets for a new install. An install from before the list
   * keeps the preset tiles it has (the old default was Boil only), so an upgrade never adds tiles on its own.
   */
  private defaultSwitches(): TemperatureSwitch[] {
    if (this.ctx.createdWithSwitchList) {
      return [...DEFAULT_SWITCHES];
    }
    const { Service: S } = this.api.hap;
    const kept = DEFAULT_SWITCHES.filter((item) => this.accessory.getServiceById(S.Switch, item.subtype));
    this.log.info(`${this.config.name}: no temperature switches configured; keeping your existing preset tiles `
      + `(${kept.map((item) => item.name).join(', ') || 'none'}). Add switches under "Temperature switches" in the plugin settings.`);
    return kept;
  }

  /** Add (or keep) a named sub-service when enabled; remove a cached one when disabled. */
  private optionalService(enabled: boolean, type: WithUUID<typeof Service>, subtype: string, name: string): Service | undefined {
    if (!enabled) {
      const existing = this.accessory.getServiceById(type, subtype);
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }
    return this.ensureService(type, subtype, name);
  }

  /** Add (or keep) a named sub-service. */
  private ensureService(type: WithUUID<typeof Service>, subtype: string, name: string): Service {
    const svc = this.accessory.getServiceById(type, subtype) ?? this.accessory.addService(type, name, subtype);
    this.applyName(svc, name);
    return svc;
  }

  /**
   * Set Name and ConfiguredName. The Home app shows ConfiguredName and, when a bridge is added, may overwrite
   * it with generic defaults ("Switch 3", "Occupancy Sensor"). Restore ours in that case, and follow a rename
   * in the config, but keep any name the user chose in the Home app.
   */
  private applyName(svc: Service, name: string): void {
    const { Characteristic: C } = this.api.hap;
    const previous = svc.getCharacteristic(C.Name).value;
    svc.setCharacteristic(C.Name, name);
    if (!svc.testCharacteristic(C.ConfiguredName)) {
      svc.addOptionalCharacteristic(C.ConfiguredName);
    }
    const current = svc.getCharacteristic(C.ConfiguredName).value;
    if (typeof current !== 'string' || current.trim() === '' || isHomeAppDefaultName(current) || current === previous) {
      svc.updateCharacteristic(C.ConfiguredName, name);
    }
  }
}

