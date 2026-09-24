import { describe, expect, it } from 'vitest';

import {
  buildFrame, commandFrame, decodeMessage, extractAttPdus, findHandshakesInPklg, fromHex, keyToHex, looksLikePklg, Mode, parseFrame,
  parsePklgRecords, ProtocolVersion, setModePayload, splitIntoChunks,
} from '../../src/protocol/index.js';
import { HELLO_FRAMES, OWN_KETTLE_FRAMES } from '../fixtures/captures.js';

type Endian = 'le' | 'be';

function record(type: number, data: Buffer, endian: Endian, secs = 1_790_000_000, usecs = 0): Buffer {
  const hdr = Buffer.alloc(13);
  const len = 8 + 1 + data.length;
  if (endian === 'le') {
    hdr.writeUInt32LE(len, 0);
    hdr.writeUInt32LE(secs, 4);
    hdr.writeUInt32LE(usecs, 8);
  } else {
    hdr.writeUInt32BE(len, 0);
    hdr.writeUInt32BE(secs, 4);
    hdr.writeUInt32BE(usecs, 8);
  }
  hdr[12] = type;
  return Buffer.concat([hdr, data]);
}

/** HCI ACL packet carrying one ATT PDU (first, non-flushable fragment). */
function acl(connHandle: number, opcode: number, attHandle: number, value: Buffer): Buffer {
  const att = Buffer.concat([Buffer.from([opcode, attHandle & 0xff, attHandle >> 8]), value]);
  const l2cap = Buffer.concat([Buffer.from([att.length & 0xff, att.length >> 8, 0x04, 0x00]), att]);
  const handleField = (connHandle & 0x0fff) | (0b10 << 12);
  return Buffer.concat([Buffer.from([handleField & 0xff, handleField >> 8, l2cap.length & 0xff, l2cap.length >> 8]), l2cap]);
}

const TX = 0x02;
const RX = 0x03;

function appConnectionCapture(endian: Endian): Buffer {
  const h = HELLO_FRAMES[0]!;
  const recs: Buffer[] = [
    record(0xfc, Buffer.from('Product: iPhone17,1\0', 'ascii'), endian),
    record(0x01, Buffer.from([0x3e, 0x13, 0x0a, 0x00]), endian), // some HCI event
    record(TX, acl(0x58, 0x0a, 0x0009, Buffer.alloc(0)), endian), // Read Request (ignored)
    record(RX, acl(0x58, 0x0b, 0x0000, Buffer.from('1.0.00')), endian), // Read Response (ignored)
    record(TX, acl(0x58, 0x12, 0x0011, Buffer.from([0x01, 0x00])), endian), // CCCD write
    ...h.chunks.map((c, i) => record(TX, acl(0x58, 0x12, 0x000e, fromHex(c)), endian, 1_790_000_001, i * 1000)),
    record(RX, acl(0x58, 0x13, 0x0000, Buffer.alloc(0)), endian), // Write Response
    record(RX, acl(0x58, 0x1b, 0x0010, fromHex('A512040500EC0181D10000')), endian), // hello ACK accepted
    record(TX, acl(0x58, 0x12, 0x000e, fromHex(OWN_KETTLE_FRAMES.poll)), endian),
  ];
  return Buffer.concat(recs);
}

