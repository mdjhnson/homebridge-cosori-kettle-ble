import { ProtocolVersion } from './constants.js';

/**
 * Pick the payload protocol version byte from Device Information Service strings.
 *
 * Rule (from ha-cosori-kettle, observed firmware "HW 1.0.00 / SW R0007V0012"):
 *   - hardware revision major >= 1                        → V1
 *   - software revision R<rel>V<ver> >= R0007V0012        → V1, otherwise V0
 *   - hardware revision major == 0 and no usable software → V0
 *   - nothing usable                                      → V1 (default)
 */
export function detectProtocolVersion(hardwareRevision?: string, softwareRevision?: string): ProtocolVersion {
  const hw = hardwareRevision?.trim().match(/^(\d+)\./);
  const hwMajor = hw ? Number(hw[1]) : undefined;
  if (hwMajor !== undefined && hwMajor >= 1) {
    return ProtocolVersion.V1;
  }

  const sw = softwareRevision?.trim().match(/^R(\d+)V(\d+)/i);
  if (sw) {
    const rel = Number(sw[1]);
    const ver = Number(sw[2]);
    return rel > 7 || (rel === 7 && ver >= 12) ? ProtocolVersion.V1 : ProtocolVersion.V0;
  }

  if (hwMajor === 0) {
    return ProtocolVersion.V0;
  }
  return ProtocolVersion.V1;
}
