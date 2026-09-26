# Future work

These are ideas the maintainer has agreed are worth doing but has deliberately deferred.

## 1. Pair from Homebridge, not the phone (make it the default)

**Why:** capturing the VeSync app's key needs a Mac, PacketLogger, an Apple developer sign-in and a Bluetooth logging profile on the iPhone. That's unreasonable for most users. The maintainer's feedback: "I cannot imagine requiring people to create an Apple dev account is reasonable."

**Plan:**
- Add a **"Pair kettle" flow in the plugin's Homebridge UI settings page** (a custom UI using `@homebridge/plugin-ui-utils`). The user holds the MyBrew button, clicks Pair, and the plugin generates a key, sends **register (80) then hello (81)**, and saves the key into the config. All the protocol pieces already exist: `KettleClient.register()`, `generateKey()`, and the `cosori-probe pair` command.
- The pairing must pause the persistent connection while it runs. `ConnectionManager` needs a "pairing" mode that tolerates the missing key.
- Keep **key capture from the app as an "Advanced" option** (config field plus README section), for people who want both the app and the plugin to keep working with one key.

**Open question to test first:** does registering a new key unpair the VeSync app? This is unknown. Test it on the maintainer's kettle with consent: `cosori-probe pair`, then check whether the app still connects. The worst case is re-adding the kettle in VeSync. Document the result in the README.

## 1b. Easier discovery and setup: to verify (researched 2026-09-24)

**Goal:** the user shouldn't have to type a MAC or capture a key. Direction: one custom settings page. Scan → pick the kettle → put it in pairing mode → Pair → the MAC and key are saved into the config. `mac` becomes optional: auto-use the kettle when exactly one is found, and list them when there are several (homebridge-mi-hygrothermograph's "first one found" approach breaks with two devices). Model to copy: homebridge-switchbot's custom UI `/discover` endpoint ([source](https://github.com/OpenWonderLabs/homebridge-switchbot/tree/main/src/homebridge-ui)). Never pass user input to a shell (homebridge-yeelight-ble does).