describe('pklg reader', () => {
  it.each(['le', 'be'] as const)('parses records (%s)', (endian) => {
    const records = parsePklgRecords(appConnectionCapture(endian));
    expect(records).toHaveLength(11);
    expect(records![0]!.type).toBe(0xfc);
  });

  it.each(['le', 'be'] as const)('finds the app hello and the accepting ACK (%s)', (endian) => {
    const result = findHandshakesInPklg(appConnectionCapture(endian));
    expect(result.handshakes).toHaveLength(1);
    expect(keyToHex(result.handshakes[0]!.key)).toBe(HELLO_FRAMES[0]!.key);
    expect(result.handshakes[0]).toMatchObject({ command: 'hello', seq: 4, ackStatus: 0 });
    expect(result.writeLines).toBe(5);
  });

  it('extracts only ATT on CID 0x0004 and keeps direction', () => {
    const pdus = extractAttPdus(parsePklgRecords(appConnectionCapture('le'))!);
    expect(pdus.filter((p) => p.direction === 'tx' && p.opcode === 0x12 && p.attHandle === 0x000e)).toHaveLength(4);
    expect(pdus.find((p) => p.opcode === 0x1b)!.value.toString('hex')).toBe('a512040500ec0181d10000');
  });

  it('reassembles a fragmented ACL packet', () => {
    const full = acl(0x58, 0x12, 0x000e, fromHex(HELLO_FRAMES[0]!.chunks[0]));
    // split after 10 bytes: first fragment keeps the ACL header (len adjusted), continuation gets PB=01
    const payload = full.subarray(4);
    const first = Buffer.concat([Buffer.from([full[0]!, full[1]!, 10, 0]), payload.subarray(0, 10)]);
    const contHandle = (0x58 & 0x0fff) | (0b01 << 12);
    const rest = payload.subarray(10);
    const cont = Buffer.concat([Buffer.from([contHandle & 0xff, contHandle >> 8, rest.length, 0]), rest]);
    const pdus = extractAttPdus(parsePklgRecords(Buffer.concat([record(TX, first, 'le'), record(TX, cont, 'le')]))!);
    expect(pdus).toHaveLength(1);
    expect(pdus[0]!.value.toString('hex')).toBe(HELLO_FRAMES[0]!.chunks[0].toLowerCase());
  });

  it('rejects text and random data', () => {
    expect(looksLikePklg(Buffer.from('Sep 23 19:45:04.277  Note  0x0000  Product: iPhone17,1\n'))).toBe(false);
    expect(looksLikePklg(Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBe(false);
    expect(() => findHandshakesInPklg(Buffer.from('hello'))).toThrow(/not a valid/);
  });

  it('accepts a capture whose last record is truncated', () => {
    const buf = appConnectionCapture('le');
    expect(parsePklgRecords(buf.subarray(0, buf.length - 3))!.length).toBe(10);
  });
});

describe('frames from the maintainer\'s kettle (HW 1.0.00 / SW R0007V0012)', () => {
  it('app Start Green Tea with 30 min hold proves the F0 hold field is little-endian', () => {
    const frame = parseFrame(fromHex(OWN_KETTLE_FRAMES.startGreenTeaHold30));
    expect(frame).toBeDefined();
    expect([...frame!.payload]).toEqual([0x01, 0xf0, 0xa3, 0x00, 0x01, 0x00, 0x01, 0x08, 0x07]);
    expect(frame!.payload.readUInt16LE(7)).toBe(1800);
    // Our builder produces the identical frame.
    const built = commandFrame(0x03, setModePayload(ProtocolVersion.V1, Mode.GREEN_TEA, { holdSeconds: 1800 }));
    expect(built).toEqual(fromHex(OWN_KETTLE_FRAMES.startGreenTeaHold30));
  });

  it('decodes the kettle ACKs', () => {
    for (const hex of [OWN_KETTLE_FRAMES.helloAckSeq0, OWN_KETTLE_FRAMES.helloAckSeq2]) {
      expect(decodeMessage(parseFrame(fromHex(hex))!)).toEqual({ kind: 'ack', command: 0x81, status: 0 });
    }
    expect(decodeMessage(parseFrame(fromHex(OWN_KETTLE_FRAMES.startAck))!)).toEqual({ kind: 'ack', command: 0xf0, status: undefined });
  });

  it('decodes an idle extended status read by the plugin', () => {
    const frame = parseFrame(fromHex(OWN_KETTLE_FRAMES.extendedIdleHoldDefault30))!;
    expect(frame.payload).toHaveLength(29);
    expect(decodeMessage(frame)).toEqual({
      kind: 'extended', stage: 0, mode: 0, setpointF: 180, tempF: 125, myTempF: 140,
      configuredHoldSeconds: 0, remainingHoldSeconds: 0, onBase: true, babyFormula: false,
    });
    // Saved "Hold Temp" duration from the app (30 min) lives at [24–25], little-endian.
    expect(frame.payload.readUInt16LE(24)).toBe(1800);
  });

  it('lift test: pushed compact frame, then extended on-base false, then true again', () => {
    const lifted = parseFrame(fromHex(OWN_KETTLE_FRAMES.compactLiftedOffBase))!;
    expect(decodeMessage(lifted)).toEqual({ kind: 'compact', stage: 0, mode: 0, setpointF: 180, tempF: 117 });
    expect(lifted.payload[9]).toBe(0x01);
    expect(decodeMessage(parseFrame(fromHex(OWN_KETTLE_FRAMES.extendedOffBase))!)).toMatchObject({ kind: 'extended', onBase: false, tempF: 117 });
    expect(decodeMessage(parseFrame(fromHex(OWN_KETTLE_FRAMES.extendedBackOnBase))!)).toMatchObject({ kind: 'extended', onBase: true });
  });

  it('app poll matches our poll builder', () => {
    expect(buildFrame(0x22, 0x01, Buffer.from([0x01, 0x40, 0x40, 0x00]))).toEqual(fromHex(OWN_KETTLE_FRAMES.poll));
    expect(splitIntoChunks(fromHex(OWN_KETTLE_FRAMES.poll))).toHaveLength(1);
  });
});
