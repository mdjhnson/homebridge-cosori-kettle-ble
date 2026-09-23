import { describe, expect, it } from 'vitest';

import {
  detectProtocolVersion, generateKey, isValidKeyString, keyFromHelloPackets, keyToAscii, keyToHex, parseKey, ProtocolVersion,
} from '../../src/protocol/index.js';
import { HELLO_FRAMES } from '../fixtures/captures.js';

describe('registration key', () => {
  it('parses plain, upper-case and separated keys', () => {
    const expected = '0123456789abcdef0fedcba987654321';
    expect(keyToHex(parseKey('0123456789ABCDEF0FEDCBA987654321'))).toBe(expected);
    expect(keyToHex(parseKey('01:23:45:67:89:ab:cd:ef:0f:ed:cb:a9:87:65:43:21'))).toBe(expected);
    expect(keyToHex(parseKey('  0123456789abcdef 0fedcba987654321 '))).toBe(expected);
  });

  it.each(['', 'abc', '0123456789abcdef0fedcba98765432', '0123456789abcdef0fedcba9876543210'])('rejects %j', (k) => {
    expect(() => parseKey(k)).toThrow();
    expect(isValidKeyString(k)).toBe(false);
  });

  it('sends the key as 32 lowercase ASCII hex characters', () => {
    const ascii = keyToAscii(parseKey('0123456789ABCDEF0FEDCBA987654321'));
    expect(ascii.toString('ascii')).toBe('0123456789abcdef0fedcba987654321');
    expect(ascii.length).toBe(32);
  });

  it('generates random 16-byte keys', () => {
    const a = generateKey();
    const b = generateKey();
    expect(a.length).toBe(16);
    expect(a.equals(b)).toBe(false);
  });

  it.each(HELLO_FRAMES)('extracts key from captured packets: $name', (h) => {
    expect(keyToHex(keyFromHelloPackets([...h.chunks]))).toBe(h.key);
  });

  it('ignores an ATT header prefix pasted from PacketLogger', () => {
    const h = HELLO_FRAMES[0]!;
    expect(keyToHex(keyFromHelloPackets([`12 0e 00 ${h.chunks[0]}`, h.chunks[1], h.chunks[2]]))).toBe(h.key);
  });

  it('refuses packets in the wrong order / incomplete', () => {
    const h = HELLO_FRAMES[0]!;
    expect(() => keyFromHelloPackets([h.chunks[1], h.chunks[0], h.chunks[2]])).toThrow();
    expect(() => keyFromHelloPackets([h.chunks[0], h.chunks[1]])).toThrow();
  });
});

describe('detectProtocolVersion', () => {
  it.each([
    ['1.0.00', 'R0007V0012', ProtocolVersion.V1],
    ['1.0.00', 'R0006V0001', ProtocolVersion.V1],
    [undefined, 'R0007V0012', ProtocolVersion.V1],
    [undefined, 'R0008V0001', ProtocolVersion.V1],
    [undefined, 'R0007V0011', ProtocolVersion.V0],
    ['0.9.00', 'R0006V0003', ProtocolVersion.V0],
    ['0.9.00', undefined, ProtocolVersion.V0],
    [undefined, undefined, ProtocolVersion.V1],
    ['garbage', 'garbage', ProtocolVersion.V1],
  ] as const)('HW %s / SW %s → %i', (hw, sw, expected) => {
    expect(detectProtocolVersion(hw, sw)).toBe(expected);
  });
});
