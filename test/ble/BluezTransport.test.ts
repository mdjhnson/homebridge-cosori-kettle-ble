import { describe, expect, it } from 'vitest';

import { AdapterNotFoundError, BluezTransport, type BluezTransportOptions } from '../../src/ble/BluezTransport.js';
import { DbusError } from '../../src/ble/dbus.js';
import { ADAPTER_MAC, DEVICE_PATH, FakeBluez, kettleDevice, KETTLE_MAC, RX_PATH, TX_PATH } from './FakeBluez.js';

function setup(fake = new FakeBluez(), options: BluezTransportOptions = {}) {
  const opened: string[] = [];
  const transport = new BluezTransport(KETTLE_MAC.toLowerCase(), {
    openBus: async (address) => {
      opened.push(address ?? 'default');
      return fake;
    },
    dbusAddress: 'unix:path=/tmp/fake-bus',
    ...options,
  });
  return { fake, transport, opened };
}

describe('BluezTransport.connect', () => {
  it('connects, waits for GATT, subscribes to FFF1 and picks write-with-response', async () => {
    const { fake, transport, opened } = setup();
    await transport.connect();
    expect(transport.connected).toBe(true);
    expect(opened).toEqual(['unix:path=/tmp/fake-bus']);
    expect(fake.calls.find((c) => c.member === 'Connect')?.path).toBe(DEVICE_PATH);
    expect(fake.calls.find((c) => c.member === 'StartNotify')?.path).toBe(RX_PATH);
    expect(fake.members()).not.toContain('StartDiscovery');
    expect(await transport.txFlags()).toEqual(['write-without-response', 'write']);

    await transport.write(Buffer.from([0xa5, 0x22]));
    const write = fake.calls.find((c) => c.member === 'WriteValue');
    expect(write?.path).toBe(TX_PATH);
    expect(write?.signature).toBe('aya{sv}');
    expect(write?.body).toEqual([Buffer.from([0xa5, 0x22]), [['type', ['s', 'request']]]]);
  });

  it('uses the configured write mode', async () => {
    const { fake, transport } = setup(new FakeBluez(), { writeMode: 'command' });
    await transport.connect();
    await transport.write(Buffer.from([1]));
    expect(fake.calls.find((c) => c.member === 'WriteValue')?.body?.[1]).toEqual([['type', ['s', 'command']]]);
  });

  it('does not wait when services are already resolved', async () => {
    const fake = new FakeBluez();
    fake.autoResolve = false;
    fake.overrides.set('Connect', () => {
      fake.resolveServices();
      return [];
    });
    const { transport } = setup(fake, { gattTimeoutMs: 50 });
    await transport.connect();
    expect(transport.connected).toBe(true);
  });

  it('scans when BlueZ does not know the kettle, and stops the scan it started', async () => {
    const fake = new FakeBluez({ deviceKnown: false });
    fake.onDiscovery = () => setTimeout(() => fake.objects.set(DEVICE_PATH, kettleDevice()), 50);
    const { transport } = setup(fake, { discoveryTimeoutMs: 3_000 });
    await transport.connect();
    const members = fake.members();
    expect(members.indexOf('StartDiscovery')).toBeLessThan(members.indexOf('StopDiscovery'));
    expect(members.indexOf('StopDiscovery')).toBeLessThan(members.indexOf('Connect'));
  });

  it('reports a kettle that never shows up while scanning', async () => {
    const { fake, transport } = setup(new FakeBluez({ deviceKnown: false }), { discoveryTimeoutMs: 600 });
    await expect(transport.connect()).rejects.toThrow(/kettle FC:58:FA:0F:C3:26 not found while scanning/);
    expect(fake.members()).toContain('StopDiscovery');
    expect(fake.members()).not.toContain('Connect');
  });

  it('does not stop a scan someone else started', async () => {
    const fake = new FakeBluez({ deviceKnown: false });
    fake.setProp('/org/bluez/hci0', 'org.bluez.Adapter1', 'Discovering', ['b', true], false);
    fake.overrides.set('StartDiscovery', () => {
      throw new Error('StartDiscovery must not be called');
    });
    setTimeout(() => fake.objects.set(DEVICE_PATH, kettleDevice()), 50);
    const { transport } = setup(fake, { discoveryTimeoutMs: 3_000 });
    await transport.connect();
    // connect() still stops discovery right before connecting (le-connection-abort otherwise).
    expect(fake.members().filter((m) => m === 'StopDiscovery')).toHaveLength(1);
  });

  it('cancels a connect that times out by calling Disconnect', async () => {
    const fake = new FakeBluez();
    fake.overrides.set('Connect', () => 'hang');
    const { transport } = setup(fake, { connectTimeoutMs: 30 });
    await expect(transport.connect()).rejects.toThrow('BLE connect timed out after 30 ms');
    expect(fake.calls.find((c) => c.member === 'Disconnect')?.path).toBe(DEVICE_PATH);
    expect(transport.connected).toBe(false);
    expect(fake.subscriptionCount()).toBe(0);
    expect(fake.members().filter((m) => m === 'RemoveMatch')).toHaveLength(fake.members().filter((m) => m === 'AddMatch').length);
  });

  it('passes a BlueZ connect error through, with its D-Bus name', async () => {
    const fake = new FakeBluez();
    fake.overrides.set('Connect', () => {
      throw new DbusError('org.bluez.Error.Failed', 'le-connection-abort-by-local');
    });
    const { transport } = setup(fake);
    await expect(transport.connect()).rejects.toThrow('org.bluez.Error.Failed: le-connection-abort-by-local');
    expect(fake.members()).toContain('Disconnect');
  });

  it('times out GATT discovery with the same message as before', async () => {
    const fake = new FakeBluez();
    fake.autoResolve = false;
    const { transport } = setup(fake, { gattTimeoutMs: 30 });
    await expect(transport.connect()).rejects.toThrow('GATT service discovery timed out after 30 ms');
    expect(fake.members()).toContain('Disconnect');
  });

  it('fails at once when the link drops during GATT discovery', async () => {
    const fake = new FakeBluez();
    fake.autoResolve = false;
    fake.overrides.set('Connect', () => {
      fake.setProp(DEVICE_PATH, 'org.bluez.Device1', 'Connected', ['b', true]);
      setTimeout(() => fake.dropLink(), 10);
      return [];
    });
    const { transport } = setup(fake, { gattTimeoutMs: 5_000 });
    const started = Date.now();
    await expect(transport.connect()).rejects.toThrow('disconnected during GATT service discovery');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('fails at once when the drop arrives in the same socket read as the Connect reply', async () => {
    const fake = new FakeBluez();
    fake.autoResolve = false;
    fake.overrides.set('Connect', () => {
      // Delivered synchronously, before the transport's await on Connect resumes.
      fake.setProp(DEVICE_PATH, 'org.bluez.Device1', 'Connected', ['b', true]);
      fake.dropLink();
      return [];
    });
    const { transport } = setup(fake, { gattTimeoutMs: 5_000 });
    const started = Date.now();
    await expect(transport.connect()).rejects.toThrow('FC:58:FA:0F:C3:26 disconnected during connect');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(transport.connected).toBe(false);
  });

  it('does not report connected when the drop arrives with the StartNotify reply', async () => {
    const fake = new FakeBluez();
    fake.overrides.set('StartNotify', () => {
      fake.dropLink();
      return [];
    });
    const { transport } = setup(fake);
    let disconnects = 0;
    transport.on('disconnect', () => disconnects++);
    await expect(transport.connect()).rejects.toThrow('disconnected during notification setup');
    expect(transport.connected).toBe(false);
    expect(disconnects).toBe(0);
    expect(fake.subscriptionCount()).toBe(0);
    // The transport can connect again afterwards.
    fake.overrides.delete('StartNotify');
    await transport.connect();
    expect(transport.connected).toBe(true);
  });

  it('reports a device without the kettle service', async () => {
    const fake = new FakeBluez();
    fake.autoResolve = false;
    fake.overrides.set('Connect', () => {
      fake.setProp(DEVICE_PATH, 'org.bluez.Device1', 'Connected', ['b', true]);
      fake.setProp(DEVICE_PATH, 'org.bluez.Device1', 'ServicesResolved', ['b', true], false);
      return [];
    });
    const { transport } = setup(fake);
    await expect(transport.connect()).rejects.toThrow(/service 0000fff0-.* not found — is FC:58:FA:0F:C3:26 really a Cosori kettle\?/);
  });

  it('retries StartNotify once after NotPermitted', async () => {
    const fake = new FakeBluez();
    let attempts = 0;
    fake.overrides.set('StartNotify', () => {
      attempts++;
      if (attempts === 1) {
        throw new DbusError('org.bluez.Error.NotPermitted', 'Notify acquired');
      }
      return [];
    });
    const { transport } = setup(fake);
    await transport.connect();
    expect(attempts).toBe(2);
    expect(fake.members()).toContain('StopNotify');
    expect(transport.connected).toBe(true);
  });

  it('refuses a powered-off adapter', async () => {
    const { transport } = setup(new FakeBluez({ powered: false }));
    await expect(transport.connect()).rejects.toThrow(`Bluetooth adapter hci0 (${ADAPTER_MAC}) is powered off`);
  });

  it('refuses an adapter that is not there', async () => {
    const { transport } = setup(new FakeBluez(), { adapter: 'hci3' });
    await expect(transport.connect()).rejects.toBeInstanceOf(AdapterNotFoundError);
  });

  it('selects the adapter by MAC address', async () => {
    const { transport } = setup(new FakeBluez(), { adapter: ADAPTER_MAC.toLowerCase() });
    await transport.connect();
    expect(transport.connected).toBe(true);
  });
});

describe('BluezTransport events', () => {
  it('emits FFF1 notifications as data, copied out of the message buffer', async () => {
    const { fake, transport } = setup();
    const chunks: Buffer[] = [];
    transport.on('data', (chunk: Buffer) => chunks.push(chunk));
    await transport.connect();
    fake.notify(Buffer.from('a522010500', 'hex'));
    expect(chunks).toEqual([Buffer.from('a522010500', 'hex')]);
  });

  it('ignores property changes that are not a value', async () => {
    const { fake, transport } = setup();
    const chunks: Buffer[] = [];
    transport.on('data', (chunk: Buffer) => chunks.push(chunk));
    await transport.connect();
    fake.emitPropertiesChanged(RX_PATH, 'org.bluez.GattCharacteristic1', { Notifying: ['b', true] });
    expect(chunks).toEqual([]);
  });

  it('emits one disconnect when the link drops, and cleans up', async () => {
    const { fake, transport } = setup();
    let disconnects = 0;
    transport.on('disconnect', () => disconnects++);
    await transport.connect();
    fake.dropLink();
    await new Promise((resolve) => setImmediate(resolve));
    expect(disconnects).toBe(1);
    expect(transport.connected).toBe(false);
    expect(fake.subscriptionCount()).toBe(0);
    await expect(transport.write(Buffer.from([1]))).rejects.toThrow('not connected');
  });

  it('does not emit disconnect for an explicit disconnect()', async () => {
    const { fake, transport } = setup();
    let disconnects = 0;
    transport.on('disconnect', () => disconnects++);
    await transport.connect();
    await transport.disconnect();
    await new Promise((resolve) => setImmediate(resolve));
    expect(disconnects).toBe(0);
    expect(fake.members()).toEqual(expect.arrayContaining(['StopNotify', 'Disconnect']));
  });

  it('reconnects on the same D-Bus session after a drop', async () => {
    const { fake, transport, opened } = setup();
    await transport.connect();
    fake.dropLink();
    await new Promise((resolve) => setImmediate(resolve));
    await transport.connect();
    expect(transport.connected).toBe(true);
    expect(opened).toHaveLength(1);
  });

  it('fails fast when the D-Bus connection dies, then opens a new session', async () => {
    const buses = [new FakeBluez(), new FakeBluez()];
    buses[0]!.kill();
    let i = 0;
    const transport = new BluezTransport(KETTLE_MAC, { openBus: async () => buses[i++]! });
    await expect(transport.connect()).rejects.toThrow(/closed|failed/);
    await transport.connect();
    expect(transport.connected).toBe(true);
    expect(i).toBe(2);
    expect(buses[0]!.closed).toBe(true);
  });

  it('emits disconnect when the D-Bus connection dies while connected', async () => {
    const { fake, transport } = setup();
    let disconnects = 0;
    transport.on('disconnect', () => disconnects++);
    await transport.connect();
    fake.kill();
    await new Promise((resolve) => setImmediate(resolve));
    expect(disconnects).toBe(1);
    expect(transport.connected).toBe(false);
  });

  it('closes the bus on destroy', async () => {
    const { fake, transport } = setup();
    await transport.connect();
    await transport.destroy();
    expect(fake.closed).toBe(true);
    expect(transport.listenerCount('data')).toBe(0);
  });
});

describe('BluezTransport.readDeviceInfo', () => {
  it('reads the name and the Device Information strings, trimming NULs', async () => {
    const { transport } = setup();
    await transport.connect();
    expect(await transport.readDeviceInfo()).toEqual({
      address: KETTLE_MAC,
      name: 'Cosori Gooseneck Kettle',
      model: 'CS108-NK',
      manufacturer: undefined,
      hardwareRevision: '1.0.00',
      softwareRevision: 'R0007V0012',
    });
  });

  it('leaves fields undefined when a read fails', async () => {
    const fake = new FakeBluez();
    fake.overrides.set('ReadValue', () => {
      throw new DbusError('org.bluez.Error.NotPermitted', 'Read not permitted');
    });
    const { transport } = setup(fake);
    await transport.connect();
    expect(await transport.readDeviceInfo()).toMatchObject({ name: 'Cosori Gooseneck Kettle', model: undefined, softwareRevision: undefined });
  });
});

describe('BluezTransport static helpers', () => {
  it('lists adapters with power state and closes the session', async () => {
    const fake = new FakeBluez();
    expect(await BluezTransport.listAdapters({ openBus: async () => fake })).toEqual([{ name: 'hci0', address: ADAPTER_MAC, powered: true }]);
    expect(fake.closed).toBe(true);
  });

  it('scans and returns what BlueZ saw, reading before discovery stops', async () => {
    const fake = new FakeBluez();
    const results = await BluezTransport.scan({ openBus: async () => fake, durationMs: 10 });
    expect(results).toEqual([{ address: KETTLE_MAC, name: 'Cosori Gooseneck Kettle', rssi: -80, manufacturerIds: [0x06d0] }]);
    const members = fake.members();
    expect(members.lastIndexOf('GetManagedObjects')).toBeLessThan(members.indexOf('StopDiscovery'));
    expect(fake.closed).toBe(true);
  });
});