**To verify on the kettle (each needs the maintainer's go-ahead):**

1. **Which button enters pairing mode.** The maintainer reports that **holding the Bluetooth button for about 4 s** makes it flash and enters pairing mode, **dropping any existing connection** (e.g. the VeSync app). The docs and probe say MyBrew (PROTOCOL.md "Register" row, `cosori-probe pair` prompt, `NotInPairingModeError` hint), which may be an upstream assumption. Test `cosori-probe pair` after a Bluetooth-button hold, and after a MyBrew hold. Also check whether the hold drops the plugin's persistent connection too; the pairing flow would then have to reconnect before sending register (80) then hello (81).
2. **Whether the advertisement shows pairing mode.** Record the manufacturer data passively (no writes) while idle, while pairing mode is flashing, while heating, and off the base. A flag would let the UI say "kettle ready to pair". Assumed layout (from the Etekcity scale decoder [`etekcity_esf551_ble`](https://github.com/Kohei-Wada/etekcity_esf551_ble/blob/main/src/etekcity_esf551_ble/detection.py), unconfirmed for the kettle): `[0]` header (`01`, upper bits may vary), `[1:7]` MAC reversed, `[7:9]` model ID BE (ours `C2 D4`, probably the CS108-NK), `[9:]` model-specific (`03 01 02`, unknown). Our full capture: `d0 06 01 26 c3 0f fa 58 fc c2 d4 03 01 02`.
3. **Whether renaming the kettle in VeSync changes the advertised name.** Probably not (the name is a cloud field), but untested. Rename it, then `cosori-probe scan`.
4. **Address type.** FC:58:FA and 7C:FE:62 are registered OUIs (Shenzhen XinZhongXin), so the address is very likely public and stable. Confirm with BlueZ `Device1.AddressType`.
5. **Second phone on the same VeSync account.** Does it control the kettle without pairing mode? If it does, the key comes from the account somehow, and the cloud route below deserves another look.

**Name and matching:**
- Every documented unit (all CS108-NK, about three) advertises `Cosori Gooseneck Kettle`. Other regions and models are unknown.
- The name only arrives in the scan response, so passive scanners (ESPHome proxies) never see it, and service `fff0` is generic and caused false matches ([rygwdn/ha-cosori-kettle#13](https://github.com/rygwdn/ha-cosori-kettle/issues/13)). BlueZ discovery is active, so we do get the name.
- **Bug:** `looksLikeKettle` in `src/cli/probe.ts` accepts any 0x06D0 device, so a VeSync scale would be listed as a kettle. Proposed matcher, as a pure function in `src/protocol/` with the capture above as a fixture: company 0x06D0 **and** the MAC echoed in bytes 1–6 **and** (model `C2D4` **or** a name containing "Cosori").
- While the plugin is connected, the kettle stops advertising, so a scan from the settings page (a separate process) won't find it. Show the configured kettle, or pause the connection first.

**VeSync cloud login: probably not worth it.**
- Login (pyvesync 3.4.2): `/globalPlatform/api/accountAuth/v1/authByPWDOrOTM`, then `/user/api/accountManage/v1/loginByAuthorizeCode4Vesync`, with an MD5 password and US/EU hosts.
- The device list (`/cloud/v1/deviceManaged/devices`) includes Bluetooth-only devices. An Etekcity BLE scale showed `connectionType: "BT"`, a real `macID` and **`authKey: null`** ([ioBroker forum](https://forum.iobroker.net/topic/59466/test-adapter-vesync/63)). No source shows the cloud returning a kettle key, and nobody has published the kettle's entry.
- It would add only the MAC and the user's chosen name. Costs: a plaintext password in `config.json`, 2FA must be turned off (home-assistant/core#153551, #154305), region mismatches, and account lockouts after too many requests (RaresAil/homebridge-levoit-air-purifier discussion #104).
- Optional check: dump your own device list with pyvesync and look at the kettle's entry. If `authKey` isn't null, treat it like the registration key.

## 2. Tile layout: temperature switches (done 2026-09-25)

**Done:** an editable list of temperature switches (`switches`) replaced the fixed `accessories.presets` checkboxes. It was merged in PR #1, deployed to the Pi on 2026-09-25, and shipped in 0.2.0-beta.1. The README's "Temperature switches" section documents how it works. It fixed "too many tiles" (STATUS Open issue 3).

Design decisions that aren't obvious from the README (made by the maintainer 2026-09-24 and 2026-09-25):

- **Subtype = the item's name in camelCase** (`Green Tea` → `preset-greenTea`), not a generated id: the settings form can't generate hidden ids, and a plugin shouldn't write to `config.json`. So reordering an item or changing its temperature keeps the tile, but renaming it creates a new one. The old preset switches used the same subtypes, so tiles survived the upgrade.
- **The default list is applied at runtime, not as a schema default.** A schema default would be filled in for a legacy config and replace its migrated presets. The result: an empty list means "defaults", and zero switches can't be configured.
- **MyBrew switch dropped:** it has no fixed temperature, so it doesn't fit a name + temperature item.
- **Keep-warm stays global:** one Keep Warm switch and one `keepWarmMinutes`. Per-switch keep-warm is not planned.
- **A single tile doesn't fix the clutter:** the maintainer's Home app already showed the kettle as one tile. The clutter was the switches inside it.
- **Delay Start removed (2026-09-25).** A toggle with a fixed delay can't express "at 6:45", and Siri timed requests and Home app automations can. The kettle-side timer's only advantage was that it still fires when the Pi, Homebridge or the BLE link is down. `KettleClient.delayedStart()` and `cosori-probe delay` stay as protocol tools.

**Still to do:** `accessories.presets` is no longer in the schema, but `src/config.ts` still reads it (along with the `myBrew` and `delayStartSwitch` notes). Remove that migration code once at least one release has shipped with it.

## 3. Radio robustness

- ~~A Pi 4 in an aluminium Argon ONE case can't hold the link.~~ **Done 2026-09-24:** a USB RTL8761BU adapter fixed it (see STATUS). The plugin now accepts the adapter's MAC address in `adapter`, logs which adapter it uses, warns when several exist and none is set, and `cosori-probe adapters` lists them. README has a step-by-step "Using a USB Bluetooth adapter" section.
- ~~Reconnect logging.~~ **Done 2026-09-24:** an info line when a reconnect succeeds after a drop, and elapsed-time warnings while the link stays down (1, 5, 15, 30 min, then hourly) instead of attempt-count thresholds.
- Weak links are normal for this kettle (about -84 dBm at 10 ft on a USB adapter, drops every few minutes). If the drops turn out to matter in HomeKit, options are: a USB adapter with an external antenna; asking the kettle for a longer supervision timeout than its 6 s (it requests the parameters itself, so this may not be possible from BlueZ); holding commands longer than 15 s while a reconnect is in progress. See STATUS Open issue 1 for the plan.
- Cancel the BlueZ connect properly when our 30 s timeout fires (today `withTimeout` abandons `device.connect()` while BlueZ keeps trying). Easier once we own the D-Bus calls (§3b). _(Suggested, not agreed.)_
- Opt-in adapter power-cycle recovery after N minutes of "not found". Invasive (affects every Bluetooth user on the host), so only if a stuck-controller failure is ever confirmed. _(Suggested, not agreed.)_
- Add the Mac CoreBluetooth scanner used during diagnosis (about 60 lines of Swift, read-only, prints the kettle's RSSI) to the repo, e.g. `tools/mac-blescan/`, as an independent observer. _(Suggested.)_
- Connects take 10–40 s partly because BlueZ forgets the kettle about 30 s after disconnect, forcing a rescan. Options: keep discovery primed, or document raising `TemporaryTimeout` in `/etc/bluetooth/main.conf`.
- On-demand mode is impractical while connects take longer than HomeKit's ~10 s timeout.
- **To verify: the 2026-09-24 morning outage was probably the Pi's radio, not the kettle.** STATUS Open issue 1 ("Second occurrence") describes it as hypothesis 2, the kettle going silent after a heat. But it happened on the onboard radio, before the Mac-next-to-the-Pi test showed the Pi deaf while the kettle was advertising. So it's most likely the same receive-side fault. Check on the next drop on the USB adapter: run an independent scanner (the Mac CoreBluetooth scanner, or nRF Connect on a phone) next to the Pi at the same time, and note btmon's disconnect reason. If the scanner hears the kettle and the Pi doesn't, the fault is on the Pi side. If neither hears it, the kettle really stopped advertising (hypothesis 2 is back). Then try, in order: press the Bluetooth button, unplug the base for 10 s, and note which step brings it back. Either way, then move that STATUS paragraph into the "History (onboard radio)" part with the right label. **Partial answer, 2026-09-25 evening (STATUS "Third occurrence"):** on the USB adapter both the Pi and the phone heard the kettle advertising, yet it ignored every connect (btmon 0x3E). That's a third outcome the test above didn't predict, and it's kettle-side. A press of the Bluetooth/MyBrew button cleared it, but that press starts heating. Next time, try unplugging the base for 10 s first. The 09-24 morning case ("not found while scanning") is still unexplained.
- If the BLE layer gets reworked anyway, prefer a D-Bus/BLE library with no native optional dependencies. That would remove the harmless `usocket` `gyp ERR!` from every npm install log (STATUS open issue 5). See §3b.

## 3b. Replace `node-ble` (agreed 2026-09-24, moderate job, not started)

**Why:** every deprecated-package warning on install (`request`, `tar@6`, `glob@7`, `rimraf@3`, `npmlog`, `gauge`, `are-we-there-yet`, `har-validator`, `uuid@3`, `inflight`) comes from one optional chain: `node-ble 1.13.0 → dbus-next 0.10.2 → usocket 0.3.0 (optional, native) → node-gyp 7`. None of it runs. The real problem is staleness: `dbus-next` hasn't been released since 2022, and its `xml2js@0.4` has a known prototype-pollution advisory (fixed in 0.5+).

**`npm audit` (2026-09-25, at the first npm publish):** 11 findings (3 critical, 1 high, 7 moderate), all in the runtime tree, so users of the published package see them too. Critical: `request`, `form-data`, `tar` (via `node-gyp` 7, under `usocket`). High: `node-gyp`. Moderate: `node-ble`, `dbus-next`, `usocket`, `xml2js`, `qs`, `tough-cookie`, `uuid`. `npm audit --omit=dev` reports the same 11. `node-ble` and `dbus-next` run on every start, but they're flagged only through their dependencies. Of those dependencies, only `xml2js` runs (`dbus-next` uses it to parse BlueZ's introspection XML from the local system bus). The rest (`usocket`, `node-gyp`, `request`, `tar`, `form-data`, `qs`, `tough-cookie`, `uuid`) belong to the optional native build that never succeeds. There's no fix short of this section's replacement. **Don't run `npm audit fix --force`:** its only proposed fix downgrades `node-ble` to 0.0.0, which breaks the plugin. An `overrides` entry in our `package.json` wouldn't help either, because overrides don't apply to consumer installs.

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

## 5. Release: publish to npm, built by GitHub Actions (done 2026-09-25)

**Done:** `0.2.0-beta.1` is on npm, published through `.github/workflows/release.yml` with npm trusted publishing (OIDC, tokens disallowed). The process is in `docs/RELEASING.md`. Installs and updates now go through the Homebridge UI, and a tarball is only for testing a branch before it's merged.

Differences from the original plan, and why:
- **Staged publishing:** the workflow stages each version with `npm stage publish`, and the maintainer approves it with 2FA before it goes live. That's npm's default for trusted publishers created after 2026-09-03.
- **The first version was published by hand,** because npm attaches a trusted publisher only to a package that already exists.
- **`latest` points at the newest beta,** not at nothing. npm pointed `latest` at the first version, and a pre-release under `next` doesn't move it. So until the first stable version, each beta is also tagged `latest` by hand after approval (RELEASING "Each release" step 5).
- **No npm token** goes in the repo or its secrets.

**Still to do:**
- **First stable release:** after Checkpoint C passes (STATUS), remove the README's "pre-release" banner, publish `0.x` as a normal release, then apply for the Homebridge "verified" badge (it requires a config schema, which we have). Settle §6 (a breaking tile change) before this.
- Ask barrymichels and rygwdn to add LICENSE files (both READMEs say MIT), and send them our corrections to their docs (checksum, byte order, offsets, stage 5, delay fields, pairing order).

## 6. How the kettle appears in the Home app: revisit (raised by the maintainer, 2026-09-25)

**On Base as an occupancy sensor is misleading.** With the kettle on its base, the Kitchen shows as **occupied** all day, which is the opposite of what's usually true, and it can trigger or block occupancy-based automations (a real problem in small apartments or offices, where one room holds everything). Options:
- **Contact sensor** ("On Base": closed = on the base, open = lifted). It doesn't affect room occupancy, and automations still work ("when the kettle is lifted…"). To check: whether the Home app turns on notifications for new contact sensors by default.
- Turn the sensor **off by default** and keep it opt-in, in whichever form.
- Invert it (occupied = lifted, i.e. someone is pouring). Truer as occupancy, but only for seconds at a time, so it's of little use.
- Migration: changing the service type creates a new tile, so existing automations on "On Base" would need redoing. Warn in the log and README.

**The kettle is grouped under "Climate", and its water temperature becomes the room temperature.** The Home app groups tiles by service type, and a Thermostat is Climate. Worse, its current temperature feeds the room's summary: the maintainer's Kitchen header showed "Temperature 182°", which was the kettle water. There's no "kettle" type in HomeKit. Options to try:
- **Faucet service with a linked Heater Cooler** (Apple's model for a water device with temperature control). It would group under **Water**. To test: whether the Home app still counts its temperature as the room's, whether Siri "set the kettle to 205" still works, and what the tile looks like.
- A **Switch or Outlet** as the main service (groups under Other / Power) plus the temperature switches. That loses the dial and the live temperature, unless a Temperature Sensor is added, which is Climate again.
- Keep the Thermostat and document it. The dial and Siri are the best controls today.
- Decide after testing on a real phone. Changing the primary service creates a new tile, so this is a breaking change for automations: do it once, together with the On Base change, and before the first stable npm release.
