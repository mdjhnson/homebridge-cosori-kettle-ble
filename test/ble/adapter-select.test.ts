import { describe, expect, it } from 'vitest';

import { AdapterNotFoundError, type AdapterSource, formatAdapters, isAdapterAddress, selectAdapter } from '../../src/ble/NodeBleTransport.js';

interface FakeAdapter {
  name: string;
  getAddress(): Promise<string>;
}

/** Stand-in for node-ble's Bluetooth object: adapters in BlueZ order, with their controller addresses. */
function source(adapters: Record<string, string | Error>): AdapterSource<FakeAdapter> {
  return {
    adapters: async () => Object.keys(adapters),
    getAdapter: async (name) => ({
      name,
      getAddress: async () => {
        const address = adapters[name];
        if (address === undefined || address instanceof Error) {
          throw address ?? new Error(`no adapter ${name}`);
        }
        return address;
      },
    }),
  };
}

const ONBOARD = 'D8:3A:DD:00:00:01';
const USB = '00:1A:7D:DA:71:13';

describe('isAdapterAddress', () => {
  it('recognises MAC addresses in either case and with dashes, but not hciN names', () => {
    expect(isAdapterAddress(USB)).toBe(true);
    expect(isAdapterAddress('00-1a-7d-da-71-13')).toBe(true);
    expect(isAdapterAddress('hci1')).toBe(false);
    expect(isAdapterAddress('00:1A:7D')).toBe(false);
  });
});

describe('selectAdapter', () => {
  it('uses the first adapter when none is configured', async () => {
    const sel = await selectAdapter(source({ hci0: ONBOARD, hci1: USB }), undefined);
    expect(sel).toMatchObject({ name: 'hci0', address: ONBOARD });
    expect(sel.all).toEqual([{ name: 'hci0', address: ONBOARD }, { name: 'hci1', address: USB.toUpperCase() }]);
  });

  it('selects by hciN name', async () => {
    expect((await selectAdapter(source({ hci0: ONBOARD, hci1: USB }), 'hci1')).address).toBe(USB);
  });

  it('selects by MAC, case- and separator-insensitively, whatever its hciN number is', async () => {
    // After a reboot the USB adapter may enumerate first and become hci0.
    const sel = await selectAdapter(source({ hci0: USB.toLowerCase(), hci1: ONBOARD }), '00-1a-7d-da-71-13');
    expect(sel).toMatchObject({ name: 'hci0', address: USB });
  });

  it('lists the available adapters when the configured one is missing', async () => {
    const run = selectAdapter(source({ hci0: ONBOARD }), USB);
    await expect(run).rejects.toBeInstanceOf(AdapterNotFoundError);
    await expect(run).rejects.toThrow(`Bluetooth adapter "${USB}" not found. Available: hci0 (${ONBOARD})`);
    await expect(selectAdapter(source({ hci0: ONBOARD }), 'hci1')).rejects.toThrow(/"hci1" not found/);
  });

  it('fails clearly when BlueZ has no adapters at all', async () => {
    await expect(selectAdapter(source({}), undefined)).rejects.toThrow(/no Bluetooth adapters found/);
  });

  it('still selects by name when an adapter\'s address can\'t be read', async () => {
    const sel = await selectAdapter(source({ hci0: new Error('gone'), hci1: USB }), 'hci0');
    expect(sel).toMatchObject({ name: 'hci0', address: undefined });
    expect(formatAdapters(sel.all)).toBe(`hci0, hci1 (${USB})`);
  });
});
