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

- A Pi 4 in an aluminium Argon ONE case, with a USB 3 SSD attached, can't hear below about -80 dBm, and the kettle sits right at the edge. **Fix:** a USB Bluetooth 5 adapter on the RTL8761BU chip (TP-Link UB500 / ASUS USB-BT500), on a USB 2.0 port with an extension cable. Its firmware is already on the Pi. Use `adapter: "hci1"`, or `dtoverlay=disable-bt`.
- Connects take 10–40 s partly because BlueZ forgets the kettle about 30 s after disconnect, forcing a rescan. Options: keep discovery primed, or document raising `TemporaryTimeout` in `/etc/bluetooth/main.conf`.
- On-demand mode is impractical while connects take longer than HomeKit's ~10 s timeout.
- If the BLE layer gets reworked anyway, prefer a D-Bus/BLE library with no native optional dependencies. That would remove the harmless `usocket` `gyp ERR!` from every npm install log (STATUS open issue 5).

## 4. Protocol unknowns worth resolving (need captures)

- Extended status `[23]` and `[27]`: one of them is probably the app's "Hold Temp: On" flag. Toggle Hold in the app while capturing.
- Compact status `[8]` and `[9]`: `[9] = 01` on lift-off (possibly an off-base flag, so HomeKit could react instantly), and `[8] = 01` while scheduled.
- Is the host-sent `A5 12 … 41 40 00` "CTRL" frame from barrymichels' V0 code needed on V0 firmware? (There's no V0 kettle to test on.)
- Baby formula (F5) is not exposed. It could become an option.
- Maximum delayed-start delay (docs say 12 h; the app's picker range is unverified).

## 5. Release

- Publish to npm as `homebridge-cosori-kettle-ble` once Checkpoint C passes, then pursue the Homebridge "verified" badge (requires a config schema, ✓).
- Ask barrymichels and rygwdn to add LICENSE files (both say MIT in their READMEs), and share the corrections to their docs (checksum, byte order, offsets, stage 5, delay fields, pairing order).
