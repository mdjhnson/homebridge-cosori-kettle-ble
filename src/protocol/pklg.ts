/**
 * Reader for Apple PacketLogger `.pklg` capture files (the format PacketLogger saves natively).
 *
 * Record layout (see Wireshark wiretap/packetlogger.c):
 *   len (u32) | ts_secs (u32) | ts_usecs (u32) | type (u8) | data[len - 9]
 * `len` counts the 8 timestamp bytes, the type byte and the data. Files exist in both byte orders;
 * like Wireshark we detect big-endian when the first length read as little-endian has only its upper
 * 16 bits set.
 *
 * Types 0x02 / 0x03 are HCI ACL data sent / received:
 *   handle+flags (u16 LE) | length (u16 LE) | L2CAP length (u16 LE) | CID (u16 LE) | ATT PDU
 * ACL fragments (packet-boundary flag 0b01 = continuation) are reassembled per connection handle.
 */

export const PKLG_TYPE = {
  HCI_COMMAND: 0x00,
  HCI_EVENT: 0x01,
  SENT_ACL: 0x02,
  RECV_ACL: 0x03,
} as const;

export interface PklgRecord {
  type: number;
  timestampMs: number;
  data: Buffer;
}

export interface AttPdu {
  direction: 'tx' | 'rx';
  connectionHandle: number;
  opcode: number;
  attHandle: number;
  value: Buffer;
  timestampMs: number;
}

const L2CAP_ATT_CID = 0x0004;

/** Parse records. Returns undefined if the data is not a well-formed PacketLogger file. */
export function parsePklgRecords(buf: Buffer, limit = Infinity): PklgRecord[] | undefined {
  if (buf.length < 13) {
    return undefined;
  }
  const first = buf.readUInt32LE(0);
  const bigEndian = (first & 0xffff) === 0 && (first >>> 16) !== 0;
  const u32 = (at: number) => (bigEndian ? buf.readUInt32BE(at) : buf.readUInt32LE(at));

  const records: PklgRecord[] = [];
  let pos = 0;
  while (pos < buf.length && records.length < limit) {
    if (pos + 12 > buf.length) {
      return records.length > 0 ? records : undefined; // truncated tail
    }
    const len = u32(pos);
    const secs = u32(pos + 4);
    const usecs = u32(pos + 8);
    if (len < 8 || len >= 65536 || usecs >= 1_000_000 || pos + 4 + len > buf.length) {
      return records.length > 0 && pos + 4 + len > buf.length ? records : undefined;
    }
    if (len > 8) {
      records.push({
        type: buf[pos + 12]!,
        timestampMs: secs * 1000 + Math.floor(usecs / 1000),
        data: buf.subarray(pos + 13, pos + 4 + len),
      });
    }
    pos += 4 + len;
  }
  return records;
}

/** Quick check used to decide whether a file is a PacketLogger capture rather than a text export. */
export function looksLikePklg(buf: Buffer): boolean {
  return parsePklgRecords(buf, 8) !== undefined;
}

/** Extract ATT PDUs from the ACL records, reassembling fragmented L2CAP frames. */
export function extractAttPdus(records: PklgRecord[]): AttPdu[] {
  const pdus: AttPdu[] = [];
  const partial = new Map<string, { expected: number; chunks: Buffer[]; received: number; timestampMs: number }>();

  for (const rec of records) {
    if (rec.type !== PKLG_TYPE.SENT_ACL && rec.type !== PKLG_TYPE.RECV_ACL) {
      continue;
    }
    const direction = rec.type === PKLG_TYPE.SENT_ACL ? 'tx' : 'rx';
    const d = rec.data;
    if (d.length < 4) {
      continue;
    }
    const handleField = d.readUInt16LE(0);
    const connectionHandle = handleField & 0x0fff;
    const boundary = (handleField >> 12) & 0x3;
    const aclLen = d.readUInt16LE(2);
    const payload = d.subarray(4, 4 + aclLen);
    const key = `${direction}:${connectionHandle}`;

    let l2cap: Buffer | undefined;
    let timestampMs = rec.timestampMs;
    if (boundary === 0b01) {
      const p = partial.get(key);
      if (!p) {
        continue;
      }
      p.chunks.push(payload);
      p.received += payload.length;
      if (p.received < p.expected) {
        continue;
      }
      l2cap = Buffer.concat(p.chunks);
      timestampMs = p.timestampMs;
      partial.delete(key);
    } else {
      if (payload.length < 4) {
        continue;
      }
      const expected = payload.readUInt16LE(0) + 4;
      if (payload.length < expected) {
        partial.set(key, { expected, chunks: [payload], received: payload.length, timestampMs });
        continue;
      }
      l2cap = payload;
    }

    const l2capLen = l2cap.readUInt16LE(0);
    const cid = l2cap.readUInt16LE(2);
    if (cid !== L2CAP_ATT_CID || l2capLen < 3) {
      continue;
    }
    const att = l2cap.subarray(4, 4 + l2capLen);
    pdus.push({
      direction,
      connectionHandle,
      opcode: att[0]!,
      attHandle: att.length >= 3 ? att.readUInt16LE(1) : 0,
      value: Buffer.from(att.subarray(3)),
      timestampMs,
    });
  }
  return pdus;
}
