import { describe, expect, it } from 'vitest';

import {
  adaptersFrom, devicePath, devicesFrom, findCharacteristic, findServicePath, parseManagedObjects,
} from '../../src/ble/bluez.js';
import { matchRule, unwrap } from '../../src/ble/dbus.js';
import { RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID } from '../../src/protocol/constants.js';
import {
  ADAPTER_MAC, ADAPTER_PATH, DEVICE_PATH, KETTLE_MAC, KETTLE_MANUFACTURER_DATA, kettleDevice, kettleGatt, managedObjectsReply, RX_PATH, roundTrip, TX_PATH,
  type ObjectTree,
} from './FakeBluez.js';

function managedObjects(tree: ObjectTree) {
  return parseManagedObjects(managedObjectsReply(tree));
}

function kettleTree(): ObjectTree {
  return new Map([
    ['/org/bluez/hci1', { 'org.bluez.Adapter1': { Address: ['s', 'd8:3a:dd:00:00:01'], Powered: ['b', false], Discovering: ['b', false] } }],
    [ADAPTER_PATH, { 'org.bluez.Adapter1': { Address: ['s', ADAPTER_MAC], Powered: ['b', true], Discovering: ['b', true] } }],
    [DEVICE_PATH, kettleDevice()],
    ...kettleGatt(),
  ]);
}

describe('unwrap', () => {
  it('strips variants as dbus-native decodes them, including nested ones', () => {
    expect(unwrap(roundTrip('v', [['s', 'hello']])[0])).toBe('hello');
    expect(unwrap(roundTrip('v', [['b', true]])[0])).toBe(true);
    expect(unwrap(roundTrip('v', [['n', -84]])[0])).toBe(-84);
    expect(unwrap(roundTrip('v', [['as', ['write', 'notify']]])[0])).toEqual(['write', 'notify']);
    expect(unwrap(roundTrip('v', [['a{qv}', [[0x06d0, ['ay', KETTLE_MANUFACTURER_DATA]]]]])[0]))
      .toEqual([[0x06d0, KETTLE_MANUFACTURER_DATA]]);
  });

  it('leaves byte arrays as Buffers', () => {
    const value = unwrap(roundTrip('v', [['ay', Buffer.from([0xa5, 0x22])]])[0]);
    expect(Buffer.isBuffer(value)).toBe(true);
    expect(value).toEqual(Buffer.from([0xa5, 0x22]));
  });
});

describe('parseManagedObjects', () => {
  it('maps paths to interfaces to plain properties', () => {
    const objects = managedObjects(kettleTree());
    expect(objects.get(DEVICE_PATH)?.get('org.bluez.Device1')).toMatchObject({
      Address: KETTLE_MAC, Name: 'Cosori Gooseneck Kettle', RSSI: -80, Connected: false,
    });
  });

  it('tolerates an empty or malformed body', () => {
    expect(parseManagedObjects([]).size).toBe(0);
    expect(parseManagedObjects([[['not a pair']]]).size).toBe(0);
  });
});

describe('BlueZ tree helpers', () => {
  it('builds device paths from a MAC in any case or separator', () => {
    expect(devicePath(ADAPTER_PATH, 'fc:58:fa:0f:c3:26')).toBe(DEVICE_PATH);
    expect(devicePath(ADAPTER_PATH, 'FC-58-FA-0F-C3-26')).toBe(DEVICE_PATH);
  });

  it('lists adapters in hciN order with uppercase addresses and power state', () => {
    const adapters = adaptersFrom(managedObjects(kettleTree()));
    expect(adapters.map((a) => [a.name, a.address, a.powered, a.discovering])).toEqual([
      ['hci0', ADAPTER_MAC, true, true],
      ['hci1', 'D8:3A:DD:00:00:01', false, false],
    ]);
  });

  it('orders hci10 after hci2', () => {
    const tree: ObjectTree = new Map([
      ['/org/bluez/hci10', { 'org.bluez.Adapter1': { Address: ['s', '00:00:00:00:00:10'] } }],
      ['/org/bluez/hci2', { 'org.bluez.Adapter1': { Address: ['s', '00:00:00:00:00:02'] } }],
    ]);
    expect(adaptersFrom(managedObjects(tree)).map((a) => a.name)).toEqual(['hci2', 'hci10']);
  });

  it('finds the kettle service and characteristics by UUID, with flags', () => {
    const objects = managedObjects(kettleTree());
    const service = findServicePath(objects, DEVICE_PATH, SERVICE_UUID);
    expect(service).toBe(`${DEVICE_PATH}/service000c`);
    expect(findCharacteristic(objects, service!, RX_CHAR_UUID)).toEqual({ path: RX_PATH, flags: ['notify'] });
    expect(findCharacteristic(objects, service!, TX_CHAR_UUID)).toEqual({ path: TX_PATH, flags: ['write-without-response', 'write'] });
  });

  it('matches UUIDs regardless of case, and only under the given device', () => {
    const objects = managedObjects(kettleTree());
    expect(findServicePath(objects, DEVICE_PATH, SERVICE_UUID.toUpperCase())).toBeDefined();
    expect(findServicePath(objects, `${ADAPTER_PATH}/dev_00_00_00_00_00_00`, SERVICE_UUID)).toBeUndefined();
  });

  it('summarises devices for a scan, with the 0x06D0 manufacturer id', () => {
    expect(devicesFrom(managedObjects(kettleTree()), ADAPTER_PATH)).toEqual([
      { path: DEVICE_PATH, address: KETTLE_MAC, name: 'Cosori Gooseneck Kettle', rssi: -80, manufacturerIds: [0x06d0] },
    ]);
    expect(devicesFrom(managedObjects(kettleTree()), '/org/bluez/hci1')).toEqual([]);
  });
});

describe('matchRule', () => {
  it('builds an AddMatch rule for a BlueZ signal', () => {
    expect(matchRule({ sender: 'org.bluez', path: DEVICE_PATH, interface: 'org.freedesktop.DBus.Properties', member: 'PropertiesChanged' }))
      .toBe(`type='signal',sender='org.bluez',path='${DEVICE_PATH}',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'`);
  });
});
