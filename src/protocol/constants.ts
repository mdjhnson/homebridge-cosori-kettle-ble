/**
 * Cosori Smart Gooseneck Kettle BLE protocol constants.
 *
 * Protocol knowledge credit: barrymichels/CosoriKettleBLE and rygwdn/ha-cosori-kettle.
 * Values here were cross-checked against real captured packets, not only the upstream docs
 * (which contain known errors — see README "Protocol notes").
 */

export const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
/** Notifications from the kettle. */
export const RX_CHAR_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';
/** Commands to the kettle. */
export const TX_CHAR_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';

/** Standard Device Information Service characteristics (UTF-8 strings). */
export const DIS_SERVICE_UUID = '0000180a-0000-1000-8000-00805f9b34fb';
export const DIS_MODEL_NUMBER_UUID = '00002a24-0000-1000-8000-00805f9b34fb';
export const DIS_HARDWARE_REVISION_UUID = '00002a27-0000-1000-8000-00805f9b34fb';
export const DIS_SOFTWARE_REVISION_UUID = '00002a28-0000-1000-8000-00805f9b34fb';
export const DIS_MANUFACTURER_UUID = '00002a29-0000-1000-8000-00805f9b34fb';

/** Advertised local name observed on real kettles. */
export const ADVERTISED_NAME = 'Cosori Gooseneck Kettle';

/** Writes to FFF2 are split into chunks of this size with no extra framing. */
export const BLE_CHUNK_SIZE = 20;

export const FRAME_MAGIC = 0xa5;
export const HEADER_SIZE = 6;
export const MAX_PAYLOAD_SIZE = 512;

/** Frame types (header byte 1). */
export const FrameType = {
  /** Host commands; also kettle-originated compact status and completion frames. */
  MESSAGE: 0x22,
  /** Kettle ACKs, including the 29-byte extended status reply. */
  ACK: 0x12,
} as const;

/** Payload byte 0. */
export const ProtocolVersion = {
  V0: 0x00,
  V1: 0x01,
} as const;
export type ProtocolVersion = typeof ProtocolVersion[keyof typeof ProtocolVersion];

/** Payload byte 1. */
export const Cmd = {
  REGISTER: 0x80,
  HELLO: 0x81,
  POLL: 0x40,
  COMPACT_STATUS: 0x41,
  SET_MODE: 0xf0,
  DELAYED_START: 0xf1,
  SET_HOLD: 0xf2,
  SET_MY_TEMP: 0xf3,
  STOP: 0xf4,
  SET_BABY_FORMULA: 0xf5,
  COMPLETION: 0xf7,
} as const;

/** Payload byte 2 ("class"). */
export const CmdClass = {
  AUTH: 0xd1,
  CONTROL: 0xa3,
  STATUS: 0x40,
} as const;

/** Commands whose ACK carries a trailing status byte (00 = OK). */
export const COMMANDS_WITH_STATUS: ReadonlySet<number> = new Set([
  Cmd.REGISTER, Cmd.HELLO, Cmd.SET_MODE, Cmd.DELAYED_START, Cmd.SET_HOLD, Cmd.SET_MY_TEMP, Cmd.STOP, Cmd.SET_BABY_FORMULA,
]);

/** Heating modes used by SET_MODE (F0) and reported in status byte [5]. */
export const Mode = {
  NONE: 0x00,
  GREEN_TEA: 0x01,
  OOLONG: 0x02,
  COFFEE: 0x03,
  BOIL: 0x04,
  MY_BREW: 0x05,
  /** V0 firmware "heat to arbitrary temperature" mode (barrymichels). */
  HEAT_V0: 0x06,
} as const;
export type Mode = typeof Mode[keyof typeof Mode];

export const MODE_NAMES: Readonly<Record<number, string>> = {
  [Mode.NONE]: 'none',
  [Mode.GREEN_TEA]: 'green tea',
  [Mode.OOLONG]: 'oolong',
  [Mode.COFFEE]: 'coffee',
  [Mode.BOIL]: 'boil',
  [Mode.MY_BREW]: 'mybrew',
  [Mode.HEAT_V0]: 'heat (v0)',
};

/** Fixed preset target temperatures (°F). */
export const PRESET_TEMP_F: Readonly<Record<number, number>> = {
  [Mode.GREEN_TEA]: 180,
  [Mode.OOLONG]: 195,
  [Mode.COFFEE]: 205,
  [Mode.BOIL]: 212,
};

/** Status byte [4]. */
export const Stage = {
  IDLE: 0x00,
  HEATING: 0x01,
  ALMOST_DONE: 0x02,
  HOLDING: 0x03,
} as const;

export const STAGE_NAMES: Readonly<Record<number, string>> = {
  [Stage.IDLE]: 'idle',
  [Stage.HEATING]: 'heating',
  [Stage.ALMOST_DONE]: 'almost done',
  [Stage.HOLDING]: 'holding',
};

/** Completion notification codes (kettle → host, cmd F7). */
export const Completion = {
  HEATING_DONE: 0x20,
  HOLD_DONE: 0x21,
} as const;

/** Setpoint range accepted by the kettle (°F). */
export const MIN_SETPOINT_F = 104;
export const MAX_SETPOINT_F = 212;

/** Temperature readings outside this range are treated as invalid (°F). */
export const MIN_VALID_READING_F = 40;
export const MAX_VALID_READING_F = 230;

/** Documented maximum hold / keep-warm time (seconds). */
export const MAX_HOLD_SECONDS = 3600;

/** Registration keys are 16 bytes, sent as 32 lowercase ASCII hex characters. */
export const REGISTRATION_KEY_BYTES = 16;
