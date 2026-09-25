# Future work

These are ideas the maintainer has agreed are worth doing but has deliberately deferred.

## 1. Pair from Homebridge, not the phone (make it the default)

**Why:** capturing the VeSync app's key needs a Mac, PacketLogger, an Apple developer sign-in and a Bluetooth logging profile on the iPhone. That's unreasonable for most users. The maintainer's feedback: "I cannot imagine requiring people to create an Apple dev account is reasonable."

**Plan:**
- Add a **"Pair kettle" flow in the plugin's Homebridge UI settings page** (a custom UI using `@homebridge/plugin-ui-utils`). The user holds the MyBrew button, clicks Pair, and the plugin generates a key, sends **register (80) then hello (81)**, and saves the key into the config. All the protocol pieces already exist: `KettleClient.register()`, `generateKey()`, and the `cosori-probe pair` command.
- The pairing must pause the persistent connection while it runs. `ConnectionManager` needs a "pairing" mode that tolerates the missing key.
- Keep **key capture from the app as an "Advanced" option** (config field plus README section), for people who want both the app and the plugin to keep working with one key.

**Open question to test first:** does registering a new key unpair the VeSync app? This is unknown. Test it on the maintainer's kettle with consent: `cosori-probe pair`, then check whether the app still connects. The worst case is re-adding the kettle in VeSync. Document the result in the README.

## 2. Tile layout plan (decided and built 2026-09-24)

