/**
 * Minimal Homebridge API stand-in for accessory tests: the real HAP library (services, characteristics,
 * HapStatusError) with a tiny PlatformAccessory wrapper. No HAP server, mDNS or storage is started.
 */
import * as hap from '@homebridge/hap-nodejs';
import type { API, PlatformAccessory } from 'homebridge';

export class FakePlatformAccessory {
  context: Record<string, unknown> = {};
  readonly hapAccessory: hap.Accessory;

  constructor(public displayName: string, public UUID: string) {
    this.hapAccessory = new hap.Accessory(displayName, UUID);
  }

  getService(type: Parameters<hap.Accessory['getService']>[0]) {
    return this.hapAccessory.getService(type);
  }

  getServiceById(type: Parameters<hap.Accessory['getServiceById']>[0], subtype: string) {
    return this.hapAccessory.getServiceById(type, subtype);
  }

  addService(...args: Parameters<hap.Accessory['addService']>) {
    return this.hapAccessory.addService(...args);
  }

  removeService(service: hap.Service) {
    this.hapAccessory.removeService(service);
  }

  get services() {
    return this.hapAccessory.services;
  }
}

export function fakeApi(): API {
  return {
    hap,
    platformAccessory: FakePlatformAccessory,
    updatePlatformAccessories: () => undefined,
    on: () => undefined,
  } as unknown as API;
}

export function newAccessory(name = 'Kettle'): PlatformAccessory {
  return new FakePlatformAccessory(name, hap.uuid.generate(name)) as unknown as PlatformAccessory;
}

export { hap };
