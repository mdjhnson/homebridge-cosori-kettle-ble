# Future work

These are ideas the maintainer has agreed are worth doing but has deliberately deferred.

## 1. Pair from Homebridge, not the phone (make it the default)

**Why:** capturing the VeSync app's key needs a Mac, PacketLogger, an Apple developer sign-in and a Bluetooth logging profile on the iPhone. That's unreasonable for most users. The maintainer's feedback: "I cannot imagine requiring people to create an Apple dev account is reasonable."

**Plan:**
- Add a **"Pair kettle" flow in the plugin's Homebridge UI settings page** (a custom UI using `@homebridge/plugin-ui-utils`). The user holds the MyBrew button, clicks Pair, and the plugin generates a key, sends **register (80) then hello (81)**, and saves the key into the config. All the protocol pieces already exist: `KettleClient.register()`, `generateKey()`, and the `cosori-probe pair` command.
- The pairing must pause the persistent connection while it runs. `ConnectionManager` needs a "pairing" mode that tolerates the missing key.
- Keep **key capture from the app as an "Advanced" option** (config field plus README section), for people who want both the app and the plugin to keep working with one key.

**Open question to test first:** does registering a new key unpair the VeSync app? This is unknown. Test it on the maintainer's kettle with consent: `cosori-probe pair`, then check whether the app still connects. The worst case is re-adding the kettle in VeSync. Document the result in the README.

## 2. Preset selector instead of five preset switches

**Why:** nine tiles (thermostat, On Base, five presets, Keep Warm, Delay Start) are confusing.

**Options:**
- **Drop the preset switches by default.** The thermostat dial already snaps 180/195/205/212 °F to Green Tea / Oolong / Coffee / Boil, so the dial *is* the preset selector ("Hey Siri, set the kettle to 205"). This is the likely choice; keep the switches as opt-in.
- A **Television service with InputSources** (one per preset) gives a real picker in the Home app, but shows up as a TV tile, which is odd.
- A **Fan RotationSpeed** slider mapped to presets. It's a hack and not self-explanatory.
- HomeKit has no generic dropdown characteristic, and Thermostat modes are limited to Off/Heat/Cool/Auto.
- Also reconsider the defaults: thermostat + Keep Warm + On Base, with Delay Start and presets opt-in.

## 2b. User-defined temperature switches (replaces the fixed preset toggles)

**Request (maintainer):** in the plugin settings, the user adds a list of **"items" that each show up as a switch**. Each item has a **name** and a **temperature**. The list comes **prefilled** with the kettle's own presets, and the user can edit, delete or add entries.

**Proposed config** (`config.schema.json` array, rendered as an add/remove list in the Homebridge UI):

```json
"switches": [
  { "name": "Green Tea", "temperature": 180 },
  { "name": "Oolong",    "temperature": 195 },
  { "name": "Coffee",    "temperature": 205 },
  { "name": "Boil",      "temperature": 212 }
]
```

- **Fields per item:**
  - `name` (required; HAP-safe characters only, validated).
  - `temperature`, in the `temperatureUnit` (F: 104–212, C: 40–100).
  - Optional `keepWarmMinutes` to override the global keep-warm setting for this item (0 = no hold).
- **Behaviour:**
  - **On** heats to that temperature. If the temperature is one of the kettle's presets, it uses that preset (F0). Otherwise it stores the temperature as MyBrew and heats in MyBrew mode (F3, then F0 mode 5).
  - **The switch shows On** while the kettle is heating to that item's temperature (the setpoint matches, within ±1 °F). **Off** stops the kettle.
  - **Caveat to document:** non-preset items overwrite the MyBrew temperature stored on the kettle, which the VeSync app's MyBrew button uses.
- **Stable identity:**
  - Derive each HAP subtype from a hidden, generated `id` per item, not from the name or position. Renaming or reordering items then won't create new tiles in the Home app.
  - Remove tiles whose item was deleted.
- **Migration:** when `accessories.presets` exists, translate its enabled flags into `switches` entries and warn once. Then drop the old option.
- **Reference note** in the settings form (a help block under the list) and in the README, so users can recreate a deleted preset:

  > **Kettle presets:** Green Tea 180 °F / 82 °C · Oolong 195 °F / 91 °C · Coffee 205 °F / 96 °C · Boil 212 °F / 100 °C. MyBrew uses the temperature stored on the kettle (set in the VeSync app, or by any non-preset switch). Any other temperature from 104–212 °F (40–100 °C) also works.

- **Tests:** schema defaults, validation (range, names), migration, subtype stability across rename and reorder, preset vs MyBrew command selection, switch On/Off state from status.

## 3. Radio robustness

