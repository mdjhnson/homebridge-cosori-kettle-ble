/**
 * Known-good packets captured from real Cosori Smart Gooseneck kettles, used as unit-test fixtures.
 *
 * Sources (credit to the original authors — see LICENSE "Third-party acknowledgements"):
 *   - rygwdn/ha-cosori-kettle: removed C++ port tests (tests/test_cpp.cpp @ f384906d), PROTOCOL.md,
 *     README key-capture section, and GitHub issue #8 debug logs.
 *   - barrymichels/CosoriKettleBLE: HANDSHAKE_EXTRACTION_GUIDE.md and hard-coded V0 frames in
 *     components/cosori_kettle_ble/cosori_kettle_ble.cpp.
 *
 * Every entry in the "good" lists passes the frame checksum. Entries in BAD_CHECKSUM_FRAMES are
 * examples from upstream docs that do NOT verify (hand-edited or mis-transcribed) and must be rejected.
 */

export interface TxFixture {
  name: string;
  hex: string;
  seq: number;
  /** Payload bytes after the 6-byte header. */
  payload: string;
}

export const TX_FRAMES: TxFixture[] = [
  { name: 'poll (seq 0x41)', hex: 'A5224104007201404000', seq: 0x41, payload: '01404000' },
  { name: 'compact status request (seq 0xB5)', hex: 'A522B50400FD01414000', seq: 0xb5, payload: '01414000' },
  { name: 'F0 coffee, no hold (seq 0x03)', hex: 'A5220309009501F0A3000300000000', seq: 0x03, payload: '01F0A3000300000000' },
  { name: 'F0 coffee, no hold (seq 0x48)', hex: 'A5224809005001F0A3000300000000', seq: 0x48, payload: '01F0A3000300000000' },
  { name: 'F4 stop (seq 0x04)', hex: 'A5220404009801F4A300', seq: 0x04, payload: '01F4A300' },
  { name: 'F3 set MyBrew 179°F (seq 0x1C)', hex: 'A5221C0500CD01F3A300B3', seq: 0x1c, payload: '01F3A300B3' },
  { name: 'F5 baby formula on (seq 0x25)', hex: 'A5222505007401F5A30001', seq: 0x25, payload: '01F5A30001' },
  { name: 'F5 baby formula off (seq 0x1D)', hex: 'A5221D05007D01F5A30000', seq: 0x1d, payload: '01F5A30000' },
  { name: 'F1 delayed start 3780 s, boil (seq 0x29)', hex: 'A522290B009901F1A300C40E0400000000', seq: 0x29, payload: '01F1A300C40E0400000000' },
];

export interface HelloFixture {
  name: string;
  /** The three BLE writes, in order (20 + 20 + 2 bytes). */
  chunks: [string, string, string];
  /** Registration key as 32 hex chars (decoded from the ASCII in the frame). */
  key: string;
  seq: number;
  version: 0 | 1;
  cmd: 'hello' | 'register';
}

export const HELLO_FRAMES: HelloFixture[] = [
  {
    name: 'VeSync app hello (barrymichels HANDSHAKE_EXTRACTION_GUIDE)',
    chunks: [
      'A5220424002E0181D10037663836383936326364',
      '6530353662363062353430333433336164343262',
      '6463',
    ],
    key: '7f868962cde056b60b5403433ad42bdc',
    seq: 0x04,
    version: 1,
    cmd: 'hello',
  },
  {
    name: 'ha-cosori-kettle hello (issue #8 log)',
    chunks: [
      'a522002400840181d10062613662356563386166',
      '6437626464613338636263306135366164663737',
      '3464',
    ],
    key: 'ba6b5ec8afd7bdda38cbc0a56adf774d',
    seq: 0x00,
    version: 1,
    cmd: 'hello',
  },
  {
    // Derived with the verified checksum from the C++ test key; not a capture.
    name: 'register (derived, C++ test key)',
    chunks: [
      'a522002400a50180d10039393033653031613363',
      '3362616138663663373163626235313637653764',
      '3566',
    ],
    key: '9903e01a3c3baa8f6c71cbb5167e7d5f',
    seq: 0x00,
    version: 1,
    cmd: 'register',
  },
];

