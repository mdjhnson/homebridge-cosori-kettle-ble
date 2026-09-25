# Status

_Last updated: 2026-09-24 (evening, US Central)._

## Checkpoints

| Checkpoint | State | Evidence |
|---|---|---|
| A — probe against the real kettle (read-only) | ✅ done | scan, info (HW 1.0.00 / SW R0007V0012 → V1), key from the app's `.pklg`, hello accepted, status/watch, lift off base / put back |
| Connectivity soak (15 min, idle, kettle and Pi in their normal spots) | ✅ 156/156 polls, 0 drops | The first connect took 38 s; connects take 10–40 s from the normal spot vs about 2 s up close |
| B — documented writes from the plugin | 🟡 partial | F1 delayed start 5 min, then F4 cancel, verified live (stage 5, countdown). F0 hold byte order confirmed LE **from the app capture**, not yet sent by the plugin. Boil (F0) was sent via HomeKit and the kettle started heating |
| C — HomeKit on the Pi | 🟡 in progress | Child bridge "Kettle Bridge" paired in the Home app. Boil via HomeKit worked. The link dropped during heating twice on the onboard radio; **on a USB adapter it held through a full heat-and-hold cycle** (see Open issue 1) |

## Deployed on the Pi

- Plugin v0.1.0 from commit `f3b36ef` (adapter selection by MAC, `cosori-probe adapters`; includes `f8ff1ac`: restore Home-app-overwritten tile names, refuse commands when unreachable for more than 15 s), installed into the container from a tarball on 2026-09-24, followed by a Pi reboot to disable the onboard radio.
- To deploy an update: `npm pack` → copy into the container → `npm install --prefix /homebridge <tgz>` → **restart only the Kettle child bridge**.
- Config: a `CosoriKettleBLE` platform as a child bridge, persistent mode, every switch enabled (the user asked for all of them), `"adapter"` set to the USB adapter's MAC. Pi-specific details are in `docs/local/` (gitignored).
- Radio: a TP-Link UB500 (RTL8761BU) USB Bluetooth adapter since 2026-09-24. The onboard CYW43455 is disabled (`dtoverlay=disable-bt`), so the USB adapter is now `hci0`. After the reboot the plugin logged `Using Bluetooth adapter hci0 (…)` and connected in 5.0 s.

## Open issues (priority order)

1. **The link drops once heating starts and doesn't recover. Likely fixed by a USB Bluetooth adapter (2026-09-24).** On the onboard radio the link dropped twice during heating (details below) and the Pi then couldn't hear the kettle at all, even while a Mac next to the Pi heard it advertising at about -63 dBm and a power cycle of the kettle didn't help. That put the fault on the Pi's receive side (aluminium Argon ONE case, USB 3 SSD nearby). After switching the plugin to a TP-Link UB500 (RTL8761BU) on a USB 2.0 port:
   - The first connect took **4.4 s** (10–40 s on the onboard radio), right after the plugin had failed for hours on the onboard radio.
   - **A full cycle with no drop:** Green Tea started from the kettle's button at about 20:10, 180 °F and "heating complete" at 20:15, 30-min hold, "keep-warm complete" at 20:45, back to idle. A 2-s link watcher saw no disconnect, hci1 had 0 errors over about 3,000 ACL packets, every 5-s poll was answered, and a Mac scanner never saw the kettle advertising (it only advertises when disconnected).
   - **Caveats:** one clean cycle, started from the kettle rather than HomeKit. Hypothesis 2 (the kettle drops the link while heating) isn't strictly ruled out, and the plugin's reconnect after a real drop still hasn't been seen working. btmon keeps capturing the USB adapter in the container (`/tmp/kettle-hci.btsnoop`) so a future drop records its HCI reason. Keep watching over a few days of normal use.

   History (onboard radio): At 21:36:39 local, Boil was sent via HomeKit. At 21:36:52 the link was lost. After that, every reconnect failed with "BLE connect timed out" or "not found while scanning", and a host `bluetoothctl` LE scan heard 22 devices but not the kettle. That looked like the kettle wasn't advertising, but later tests (22:06–22:48) showed a Mac next to the Pi hearing it advertise strongly while the Pi heard nothing. The user says VeSync was *not* reopened, so an app takeover is less likely (but iOS background reconnects are still possible). Hypotheses to test, in order:
   1. Something else holds the connection: the iPhone's VeSync (background), or another phone or tablet. Test: turn Bluetooth off on the phones, then scan. **Done 2026-09-23: no change, so very unlikely.**
   2. The kettle stops advertising or resets its BLE while heating or after finishing. Test: heat while running `watch --raw` near the Pi (good signal), and look for the drop and when advertising resumes. Check the kettle display or Bluetooth icon.
   3. Interference from the heating element on a marginal link (the normal spot is about -80 dBm or worse). Test: the same heat test with the kettle next to the Pi; if it stays connected up close, it's the margin → USB adapter (RTL8761BU on an extension; see FUTURE-WORK). **The USB adapter held the link through a full cycle on 2026-09-24 (above).**
   4. A BlueZ state problem after the drop (stale device object / cache). Test: `bluetoothctl remove FC:58:FA:0F:C3:26`, restart the child bridge, and see whether reconnects work.

   **Second occurrence, 2026-09-24 (points to hypothesis 2).** The user heated the kettle around 07:20 local (not through HomeKit). The link was lost at 07:22:36, reconnected at 07:23:45 (22 s), and was lost again at 07:24:58. After that, every attempt failed with "BLE connect timed out", `le-connection-abort-by-local`, and then "not found while scanning". The plugin kept scanning continuously for more than 2.5 h, including across a child-bridge restart at 09:54, and never heard the kettle. At about 10:00 a 20 s host scan heard 21 devices but not the kettle, and `bluetoothctl info` had no device object at all. By then the user was at the office with **no phone at the house**, so hypothesis 1 is unlikely for this occurrence. The kettle was idle on its base, and no lights were lit, the Bluetooth button included (the user says lights only come on while heating). Next test when the user is home: first a host scan with nothing changed. Then press the kettle's Bluetooth button and scan. Then unplug the base for 10 s and scan. Whichever step makes it advertise again is the recovery (and the clue).
