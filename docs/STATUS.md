# Status

_Last updated: 2026-09-23 (evening, US Central)._

## Checkpoints

| Checkpoint | State | Evidence |
|---|---|---|
| A — probe against the real kettle (read-only) | ✅ done | scan, info (HW 1.0.00 / SW R0007V0012 → V1), key from the app's `.pklg`, hello accepted, status/watch, lift off base / put back |
| Connectivity soak (15 min, idle, kettle and Pi in their normal spots) | ✅ 156/156 polls, 0 drops | The first connect took 38 s; connects take 10–40 s from the normal spot vs about 2 s up close |
| B — documented writes from the plugin | 🟡 partial | F1 delayed start 5 min, then F4 cancel, verified live (stage 5, countdown). F0 hold byte order confirmed LE **from the app capture**, not yet sent by the plugin. Boil (F0) was sent via HomeKit and the kettle started heating |
| C — HomeKit on the Pi | 🟡 in progress | Child bridge "Kettle Bridge" paired in the Home app. Boil via HomeKit worked. **Then the link dropped 13 s into heating and had not come back ~20 min later** (see Open issues) |

## Deployed on the Pi

- Plugin v0.1.0 from commit `230fc5f` (the HomeKit layer), installed into the container from a tarball.
- **Not yet deployed:** `f8ff1ac` (restore Home-app-overwritten tile names; refuse commands when unreachable for more than 15 s). To deploy: `npm pack` → copy into the container → `npm install --prefix /homebridge <tgz>` → **restart only the Kettle child bridge**.
- Config: a `CosoriKettleBLE` platform as a child bridge, persistent mode, every switch enabled (the user asked for all of them). Pi-specific details are in `docs/local/` (gitignored).

## Open issues (priority order)

1. **The link drops once heating starts and doesn't recover.** At 21:36:39 local, Boil was sent via HomeKit. At 21:36:52 the link was lost. After that, every reconnect failed with "BLE connect timed out" or "not found while scanning", and a host `bluetoothctl` LE scan heard 22 devices but not the kettle, i.e. the kettle **wasn't advertising**. The user says VeSync was *not* reopened, so an app takeover is less likely (but iOS background reconnects are still possible). Hypotheses to test, in order:
   1. Something else holds the connection: the iPhone's VeSync (background), or another phone or tablet. Test: turn Bluetooth off on the phones, then scan.
   2. The kettle stops advertising or resets its BLE while heating or after finishing. Test: heat while running `watch --raw` near the Pi (good signal), and look for the drop and when advertising resumes. Check the kettle display or Bluetooth icon.
   3. Interference from the heating element on a marginal link (the normal spot is about -80 dBm or worse). Test: the same heat test with the kettle next to the Pi; if it stays connected up close, it's the margin → USB adapter (RTL8761BU on an extension; see FUTURE-WORK).
   4. A BlueZ state problem after the drop (stale device object / cache). Test: `bluetoothctl remove FC:58:FA:0F:C3:26`, restart the child bridge, and see whether reconnects work.
2. **Tile names showed as "Switch", "Switch 2"…** because the Home app overwrote ConfiguredName while pairing. Fixed in `f8ff1ac`, not deployed. Current mapping: Switch = Boil, Switch 2 = Keep Warm, Switch 3 = Coffee, Switch 4 = Green Tea, Switch 5 = MyBrew, Switch 6 = Delay Start, Switch 7 = Oolong, Occupancy Sensor = On Base.
3. **Too many tiles.** The user is confused by nine tiles. See FUTURE-WORK "Preset selector": the likely direction is to drop preset switches by default, because the thermostat dial already snaps to the presets.
4. **Taps while disconnected** were queued, then failed after 45 s. Fixed in `f8ff1ac` (fails fast after the link has been down 15 s), not deployed.

## Next steps

1. Diagnose open issue 1 (above) with the user present.
2. Deploy `f8ff1ac` by restarting the child bridge only; confirm the tile names are restored.
3. Finish the Checkpoint C list: heat and off via the dial, a preset, Keep Warm holding after the heat finishes, Delay Start on and off, and On Base.
4. Decide the tile layout: FUTURE-WORK §2 (preset selector, default switches) and §2b (user-defined temperature switches in the config, prefilled with the kettle presets).