/** barrymichels' hard-coded V0 hello (seq 0, checksum 0x8A) for his own kettle's key. */
export const BARRY_V0_HELLO = {
  key: '64287a917e746a0731166b76f43d5cbb',
  checksum: 0x8a,
};

export const ACK_FRAMES = [
  { name: 'ACK set-mytemp (no status byte)', hex: 'A5121C04009101F3A300', seq: 0x1c, command: 0xf3, status: undefined },
  { name: 'hello ACK accepted', hex: 'A512040500EC0181D10000', seq: 0x04, command: 0x81, status: 0x00 },
  { name: 'hello ACK key rejected (issue #8)', hex: 'a512000500ef0181d10001', seq: 0x00, command: 0x81, status: 0x01 },
];

export const COMPLETION_FRAMES = [
  { name: 'heating done', hex: 'A522980500E001F7A30020', code: 0x20 },
  { name: 'hold timer done', hex: 'A522E105009601F7A30021', code: 0x21 },
];

export interface CompactFixture {
  hex: string;
  stage: number;
  mode: number;
  setpointF: number;
  tempF: number;
}

export const COMPACT_FRAMES: CompactFixture[] = [
  { hex: 'A522B50C00B3014140000000B38F00000000', stage: 0, mode: 0, setpointF: 179, tempF: 143 },
  { hex: 'A5221F0C0073014140000000AF6900000000', stage: 0, mode: 0, setpointF: 175, tempF: 105 },
  { hex: 'A522200C008A014140000000AF5100000000', stage: 0, mode: 0, setpointF: 175, tempF: 81 },
  { hex: 'A522210C0088014140000000AF5100010000', stage: 0, mode: 0, setpointF: 175, tempF: 81 },
  { hex: 'A5221D0C0068014140000101B46F00000000', stage: 1, mode: 1, setpointF: 180, tempF: 111 },
  { hex: 'A5220B0C004B014140000104D47B00000000', stage: 1, mode: 4, setpointF: 212, tempF: 123 },
  { hex: 'A5226A0C00E7014140000000B4A500000000', stage: 0, mode: 0, setpointF: 180, tempF: 165 },
];

export interface ExtendedFixture {
  name: string;
  hex: string;
  stage: number;
  mode: number;
  setpointF: number;
  tempF: number;
  myTempF: number;
  configuredHoldSeconds: number;
  remainingHoldSeconds: number;
  onBase: boolean;
  babyFormula: boolean;
  /** [17–18]: last delayed-start delay (E4 = 3780 s, captured alongside the 3780 s F1 delayed start). */
  delaySetSeconds: number;
  delayRemainingSeconds: number;
}

