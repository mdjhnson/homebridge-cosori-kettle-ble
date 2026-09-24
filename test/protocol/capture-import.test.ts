import { describe, expect, it } from 'vitest';

import { findHandshakesInLog, fromHex, keyFromHelloPackets, keyToHex, stripAttHeader } from '../../src/protocol/index.js';
import { HELLO_FRAMES, PACKETLOGGER_EXPORT } from '../fixtures/captures.js';

const APP_KEY = '7f868962cde056b60b5403433ad42bdc';

describe('stripAttHeader', () => {
  it('strips HCI ACL + L2CAP + ATT write header', () => {
    const raw = fromHex('05 04 09 00 05 00 04 00 12 0E 00 64 63');
    expect(stripAttHeader(raw).toString('hex')).toBe('6463');
  });

  it('strips an L2CAP + ATT header without the HCI part', () => {
    expect(stripAttHeader(fromHex('05 00 04 00 52 0E 00 64 63')).toString('hex')).toBe('6463');
  });

  it('strips a notification header', () => {
    const raw = fromHex('05 04 12 00 0E 00 04 00 1B 10 00 A5 12 04 05 00 EC 01 81 D1 00 00');
    expect(stripAttHeader(raw).toString('hex')).toBe('a512040500ec0181d10000');
  });

  it('strips a bare ATT PDU prefix', () => {
    expect(stripAttHeader(fromHex('12 0E 00 A5 22 41 04 00 72 01 40 40 00')).toString('hex')).toBe('a5224104007201404000');
  });

  it('leaves plain values untouched', () => {
    for (const h of HELLO_FRAMES) {
      for (const chunk of h.chunks) {
        expect(stripAttHeader(fromHex(chunk)).toString('hex')).toBe(chunk.toLowerCase());
      }
    }
  });

  it('does not strip when the length field does not match', () => {
    const raw = fromHex('05 04 09 00 06 00 04 00 12 0E 00 64 63');
    expect(stripAttHeader(raw)).toEqual(raw);
  });
});

describe('keyFromHelloPackets with capture headers', () => {
  const withHeaders = [
    '05 04 1B 00 17 00 04 00 12 0E 00 A5 22 04 24 00 2E 01 81 D1 00 37 66 38 36 38 39 36 32 63 64',
    '05 04 1B 00 17 00 04 00 12 0E 00 65 30 35 36 62 36 30 62 35 34 30 33 34 33 33 61 64 34 32 62',
    '05 04 09 00 05 00 04 00 12 0E 00 64 63',
  ];

  it('accepts PacketLogger raw bytes for all three packets', () => {
    expect(keyToHex(keyFromHelloPackets(withHeaders))).toBe(APP_KEY);
  });

  it('accepts a mix of raw and value-only packets', () => {
    expect(keyToHex(keyFromHelloPackets([withHeaders[0]!, HELLO_FRAMES[0]!.chunks[1], withHeaders[2]!]))).toBe(APP_KEY);
  });

  it('rejects the truncated Value column with a clear message', () => {
    expect(() => keyFromHelloPackets(['A522 0424 002E 0181 D100 3766 3836 3839…', '6530', '6463'])).toThrow(/truncated/);
  });

  it('rejects a mistyped byte (checksum)', () => {
    const bad = withHeaders[1]!.replace('35 36 62', '35 36 63');
    expect(() => keyFromHelloPackets([withHeaders[0]!, bad, withHeaders[2]!])).toThrow(/no valid hello/);
  });
});

describe('findHandshakesInLog', () => {
  it('finds the hello in a PacketLogger export and confirms the kettle accepted it', () => {
    const result = findHandshakesInLog(PACKETLOGGER_EXPORT);
    expect(result.writeLines).toBe(4);
    expect(result.notifyLines).toBe(2);
    expect(result.handshakes).toHaveLength(1);
    const [h] = result.handshakes;
    expect(keyToHex(h!.key)).toBe(APP_KEY);
    expect(h).toMatchObject({ command: 'hello', seq: 0x04, protocolVersion: 1, ackStatus: 0 });
  });

  it('reports a rejected key when the ACK status is 01', () => {
    const rejected = PACKETLOGGER_EXPORT.replace(
      '05 04 12 00 0E 00 04 00 1B 10 00 A5 12 04 05 00 EC 01 81 D1 00 00',
      '05 04 12 00 0E 00 04 00 1B 10 00 A5 12 04 05 00 EB 01 81 D1 00 01',
    );
    expect(findHandshakesInLog(rejected).handshakes[0]!.ackStatus).toBe(1);
  });

  it('leaves ackStatus undefined when the reply is not in the log', () => {
    const noReply = PACKETLOGGER_EXPORT.split('\n').filter((l) => !l.includes('A512 0405')).join('\n');
    expect(findHandshakesInLog(noReply).handshakes[0]!.ackStatus).toBeUndefined();
  });

  it('handles CRLF line endings', () => {
    expect(findHandshakesInLog(PACKETLOGGER_EXPORT.replace(/\n/g, '\r\n')).handshakes).toHaveLength(1);
  });

  it('returns nothing (with counts) for a log without the handshake', () => {
    const result = findHandshakesInLog('Jan 04 08:02:40.512  HCI Event  LE Connection Complete\nsomething else');
    expect(result).toEqual({ handshakes: [], writeLines: 0, notifyLines: 0, truncatedWrites: 0 });
  });
});
