# Cosori Smart Gooseneck Kettle — BLE protocol (verified)

Every fact below is backed by a real frame in `test/fixtures/captures.ts`:
- **U:** upstream captures from barrymichels/CosoriKettleBLE and rygwdn/ha-cosori-kettle.
- **O:** the maintainer's kettle (HW `1.0.00`, SW `R0007V0012`). These come from VeSync-app PacketLogger captures or from frames the plugin sent itself.

Anything unverified is marked ❓.

## GATT

| | UUID | Notes |
|---|---|---|
| Service | `0000fff0-…-00805f9b34fb` | |
| RX (notify) | `…fff1…` | ATT handle 0x0010 on O. The CCCD is at 0x0011; the app writes `01 00` |
| TX (write) | `…fff2…` | Handle 0x000E. Flags are `write` and `write-without-response`; the app uses Write Request |
| DIS | `0x180A`: 2A24 model, 2A27 HW, 2A28 SW, 2A29 manufacturer | On O, HW is `1.0.00` and SW is `R0007V0012` (handles 0x0009 and 0x000B). The model string is empty |
| TI OAD | `F000FFC2-0451-4000-B000-000000000000` (handle 0x0019) | The app enables notifications on it. **Never touch it (firmware update).** |

- Advertised name: `Cosori Gooseneck Kettle`. Manufacturer data company ID is **0x06D0** (Etekcity), and the payload contains the MAC byte-reversed (`01 26 C3 0F FA 58 FC …`).
- The iPhone requests MTU 527 and the kettle answers 131, but writes are still chunked at 20 bytes.
- One connection at a time. While a central is connected, the kettle stops advertising.

## Framing

`A5 | type | seq | len_lo | len_hi | checksum | payload[len]`

- **Type:** `0x22` for host commands and for status/completion frames the kettle pushes on its own. `0x12` for ACKs and the extended status.
- **Length:** payload bytes only, little-endian.
- **Checksum:** `c = 0; for each byte i: c = (c - (i == 5 ? 0x01 : b[i])) & 0xFF`. One rule for V0 and V1, TX and RX.
- **Chunking:** frames longer than 20 bytes (only the 42-byte hello/register) are split 20 + 20 + 2 with no extra framing. The parser buffers across notifications and resyncs on `A5` (with look-ahead, so a stray `A5` can't swallow real frames).
- **Payload header:** `[ver 00|01][cmd][class][00]`. The class is `D1` for auth, `A3` for control and `40` for status.
- **Seq:** the host counter increments per frame, and the ACK echoes the seq and the 4-byte header. The app sent hello seq 0, hello seq 2, then poll seq 1, so the kettle doesn't require ordering.

## Commands (host → kettle, type 0x22)

| Cmd | Payload | Verified |
|---|---|---|
| Hello | `VV 81 D1 00` + key as 32 **lowercase ASCII hex** chars | U, O (app sends it twice) |
| Register (pairing) | `VV 80 D1 00` + key, while MyBrew is held. **Send register before hello** | U (derived), ❓ not yet run on O |
| Poll (extended status) | `VV 40 40 00` | U, O |
| Compact status request | `VV 41 40 00` | U |
| Start / mode (F0) | `VV F0 A3 00 MM TT EN HL HH`: mode, temp byte (`00` for presets; °F for MyBrew), hold enable, hold **seconds LE** | U (coffee), O (app: green tea, hold 30 min → `01 00 01 08 07`), O (plugin: boil via HomeKit) |
| Delayed start (F1) | `VV F1 A3 00 DL DH` + **the F0 body** (`MM TT EN HL HH`); delay in seconds LE, 1–43200 | U (boil in 3780 s), O (app: green tea in 25 min, hold 30), O (plugin: 5 min) |
| Set hold (F2) | `VV F2 A3 00 00 EN LO HI` | U (barry V0), ❓ not yet sent on O |
| Set MyBrew temp (F3) | `VV F3 A3 00 TT` (°F, 104–212) | U |
| Stop (F4) | `VV F4 A3 00`. Also **cancels a delayed start** (this is what the app does) | U, O (app and plugin) |
| Baby formula (F5) | `VV F5 A3 00 01/00` | U (not exposed) |

Tapping presets in the app sends nothing; the app only sends F0 or F1 when you press Start or Set Schedule.

## Replies (kettle → host)

**ACK** (type 0x12): echoes the seq and the 4-byte header. Only **hello and register** ACKs carry a status byte: `00` = OK. For hello, `01` = key rejected; for register, `01` = not in pairing mode. ACKs for F0, F1, F3 and F4 have no status byte (U, O).

**Extended status** (type 0x12, 29-byte payload `01 40 40 00 …`), the reply to a poll:

| Offset | Field | Evidence |
|---|---|---|
| 4 | stage: 0 idle, 1 heating, 2 almost done, 3 holding, **5 delay scheduled** | U; stage 5 from O |
| 5 | mode (1 green, 2 oolong, 3 coffee, 4 boil, 5 MyBrew, 6 heat V0) | U, O |
| 6 | setpoint °F | U, O |
| 7 | current temperature °F (40–230 valid) | U, O |
| 8 | MyBrew temperature °F | U, O (140 = the app's MyBrew button) |
| 9 | `01` while a hold or schedule is armed ❓ | U, O |
| 10–11 | configured hold, s LE | U, O |
| 12–13 | remaining hold, s LE | U |
| 14 | on-base: `00` on, `01` off | U, O (lift test) |
| 17–18 | last delayed-start delay, s LE (kept after it finishes or is cancelled) | O (300 after the plugin test, 1500 after the app's 25 min); U E4 = 3780, alongside the U 3780 s F1 |
| 19–20 | **seconds until the scheduled start** (counts down) | O (297 → 294 → 290) |
| 23 | `01` when the app's "Hold Temp" is on ❓ (or `[27]`) | O |
| 24–25 | the app's saved hold duration, s LE (1800 = 30 min) | O |
| 26 | baby formula | U |
| 28 | always `01` | U, O |

**Compact status** (type 0x22, 12-byte payload `01 41 40 00 st md sp t ?? ?? …`) is pushed by the kettle on its own whenever the state or the temperature reading changes, including ±1 °F sensor flicker while idle. It carries no on-base byte, although `[9] = 01` showed up on lift-off (❓ possibly an off-base flag), and `[8] = 01` while scheduled.

**Completion** (type 0x22): `01 F7 A3 00 20` = heating done, `… 21` = hold done (U).

## Corrections to upstream

| Upstream says | Reality |
|---|---|
| V0 checksum = sum of the header bytes (PROTOCOL.md, ha-cosori-kettle) | The single subtractive rule works for all frames |
| F0 hold big-endian (ha-cosori-kettle `send_set_mode`) | Little-endian (app capture) |
| F1 = delay BE, then `00 MM` (ha-cosori-kettle) | Delay LE, then the F0 body |
| Hold at `[15–16]` BE, baby mode at `[28]` (PROTOCOL.md tables) | `[10–13]` LE, `[26]` |
| Status mode `0x04` = keep warm (PROTOCOL.md) | `0x04` = boil |
| Start/stop frames of type `0x20` (PROTOCOL.md) | Fabricated: they fail the checksum; everything is `0x22` |
| First pairing sends hello first (ha-cosori-kettle issue #8) | Register must come first |
| No stage 5, no delay fields | Stage 5 = scheduled, `[17–20]` = delay set / remaining |