export const EXTENDED_FRAMES: ExtendedFixture[] = [
  {
    name: 'E1 boiling',
    hex: 'a5:12:18:1d:00:a2:01:40:40:00:01:04:d4:7b:8c:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:08:07:00:00:01',
    stage: 1, mode: 4, setpointF: 212, tempF: 123, myTempF: 140, configuredHoldSeconds: 0, remainingHoldSeconds: 0, onBase: true, babyFormula: false,
    delaySetSeconds: 0, delayRemainingSeconds: 0,
  },
  {
    name: 'E2 green tea, holding (159 s of 300 s left)',
    hex: 'A512831D00B6014040000301B4B5AF012C019F00000000580200000000002C01000001',
    stage: 3, mode: 1, setpointF: 180, tempF: 181, myTempF: 175, configuredHoldSeconds: 300, remainingHoldSeconds: 159, onBase: true, babyFormula: false,
    delaySetSeconds: 600, delayRemainingSeconds: 0,
  },
  {
    name: 'E3 idle, baby formula on',
    hex: 'A5128B1D001401404000000068B2680000000000000000580200000000002C01010001',
    stage: 0, mode: 0, setpointF: 104, tempF: 178, myTempF: 104, configuredHoldSeconds: 0, remainingHoldSeconds: 0, onBase: true, babyFormula: true,
    delaySetSeconds: 600, delayRemainingSeconds: 0,
  },
  {
    name: 'E4 idle, off base',
    hex: 'A512401D0093014040000000AF69AF0000000000010000C40E00000000003408000001',
    stage: 0, mode: 0, setpointF: 175, tempF: 105, myTempF: 175, configuredHoldSeconds: 0, remainingHoldSeconds: 0, onBase: false, babyFormula: false,
    delaySetSeconds: 3780, delayRemainingSeconds: 0,
  },
  {
    name: 'E5 idle',
    hex: 'A512871D001601404000000068B5680000000000000000580200000000002C01000001',
    stage: 0, mode: 0, setpointF: 104, tempF: 181, myTempF: 104, configuredHoldSeconds: 0, remainingHoldSeconds: 0, onBase: true, babyFormula: false,
    delaySetSeconds: 600, delayRemainingSeconds: 0,
  },
  {
    name: 'E6 idle on base (PROTOCOL.md)',
    hex: 'a5:12:19:1d:00:10:01:40:40:00:00:00:d4:5c:8c:00:00:00:00:00:00:00:00:3c:69:00:00:00:00:01:10:0e:00:00:01',
    stage: 0, mode: 0, setpointF: 212, tempF: 92, myTempF: 140, configuredHoldSeconds: 0, remainingHoldSeconds: 0, onBase: true, babyFormula: false,
    delaySetSeconds: 26940, delayRemainingSeconds: 0,
  },
  {
    name: 'E7 idle off base (PROTOCOL.md)',
    hex: 'a5:12:1c:1d:00:0c:01:40:40:00:00:00:d4:5c:8c:00:00:00:00:00:01:00:00:3c:69:00:00:00:00:01:10:0e:00:00:01',
    stage: 0, mode: 0, setpointF: 212, tempF: 92, myTempF: 140, configuredHoldSeconds: 0, remainingHoldSeconds: 0, onBase: false, babyFormula: false,
    delaySetSeconds: 26940, delayRemainingSeconds: 0,
  },
  {
    name: 'E8 boiling with 60 min hold (PROTOCOL.md scenario 2)',
    hex: 'a5:12:23:1d:00:c4:01:40:40:00:01:04:d4:5c:8c:01:10:0e:10:0e:00:00:00:3c:69:00:00:00:00:01:10:0e:00:00:01',
    stage: 1, mode: 4, setpointF: 212, tempF: 92, myTempF: 140, configuredHoldSeconds: 3600, remainingHoldSeconds: 3600, onBase: true, babyFormula: false,
    delaySetSeconds: 26940, delayRemainingSeconds: 0,
  },
  {
    name: 'E9 lifted off base, heating stopped (PROTOCOL.md scenario 2)',
    hex: 'a5:12:25:1d:00:03:01:40:40:00:00:00:d4:5c:8c:00:00:00:00:00:01:00:00:3c:69:00:00:00:00:01:10:0e:00:00:01',
    stage: 0, mode: 0, setpointF: 212, tempF: 92, myTempF: 140, configuredHoldSeconds: 0, remainingHoldSeconds: 0, onBase: false, babyFormula: false,
    delaySetSeconds: 26940, delayRemainingSeconds: 0,
  },
];

/** Upstream doc examples whose checksums do not verify. The parser must reject them. */
export const BAD_CHECKSUM_FRAMES = [
  { name: 'PROTOCOL.md compact example (wrong length + checksum)', hex: 'a5:22:5e:04:00:2f:01:41:40:00:00:00:d4:64:8c:00:00:00' },
  { name: 'PROTOCOL.md 0x20 "start" frame', hex: 'a5:20:5f:0c:00:2e:01:41:40:00:01:00:d4:00:00:00:00:00' },
  { name: 'PROTOCOL.md 0x20 "stop" frame', hex: 'a5:20:60:0c:00:2f:01:41:40:00:00:00:d4:00:00:00:00:00' },
];

