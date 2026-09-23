import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { PLATFORM_NAME } from './settings.js';

/**
 * Checkpoint A build: the HomeKit layer is not implemented yet. The platform registers so that
 * Homebridge loads the package cleanly, and points the user at the probe CLI.
 */
class CosoriKettlePlatform implements DynamicPlatformPlugin {
  constructor(private readonly log: Logging, config: PlatformConfig, api: API) {
    api.on('didFinishLaunching', () => {
      this.log.warn('The HomeKit layer is not implemented in this pre-release build. Use `cosori-probe` to validate your kettle (see README).');
    });
    void config;
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Ignoring cached accessory', accessory.displayName);
  }
}

/**
 * This method registers the platform with Homebridge
 */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, CosoriKettlePlatform);
};
