/**
 * Pure mapping between kettle state and HomeKit values. Kept free of Homebridge imports so it can be
 * unit-tested without a HAP server.
 *
 * HomeKit always works in °C internally; the kettle always works in °F.
 */
import { setpointFromC } from '../protocol/constants.js';
import { clamp, fToC, round1 } from '../util/temperature.js';

/** HomeKit TargetTemperature range for the kettle (°C). 40–100 °C = 104–212 °F. */
export const TARGET_MIN_C = 40;
export const TARGET_MAX_C = 100;
export const TARGET_STEP_C = 0.5;

/** Convert a HomeKit target (°C) to the kettle's integer °F setpoint, clamped to 104–212. */
export function targetCToF(c: number): number {
  return setpointFromC(c);
}

/** Convert a kettle °F setpoint to a HomeKit target (°C), snapped to the 0.5 °C step and clamped to range. */
export function targetFToC(f: number): number {
  return clamp(Math.round(fToC(f) / TARGET_STEP_C) * TARGET_STEP_C, TARGET_MIN_C, TARGET_MAX_C);
}

/** Current temperature for HomeKit (°C, one decimal). HAP's CurrentTemperature tops out at 100 °C. */
export function currentFToC(f: number): number {
  return clamp(round1(fToC(f)), 0, 100);
}

/**
 * Suppress the kettle's ±1 °F sensor flicker (it alternates e.g. 110/111 °F while idle, pushing a status
 * each time). The displayed value changes only when a reading differs from it by ≥ 2 °F, or when the
 * same new reading arrives twice in a row. Steady heating still updates promptly.
 */
export class TemperatureSmoother {
  private shown?: number;
  private last?: number;

  update(readingF: number): number {
    if (this.shown === undefined || Math.abs(readingF - this.shown) >= 2 || (readingF !== this.shown && readingF === this.last)) {
      this.shown = readingF;
    }
    this.last = readingF;
    return this.shown;
  }

  get value(): number | undefined {
    return this.shown;
  }
}

/**
 * HAP FirmwareRevision must look like "x.y.z". The kettle reports software "R0007V0012" and hardware
 * "1.0.00"; map R<rel>V<ver> to "<rel>.<ver>.0", otherwise pass through a numeric "x.y[.z]" string.
 */
export function firmwareRevision(software?: string, hardware?: string): string | undefined {
  const sw = software?.match(/^R(\d+)V(\d+)/i);
  if (sw) {
    return `${Number(sw[1])}.${Number(sw[2])}.0`;
  }
  const hw = hardware?.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (hw) {
    return `${Number(hw[1])}.${Number(hw[2])}.${Number(hw[3] ?? 0)}`;
  }
  return undefined;
}