/**
 * PacketLogger text-export lines around a VeSync-app connection. The first line is verbatim from
 * barrymichels' HANDSHAKE_EXTRACTION_GUIDE.md; the others use the same layout with the HCI ACL +
 * L2CAP + ATT header bytes computed for each value (values are the guide's captured packets / ACK).
 * Note the truncated "Value:" column ("…") — the raw bytes at the end of the line are complete.
 */
export const PACKETLOGGER_EXPORT = [
  'Jan 04 08:02:40.512  HCI Event        0x0405  00:00:00:00:00:00  LE Meta Event - LE Connection Complete',
  'Jan 04 08:02:40.700  ATT Receive      0x0405  00:00:00:00:00:00  Read Response - Value: 436F 736F …  05 04 0B 00 07 00 04 00 0B 43 6F 73 6F 72 69',
  'Jan 04 08:02:40.876  ATT Send         0x0405  00:00:00:00:00:00  Write Request - Handle:0x000E - Value: A522 0424 002E 0181 D100 3766 3836 3839…  '
    + '05 04 1B 00 17 00 04 00 12 0E 00 A5 22 04 24 00 2E 01 81 D1 00 37 66 38 36 38 39 36 32 63 64',
  'Jan 04 08:02:40.890  ATT Receive      0x0405  00:00:00:00:00:00  Write Response  05 04 05 00 01 00 04 00 13',
  'Jan 04 08:02:40.920  ATT Send         0x0405  00:00:00:00:00:00  Write Request - Handle:0x000E - Value: 6530 3536 6236 3062 3534 3033 3433 3361…  '
    + '05 04 1B 00 17 00 04 00 12 0E 00 65 30 35 36 62 36 30 62 35 34 30 33 34 33 33 61 64 34 32 62',
  'Jan 04 08:02:40.981  ATT Send         0x0405  00:00:00:00:00:00  Write Request - Handle:0x000E - Value: 6463  05 04 09 00 05 00 04 00 12 0E 00 64 63',
  'Jan 04 08:02:41.040  ATT Receive      0x0405  00:00:00:00:00:00  Handle Value Notification - Handle:0x0010 - Value: A512 0405 00EC 0181 D100 00  '
    + '05 04 12 00 0E 00 04 00 1B 10 00 A5 12 04 05 00 EC 01 81 D1 00 00',
  'Jan 04 08:02:41.100  ATT Send         0x0405  00:00:00:00:00:00  Write Request - Handle:0x000E - Value: A522 4104 0072 0140 4000  '
    + '05 04 11 00 0D 00 04 00 12 0E 00 A5 22 41 04 00 72 01 40 40 00',
  'Jan 04 08:02:51.209  ATT Receive      0x0405  00:00:00:00:00:00  Handle Value Notification - Handle:0x0010 - Value: A522 6A0C 00E7 0141 4000 0000 B4A5…  '
    + '05 04 19 00 15 00 04 00 1B 10 00 A5 22 6A 0C 00 E7 01 41 40 00 00 00 B4 A5 00 00 00 00',
].join('\n');

/**
 * Frames captured from the maintainer's own kettle (HW 1.0.00 / SW R0007V0012, VeSync iOS app,
 * PacketLogger, 2026-09-23). Complete (non-truncated) values only; the registration key is omitted.
 */
