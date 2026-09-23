/**
 * Frame checksum.
 *
 * Algorithm: start at 0 and subtract every byte of the whole frame (header + payload),
 * treating the checksum byte itself (index 5) as 0x01. Result is masked to 8 bits.
 *
 * This single rule matches every real capture we have (V0 and V1 payloads, TX and RX) and
 * every hard-coded V0 checksum constant in barrymichels/CosoriKettleBLE. The "V0 = sum of
 * header bytes" formula in upstream docs / ha-cosori-kettle's V0 branch does NOT match real
 * traffic and is intentionally not implemented.
 */
export function computeChecksum(frame: Uint8Array): number {
  let checksum = 0;
  for (let i = 0; i < frame.length; i++) {
    const value = i === 5 ? 0x01 : frame[i]!;
    checksum = (checksum - value) & 0xff;
  }
  return checksum;
}

/** True when byte 5 of `frame` holds the correct checksum for the frame. */
export function verifyChecksum(frame: Uint8Array): boolean {
  if (frame.length < 6) {
    return false;
  }
  return frame[5] === computeChecksum(frame);
}
