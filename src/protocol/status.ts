/**
 * Decoders for kettle → host frames.
 *
 * Offsets verified against real captures (see test/fixtures/captures.ts). Note: the upstream
 * PROTOCOL.md tables list hold time at [15–16] big-endian and baby mode at [28]; real captures and
 * ha-cosori-kettle's parser use [10–13] little-endian and [26], which is what we implement.
 * The delayed-start fields [17–20] were identified on the maintainer's kettle (HW 1.0.00 / SW R0007V0012).
 */
import {
  Cmd, COMMANDS_WITH_STATUS, FrameType, MAX_SETPOINT_F, MAX_VALID_READING_F, MIN_SETPOINT_F, MIN_VALID_READING_F,
} from './constants.js';
import type { Frame } from './frame.js';

export interface KettleState {
  stage: number;
  mode: number;
  setpointF: number;
  tempF: number;
}

/** 29-byte payload, `01 40 40 00 …`, returned as the ACK to a poll. */
export interface ExtendedStatus extends KettleState {
  kind: 'extended';
  /** Stored MyBrew temperature (°F), or undefined when outside 104–212. */
  myTempF?: number;
  configuredHoldSeconds: number;
  remainingHoldSeconds: number;
  onBase: boolean;
  babyFormula: boolean;
  /** Delay of the most recent delayed start, seconds ([17–18] LE; retained after it completes or is cancelled). */
  delaySetSeconds: number;
  /** Seconds until a scheduled delayed start begins ([19–20] LE); 0 when nothing is scheduled. */
  delayRemainingSeconds: number;
}

/** 12-byte payload, `01 41 40 00 …`, pushed unsolicited by the kettle. No on-base information. */
export interface CompactStatus extends KettleState {
  kind: 'compact';
}

/** `01 F7 A3 00 20|21` pushed when heating (0x20) or hold (0x21) completes. */
export interface CompletionMessage {
  kind: 'completion';
  code: number;
}

/** ACK for a command: echoes the seq and the 4-byte command header; some carry a status byte. */
export interface AckMessage {
  kind: 'ack';
  command: number;
  /** 0x00 = success. Undefined when the ACK has no status byte (e.g. F3 set-mytemp on some firmware). */
  status?: number;
}

export interface InvalidMessage {
  kind: 'invalid';
  reason: string;
}

export interface UnknownMessage {
  kind: 'unknown';
}

export type KettleMessage = ExtendedStatus | CompactStatus | CompletionMessage | AckMessage | InvalidMessage | UnknownMessage;

export const EXTENDED_STATUS_LENGTH = 29;
export const COMPACT_STATUS_LENGTH = 12;

function validReading(tempF: number): boolean {
  return tempF >= MIN_VALID_READING_F && tempF <= MAX_VALID_READING_F;
}

export function parseExtendedStatus(p: Uint8Array): ExtendedStatus | InvalidMessage {
  if (p.length < EXTENDED_STATUS_LENGTH || p[1] !== Cmd.POLL) {
    return { kind: 'invalid', reason: `extended status too short (${p.length})` };
  }
  const tempF = p[7]!;
  if (!validReading(tempF)) {
    return { kind: 'invalid', reason: `temperature reading out of range (${tempF}°F)` };
  }
  const myTemp = p[8]!;
  return {
    kind: 'extended',
    stage: p[4]!,
    mode: p[5]!,
    setpointF: p[6]!,
    tempF,
    myTempF: myTemp >= MIN_SETPOINT_F && myTemp <= MAX_SETPOINT_F ? myTemp : undefined,
    configuredHoldSeconds: p[10]! | (p[11]! << 8),
    remainingHoldSeconds: p[12]! | (p[13]! << 8),
    onBase: p[14] === 0x00,
    babyFormula: p[26] === 0x01,
    delaySetSeconds: p[17]! | (p[18]! << 8),
    delayRemainingSeconds: p[19]! | (p[20]! << 8),
  };
}

export function parseCompactStatus(p: Uint8Array): CompactStatus | InvalidMessage {
  if (p.length < COMPACT_STATUS_LENGTH || p[1] !== Cmd.COMPACT_STATUS) {
    return { kind: 'invalid', reason: `compact status too short (${p.length})` };
  }
  const tempF = p[7]!;
  if (!validReading(tempF)) {
    return { kind: 'invalid', reason: `temperature reading out of range (${tempF}°F)` };
  }
  return { kind: 'compact', stage: p[4]!, mode: p[5]!, setpointF: p[6]!, tempF };
}

/** Classify and decode a frame received on FFF1. */
export function decodeMessage(frame: Frame): KettleMessage {
  const p = frame.payload;
  if (p.length < 4) {
    return { kind: 'unknown' };
  }
  const cmd = p[1]!;

  if (cmd === Cmd.POLL && p.length >= EXTENDED_STATUS_LENGTH) {
    return parseExtendedStatus(p);
  }
  if (cmd === Cmd.COMPACT_STATUS && p.length >= COMPACT_STATUS_LENGTH) {
    return parseCompactStatus(p);
  }
  if (cmd === Cmd.COMPLETION && p.length >= 5) {
    return { kind: 'completion', code: p[4]! };
  }
  if (frame.frameType === FrameType.ACK) {
    const status = COMMANDS_WITH_STATUS.has(cmd) && p.length >= 5 ? p[4] : undefined;
    return { kind: 'ack', command: cmd, status };
  }
  return { kind: 'unknown' };
}