- ~~A Pi 4 in an aluminium Argon ONE case can't hold the link.~~ **Done 2026-09-24:** a USB RTL8761BU adapter fixed it (see STATUS). The plugin now accepts the adapter's MAC address in `adapter`, logs which adapter it uses, warns when several exist and none is set, and `cosori-probe adapters` lists them. README has a step-by-step "Using a USB Bluetooth adapter" section.
- **Reconnect logging** _(proposed 2026-09-24, awaiting the user's OK)_: log at info level when a reconnect succeeds after a drop ("Reconnected after 4.1 s"), and log an elapsed-time warning while the link stays down, even between the attempt-count thresholds (1/5/20/50). Today a drop plus a 4 s recovery looks the same as an unrecovered drop, and during the 2026-09-23 outage the log went quiet for over an hour.
- Cancel the BlueZ connect properly when our 30 s timeout fires (today `withTimeout` abandons `device.connect()` while BlueZ keeps trying). Easier once we own the D-Bus calls (§3b). _(Suggested, not agreed.)_
- Opt-in adapter power-cycle recovery after N minutes of "not found". Invasive (affects every Bluetooth user on the host), so only if a stuck-controller failure is ever confirmed. _(Suggested, not agreed.)_
- Add the Mac CoreBluetooth scanner used during diagnosis (about 60 lines of Swift, read-only, prints the kettle's RSSI) to the repo, e.g. `tools/mac-blescan/`, as an independent observer. _(Suggested.)_
- Connects take 10–40 s partly because BlueZ forgets the kettle about 30 s after disconnect, forcing a rescan. Options: keep discovery primed, or document raising `TemporaryTimeout` in `/etc/bluetooth/main.conf`.
- On-demand mode is impractical while connects take longer than HomeKit's ~10 s timeout.
- If the BLE layer gets reworked anyway, prefer a D-Bus/BLE library with no native optional dependencies. That would remove the harmless `usocket` `gyp ERR!` from every npm install log (STATUS open issue 5). See §3b.

## 3b. Replace `node-ble` (agreed 2026-09-24, moderate job, not started)

**Why:** every deprecated-package warning on install (`request`, `tar@6`, `glob@7`, `rimraf@3`, `npmlog`, `gauge`, `are-we-there-yet`, `har-validator`, `uuid@3`, `inflight`) comes from one optional chain: `node-ble 1.13.0 → dbus-next 0.10.2 → usocket 0.3.0 (optional, native) → node-gyp 7`. None of it runs. The real problem is staleness: `dbus-next` hasn't been released since 2022, and its `xml2js@0.4` has a known prototype-pollution advisory (fixed in 0.5+).

**Libraries checked on npm (2026-09-24), all pure JS with no native or optional deps:**

| Library | What it is | Notes |
|---|---|---|
| `@homebridge/dbus-native` 0.7.9 | Raw D-Bus client (xml2js 0.6) | Maintained by the Homebridge org. Callback-style API, more work to wrap. Best long-term bet. |
| `@jellybrick/dbus-next` 0.11.3 | Maintained `dbus-next` fork (fast-xml-parser 5) | Same proxy/Variant API as `dbus-next`. Single maintainer. |
| `@naugehyde/node-ble` 1.13.5 | `node-ble` fork on `@jellybrick/dbus-next` ^0.10.3 | **Drop-in** (change the import). Single maintainer, fork of a fork. |
| `dbus-native` 0.15.2 | Original, revived by its author | Five releases in one day (2026-07-30). Wait for it to settle. |

Rejected: noble variants (native HCI sockets, bypass BlueZ, need container privileges); `@clebert/node-bluez`, `bluez`, `@tanislav000/bluez`, `blauzahn` (stale, native, or single-person forks).

**Recommendation:** a small in-house `BluezTransport` on `@homebridge/dbus-native`, behind the existing `Transport` interface, so `KettleClient`, `ConnectionManager`, the accessory and the tests don't change. The plugin uses only:
- `org.bluez.Adapter1`: find the adapter (keep the MAC-or-hciN selection), `StartDiscovery`/`StopDiscovery`, wait for `/org/bluez/hciN/dev_…` via `ObjectManager.GetManagedObjects` plus `InterfacesAdded`.
- `org.bluez.Device1`: `Connect`, `Disconnect`, `Connected` and `ServicesResolved` (GATT discovery = wait for `ServicesResolved=true`).
- `GattService1`/`GattCharacteristic1`: find FFF0/FFF1/FFF2 by UUID; `StartNotify` and `Value` via `PropertiesChanged`; `WriteValue(bytes, {type})`; `ReadValue` for the DIS characteristics.
- Keep the Docker socket auto-detect and the bus `'error'` handler.

**Fallback:** `@naugehyde/node-ble` as a 10-minute drop-in that clears the warnings.

**Plan:** (1) unit tests around a mocked bus; (2) implement, swap the dependency, check `npm ci` shows no deprecation warnings; (3) update STATUS issue 5, README Troubleshooting (drop the usocket row), §3 and the CLAUDE.md layout table; (4) hardware checks, asking first and with water in the kettle for anything that heats: connect time, notifications, `cosori-probe info`, a documented command with `--cancel-after`, disconnect/reconnect, child-bridge restart.

## 4. Protocol unknowns worth resolving (need captures)

- Extended status `[23]` and `[27]`: one of them is probably the app's "Hold Temp: On" flag. Toggle Hold in the app while capturing.
- Compact status `[9]`: `= 01` on lift-off, possibly an off-base flag, so HomeKit could react instantly. (`[8]` is now understood: `01` while a hold or schedule is armed, matching extended `[9]`; O capture 2026-09-24.)
- Starting a preset from the kettle's own button armed a 30 min hold with no command sent. Confirm it comes from the app's saved hold (extended `[23]`/`[24–25]`) by changing the hold in the app, then pressing the button while the plugin watches.
- Is the host-sent `A5 12 … 41 40 00` "CTRL" frame from barrymichels' V0 code needed on V0 firmware? (There's no V0 kettle to test on.)
- Baby formula (F5) is not exposed. It could become an option.
- Maximum delayed-start delay (docs say 12 h; the app's picker range is unverified).

## 5. Release

- Publish to npm as `homebridge-cosori-kettle-ble` once Checkpoint C passes, then pursue the Homebridge "verified" badge (requires a config schema, ✓).
- Ask barrymichels and rygwdn to add LICENSE files (both say MIT in their READMEs), and share the corrections to their docs (checksum, byte order, offsets, stage 5, delay fields, pairing order).