**Built** (see README "Temperature switches"). As built: temperatures are read as °F or °C by range (the ranges don't overlap), so the default list works for Celsius users; switches sharing a temperature get a warning but are kept. Merges the two agreed ideas: fewer tiles by default (was "preset selector"), and user-defined temperature switches (was §2b). Nothing is built until the decisions at the end are made.

**Why:** the maintainer's setup shows nine tiles (thermostat, On Base, five presets, Keep Warm, Delay Start) and it's confusing. The preset switches are fixed; users want their own temperatures ("Pour-over 200 °F").

### What the user sees

| Tile | Today (default / maintainer) | Proposed default | Notes |
|---|---|---|---|
| Thermostat (kettle) | ✓ / ✓ | ✓ | The main control: dial = target temperature, Heat/Off. Siri: "set the kettle to 205" |
| On Base | ✓ / ✓ | ✓ | Occupancy sensor. Useful in automations |
| Keep Warm | ✓ / ✓ | ✓ | Applies to the next heat, or changes the current one |
| Delay Start | off / ✓ | off | Opt-in, unchanged |
| Temperature switches | Boil only / all 5 presets | **Green Tea, Oolong, Coffee, Boil** (prefilled list) | Editable list in the plugin settings, see below |

The dial already covers any temperature, so switches are shortcuts: one tap or one Siri phrase ("turn on Green Tea"), and usable in scenes and automations.

**Single tile doesn't solve it:** the maintainer's Home app already shows the kettle as one tile (checked 2026-09-24). The clutter is the seven switches inside the kettle's detail view, so fewer, user-chosen switches is the fix.

### Temperature switches (replaces `accessories.presets`)

Config, rendered as an add/remove list in the Homebridge UI:

```json
"switches": [
  { "name": "Green Tea", "temperature": 180 },
  { "name": "Oolong",    "temperature": 195 },
  { "name": "Coffee",    "temperature": 205 },
  { "name": "Boil",      "temperature": 212 }
]
```

- **Fields:** `name` (required; letters, digits and spaces only, because HAP rejects other names) and `temperature` in `temperatureUnit` (F: 104–212, C: 40–100). Keep-warm stays global: the one Keep Warm switch and `keepWarmMinutes` apply to every switch.
- **Default:** the four kettle presets above, so a new install gets sensible shortcuts. A user who wants a minimal Home app deletes them.
- **On:** heats to that temperature. If it matches a kettle preset (within 1 °F, so Celsius values like 91 °C → Oolong work), the plugin sends that preset (F0). Otherwise it stores the temperature as MyBrew and heats in MyBrew mode (F3, then F0 mode 5), which is what the thermostat dial already does for non-preset temperatures.
- **Shows On** while the kettle is heating or holding at that item's temperature (setpoint within 1 °F). **Off** stops the kettle. Two items with the same temperature would both show On, so validation warns about duplicates.
- **Caveat to document:** non-preset items overwrite the MyBrew temperature stored on the kettle (the one the VeSync app's MyBrew button and the kettle's own MyBrew button use).
- **Validation:** bad names, out-of-range temperatures and duplicate names are reported in the log and skipped; switches sharing a temperature are kept with a warning. Nothing here can crash Homebridge (same as the rest of the config).
- **Reference note** under the list in the settings form and in the README, so a deleted preset is easy to recreate:

  > **Kettle presets:** Green Tea 180 °F / 82 °C · Oolong 195 °F / 91 °C · Coffee 205 °F / 96 °C · Boil 212 °F / 100 °C. Any other temperature from 104–212 °F (40–100 °C) also works.

### Keeping tiles stable (a change from the original §2b)

§2b proposed a hidden, generated `id` per item so renames and reorders don't create new tiles. **That doesn't work:** the Homebridge settings form can't generate hidden ids, and a plugin shouldn't write to `config.json`. Instead:

- **Subtype = the item's name** turned into camelCase, e.g. `Green Tea` → `preset-greenTea`. Reordering items or changing a temperature keeps the tile (and its room, scenes and automations). Renaming an item in the config makes a new tile; the README will say to rename in the Home app instead, which never changes the tile.
- **Bonus:** today's preset switches already use exactly those subtypes (`preset-greenTea`, `preset-oolong`, `preset-coffee`, `preset-boil`, `preset-myBrew`), so existing users' tiles, rooms and automations survive the change untouched.
- Tiles whose item was removed are removed from HomeKit (as today when a preset is disabled).

### Migration

- If `switches` is absent and `accessories.presets` is present, build the list from the enabled presets (same names, the kettle's preset temperatures) and log once: "accessories.presets is deprecated; add a Temperature switches list in the plugin settings". Old configs keep working unchanged.
- **MyBrew** has no fixed temperature (it uses whatever is stored on the kettle), so it doesn't fit a name + temperature item. **Dropped:** a config with `myBrew: true` logs once that the MyBrew switch was removed and how to add a custom temperature instead. Its tile (`preset-myBrew`) is removed.
- Drop `accessories.presets` from the schema; keep reading it for at least one release.

### Maintainer's setup after the change (suggested)

Thermostat, On Base, Keep Warm, and whichever temperature switches you actually tap (maybe just Boil and Green Tea). Delay Start off unless you use it. Or keep everything and use "Show as Single Tile".

### Decisions (made by the user 2026-09-24)

1. **Default switches for new installs:** the four kettle presets (Green Tea, Oolong, Coffee, Boil).
2. **Single tile:** already in effect on the maintainer's phone; it doesn't reduce the switches inside the tile.
3. **MyBrew:** dropped (migrates to a one-time log note).
4. **Per-switch keep-warm:** no. One Keep Warm switch and one global time. Not planned.

**Related, suggested (not decided): Delay Start.** A toggle with a fixed delay can't express "at 6:45". Siri timed requests ("at 11:15 pm turn on Green Tea") and Home app automations do that better. The kettle-side timer's only advantage is that it still fires if the Pi, Homebridge or the BLE link is down at that moment, while a HomeKit-scheduled command is refused after 15 s of outage. Suggestion: keep it as an opt-in (default off, as today), document the trade-off in the README, and turn it off in the maintainer's config.

### Tests

Schema defaults; validation (names, range, duplicates, Celsius); migration from `accessories.presets` (including the MyBrew note); subtype stability across reorder and temperature change; tile removal; preset vs MyBrew command selection (including Celsius rounding); switch On/Off from status.

## 3. Radio robustness

- ~~A Pi 4 in an aluminium Argon ONE case can't hold the link.~~ **Done 2026-09-24:** a USB RTL8761BU adapter fixed it (see STATUS). The plugin now accepts the adapter's MAC address in `adapter`, logs which adapter it uses, warns when several exist and none is set, and `cosori-probe adapters` lists them. README has a step-by-step "Using a USB Bluetooth adapter" section.
- ~~Reconnect logging.~~ **Done 2026-09-24:** an info line when a reconnect succeeds after a drop, and elapsed-time warnings while the link stays down (1, 5, 15, 30 min, then hourly) instead of attempt-count thresholds.
- Weak links are normal for this kettle (about -84 dBm at 10 ft on a USB adapter, drops every few minutes). If the drops turn out to matter in HomeKit, options are: a USB adapter with an external antenna; asking the kettle for a longer supervision timeout than its 6 s (it requests the parameters itself, so this may not be possible from BlueZ); holding commands longer than 15 s while a reconnect is in progress. See STATUS Open issue 1 for the plan.
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