2. **Tile names showed as "Switch", "Switch 2"…** because the Home app overwrote ConfiguredName while pairing. Fixed in `f8ff1ac`, deployed 2026-09-24, **awaiting confirmation in the Home app**. Old mapping: Switch = Boil, Switch 2 = Keep Warm, Switch 3 = Coffee, Switch 4 = Green Tea, Switch 5 = MyBrew, Switch 6 = Delay Start, Switch 7 = Oolong, Occupancy Sensor = On Base.
3. **Too many tiles.** The user is confused by nine tiles. See FUTURE-WORK "Preset selector": the likely direction is to drop preset switches by default, because the thermostat dial already snaps to the presets.
4. **Taps while disconnected** were queued, then failed after 45 s. Fixed in `f8ff1ac` (fails fast after the link has been down 15 s), deployed 2026-09-24.
5. **Known, harmless: `gyp ERR!` for `usocket` in npm install logs.** Seen on the Pi (Node 24.20.0) while installing another plugin through the Homebridge UI. npm re-runs install scripts across `/homebridge`, and `usocket@0.3.0` (an optional dependency, via node-ble ~1.13.0 → dbus-next 0.10.2) pins node-gyp ^7.1.2, which can't build on Node 24. It isn't a missing toolchain: the container has python3, make and g++. npm skips the optional dep and the install succeeds. `usocket` has been absent from the plugin's `node_modules` on the Pi since the first tarball install, so the plugin has always run without it. `dbus-next/lib/connection.js` wraps `require('usocket')` for `unix:path=` addresses in a try/catch and falls back to `net.createConnection`. That only loses Unix-FD passing (node-ble doesn't use AcquireNotify/AcquireWrite) and `unix:abstract=` addresses (not used for the system bus). The cost is a scary log line and a failed native build on every plugin install. `overrides` in our `package.json` don't apply to consumer installs. **Decision: leave it, documented in README Troubleshooting.** Don't add an `overrides` entry to the shared `/homebridge/package.json` on the Pi. See FUTURE-WORK §3 for the longer-term option.

## Next steps

1. Watch for drops over a few days of normal use (btmon on the USB adapter records the reason code). Try one heat started from HomeKit.
2. Confirm the tile names are restored now that `f8ff1ac` is deployed.
3. Finish the Checkpoint C list: heat and off via the dial, a preset, Keep Warm holding after the heat finishes, Delay Start on and off, and On Base.
4. Decide the tile layout: FUTURE-WORK §2 (preset selector, default switches) and §2b (user-defined temperature switches in the config, prefilled with the kettle presets).
5. Replace `node-ble` (FUTURE-WORK §3b, agreed).
