import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { KettleAccessory } from './accessory/KettleAccessory.js';
import { BluezTransport } from './ble/BluezTransport.js';
import { parseConfig, type KettlePluginConfig } from './config.js';
import { ConnectionManager } from './kettle/ConnectionManager.js';
import { KettleClient } from './kettle/KettleClient.js';
import { ProtocolVersion } from './protocol/constants.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { errorMessage } from './util/async.js';
import { type Logger, withDebug } from './util/log.js';

/**
 * Dynamic platform: one accessory per configured kettle (currently one), keyed by MAC address.
 */
export class CosoriKettlePlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly log: Logger;
  private readonly config?: KettlePluginConfig;
  private manager?: ConnectionManager;

  constructor(log: Logging, rawConfig: PlatformConfig, private readonly api: API) {
    const parsed = parseConfig(rawConfig as unknown as Record<string, unknown>);
    this.log = withDebug(log, parsed.config?.debug ?? false);
    for (const w of parsed.warnings) {
      this.log.warn(`Config: ${w}`);
    }
    for (const e of parsed.errors) {
      this.log.error(`Config: ${e}`);
    }
    this.config = parsed.config;

    api.on('didFinishLaunching', () => {
      try {
        this.setup();
      } catch (err) {
        this.log.error(`Setup failed: ${errorMessage(err)}`);
      }
    });
    api.on('shutdown', () => {
      void this.manager?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private setup(): void {
    const config = this.config;
    if (!config) {
      this.log.error('Not starting: fix the configuration errors above. Existing HomeKit accessories are kept.');
      return;
    }
    if (!config.registrationKey) {
      this.log.error('No "registrationKey" configured. Capture the VeSync app\'s key with `cosori-probe key-from-log <capture.pklg>` '
        + '(see README "Registration key"), or pair a new key with `cosori-probe pair`. Not connecting until a key is set.');
      return;
    }

    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${config.mac}`);
    let accessory = this.cached.get(uuid);
    const created = !accessory;
    if (accessory) {
      this.log.debug(`Restoring ${accessory.displayName} from cache`);
    } else {
      this.log.info(`Adding ${config.name} (${config.mac})`);
      accessory = new this.api.platformAccessory(config.name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    const stale = [...this.cached.values()].filter((a) => a.UUID !== uuid);
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} accessory(ies) no longer in the config`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    const transport = new BluezTransport(config.mac, { dbusAddress: config.dbusAddress, adapter: config.adapter, log: this.log });
    const client = new KettleClient(transport, {
      protocolVersion: config.protocolVersion === 'auto' ? 'auto' : config.protocolVersion === 0 ? ProtocolVersion.V0 : ProtocolVersion.V1,
      log: this.log,
      traceFrames: config.debug,
    });
    this.manager = new ConnectionManager(client, {
      key: config.registrationKey,
      mode: config.connectionMode,
      pollIntervalMs: config.pollIntervalSeconds * 1000,
      onDemandPollIntervalMs: config.onDemandPollIntervalSeconds * 1000,
      idleDisconnectMs: config.idleDisconnectSeconds * 1000,
      log: this.log,
    });
    new KettleAccessory(this.api, this.log, config, accessory, this.manager, created);
    this.api.updatePlatformAccessories([accessory]);

    this.log.info(`${config.name}: ${config.connectionMode === 'persistent' ? 'staying connected' : 'connecting on demand'} `
      + '(the VeSync app can only connect while the plugin is not connected)');
    this.manager.start();
  }
}