export const OWN_KETTLE_FRAMES = {
  /** App "Start" on Green Tea with "Hold Temp: 30 min": hold 08 07 → 1800 s little-endian; byte[5] = 00. */
  startGreenTeaHold30: 'A5220309008701F0A3000100010807',
  /** App poll (seq 1). */
  poll: 'A522010400B201404000',
  /** Kettle ACKs to the app's two hellos (seq 0 and 2): status 00 = accepted. */
  helloAckSeq0: 'A512000500F00181D10000',
  helloAckSeq2: 'A512020500EE0181D10000',
  /** Kettle ACK to F0 start: 4-byte payload, no status byte. */
  startAck: 'A512030400AD01F0A300',
  /**
   * Extended status via the plugin (cosori-probe watch), idle on base at 125 °F, setpoint 180 °F,
   * MyBrew 140 °F. App showed "Hold Temp: On, 30 min": [23] = 01 and [24–25] = 08 07 (1800 s) while
   * the active-hold fields [10–13] are zero.
   */
  extendedIdleHoldDefault30: 'a5 12 01 1d 00 da 01 40 40 00 00 00 b4 7d 8c 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01 08 07 00 01 01',
  /** Pushed by the kettle the moment it was lifted: compact status with [9] = 01 (off-base, hypothesis). */
  compactLiftedOffBase: 'a5 22 44 0c 00 3c 01 41 40 00 00 00 b4 75 00 01 00 00',
  /** Next poll after lifting: extended [14] = 01 (off base). */
  extendedOffBase: 'a5 12 0c 1d 00 d6 01 40 40 00 00 00 b4 75 8c 00 00 00 00 00 01 00 00 00 00 00 00 00 00 01 08 07 00 01 01',
  /** Back on base. */
  extendedBackOnBase: 'a5 12 01 1d 00 e2 01 40 40 00 00 00 b4 75 8c 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01 08 07 00 01 01',
  /** App "Delay Start": Green Tea in 25 min with 30 min hold → delay DC 05 (1500 s LE) + F0 body. */
  delayStartGreen25Hold30: 'a5 22 04 0b 00 a2 01 f1 a3 00 dc 05 01 00 01 08 07',
  /** Kettle ACK to F1: header only, no status byte. */
  delayStartAck: 'a5 12 04 04 00 ab 01 f1 a3 00',
  /** Pushed right after F1: compact status stage 5 (delay scheduled), mode 1. */
  compactDelayScheduled: 'a5 22 45 0c 00 38 01 41 40 00 05 01 b4 72 01 00 00 00',
  /** App "Cancel" on a scheduled delay: plain F4 stop. */
  cancelDelayStop: 'a5 22 05 04 00 97 01 f4 a3 00',
  /** Kettle ACK to F4: header only. */
  stopAck: 'a5 12 05 04 00 a7 01 f4 a3 00',
  /** Pushed after cancel: back to idle. */
  compactAfterCancel: 'a5 22 46 0c 00 3e 01 41 40 00 00 00 b4 72 00 00 00 00',
  /** Plugin-sent F1 (probe `delay … 5 green --hold-min 30`): 300 s delay, green tea, hold 1800 s. */
  pluginDelayStart5min: 'a5 22 02 0b 00 58 01 f1 a3 00 2c 01 01 00 01 08 07',
  /** Poll while scheduled: stage 5, hold 1800/1800, [17–18] = 300 s set, [19–20] = 297 s remaining. */
  extendedScheduled297: 'a5 12 03 1d 00 70 01 40 40 00 05 01 b4 69 8c 01 08 07 08 07 00 00 00 2c 01 29 01 00 00 01 08 07 00 01 01',
  extendedScheduled290: 'a5 12 05 1d 00 75 01 40 40 00 05 01 b4 69 8c 01 08 07 08 07 00 00 00 2c 01 22 01 00 00 01 08 07 00 01 01',
  /** Poll after cancel: idle, [17–18] keeps the last delay (300 s), [19–20] = 0. */
  extendedAfterCancel: 'a5 12 07 1d 00 bb 01 40 40 00 00 00 b4 69 8c 00 00 00 00 00 00 00 00 2c 01 00 00 00 00 01 08 07 00 01 01',
};
