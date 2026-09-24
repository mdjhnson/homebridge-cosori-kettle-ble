/**
 * Payload builders for every documented host → kettle command.
 *
 * ONLY commands documented by the prior-art projects are implemented. Do not add exploratory
 * writes to FFF2.
 *
 * Every payload starts with a 4-byte header: [protocolVersion][cmd][class][0x00].
 * Frames are always sent with frame type 0x22 (FrameType.MESSAGE).
 */
import {
  Cmd, CmdClass, FrameType, MAX_HOLD_SECONDS, MAX_SETPOINT_F, MIN_SETPOINT_F, Mode, ProtocolVersion,
} from './constants.js';
import { buildFrame } from './frame.js';
import { keyToAscii } from './key.js';

export type ByteOrder = 'le' | 'be';

function header(version: ProtocolVersion, cmd: number, cls: number): number[] {
  return [version, cmd, cls, 0x00];
}

function u16(value: number, order: ByteOrder): [number, number] {
  const lo = value & 0xff;
  const hi = (value >> 8) & 0xff;
  return order === 'le' ? [lo, hi] : [hi, lo];
}

export function clampSetpointF(tempF: number): number {
  return Math.min(MAX_SETPOINT_F, Math.max(MIN_SETPOINT_F, Math.round(tempF)));
}

function checkHoldSeconds(holdSeconds: number): number {
  if (!Number.isInteger(holdSeconds) || holdSeconds < 0 || holdSeconds > MAX_HOLD_SECONDS) {
    throw new RangeError(`hold time must be an integer 0–${MAX_HOLD_SECONDS} seconds (got ${holdSeconds})`);
  }
  return holdSeconds;
}

/** Register a new client key (kettle must be in pairing mode: hold the MyBrew button). */
export function registerPayload(version: ProtocolVersion, key: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(header(version, Cmd.REGISTER, CmdClass.AUTH)), keyToAscii(key)]);
}

/** Authenticate with a previously registered key. Must be the first command after connecting. */
export function helloPayload(version: ProtocolVersion, key: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(header(version, Cmd.HELLO, CmdClass.AUTH)), keyToAscii(key)]);
}

/** Request the 29-byte extended status (reply arrives as an ACK frame, type 0x12). */
export function pollPayload(version: ProtocolVersion): Buffer {
  return Buffer.from(header(version, Cmd.POLL, CmdClass.STATUS));
}

/** Request the 12-byte compact status. */
export function compactStatusPayload(version: ProtocolVersion): Buffer {
  return Buffer.from(header(version, Cmd.COMPACT_STATUS, CmdClass.STATUS));
}

/** Set the stored MyBrew temperature (°F, clamped to 104–212). Does not start heating. */
export function setMyTempPayload(version: ProtocolVersion, tempF: number): Buffer {
  return Buffer.from([...header(version, Cmd.SET_MY_TEMP, CmdClass.CONTROL), clampSetpointF(tempF)]);
}

/**
 * Set keep-warm / hold time. 0 disables hold.
 * Layout: [hdr] 00 EN LO HI — seconds little-endian (confirmed by barrymichels' working V0 code
 * `00 F2 A3 00 00 01 10 0E` = enable, 3600 s).
 */
export function setHoldPayload(version: ProtocolVersion, holdSeconds: number): Buffer {
  const secs = checkHoldSeconds(holdSeconds);
  return Buffer.from([...header(version, Cmd.SET_HOLD, CmdClass.CONTROL), 0x00, secs > 0 ? 1 : 0, ...u16(secs, 'le')]);
}

export interface SetModeOptions {
  /**
   * Byte [5]. The VeSync app sends 0x00 for presets (verified: coffee `…F0 A3 00 03 00 00 00 00`,
   * green tea `…F0 A3 00 01 00 01 08 07`); ha-cosori-kettle and barrymichels (V0) send the target °F.
   * Default: 0x00 for presets, the target temperature for MyBrew / V0 heat.
   */
  tempF?: number;
  /** Keep-warm after reaching temperature, seconds (0 = off). */
  holdSeconds?: number;
  /**
   * Byte order of the hold field. Little-endian, verified from a VeSync-app capture (Green Tea, 30 min
   * hold → `01 00 01 08 07`, 0x0708 = 1800 s). ha-cosori-kettle sends big-endian, which is wrong.
   * 'be' exists only for diagnostics.
   */
  holdByteOrder?: ByteOrder;
}

/**
 * Start heating in a mode. Layout: [hdr] MM TT EN H0 H1
 * For MyBrew, send SET_MY_TEMP first; F0's temperature byte alone is not known to set it.
 */
export function setModePayload(version: ProtocolVersion, mode: number, options: SetModeOptions = {}): Buffer {
  if (!Object.values(Mode).includes(mode as Mode) || mode === Mode.NONE) {
    throw new RangeError(`unknown mode 0x${mode.toString(16)}`);
  }
  const hold = checkHoldSeconds(options.holdSeconds ?? 0);
  const isPreset = mode === Mode.GREEN_TEA || mode === Mode.OOLONG || mode === Mode.COFFEE || mode === Mode.BOIL;
  let tempByte: number;
  if (options.tempF !== undefined) {
    tempByte = options.tempF === 0 ? 0 : clampSetpointF(options.tempF);
  } else if (isPreset) {
    tempByte = 0x00;
  } else {
    throw new RangeError('tempF is required for MyBrew / V0 heat mode');
  }
  return Buffer.from([
    ...header(version, Cmd.SET_MODE, CmdClass.CONTROL),
    mode,
    tempByte,
    hold > 0 ? 1 : 0,
    ...u16(hold, options.holdByteOrder ?? 'le'),
  ]);
}

/** Stop heating / keep-warm. */
export function stopPayload(version: ProtocolVersion): Buffer {
  return Buffer.from(header(version, Cmd.STOP, CmdClass.CONTROL));
}

/** Wrap a payload into a host → kettle frame. */
export function commandFrame(seq: number, payload: Uint8Array): Buffer {
  return buildFrame(FrameType.MESSAGE, seq, payload);
}
