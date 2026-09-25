# homebridge-cosori-kettle-ble

Control a **Cosori Smart Gooseneck Electric Kettle** (0.8 L, Bluetooth — normally used with the VeSync app) from Apple HomeKit via [Homebridge](https://homebridge.io), talking to the kettle directly over Bluetooth LE.

> **Status: pre-release.** The protocol library and the `cosori-probe` CLI have been validated on a real kettle (HW 1.0.00 / SW R0007V0012). The HomeKit layer is implemented and tested against a simulated kettle; HomeKit testing on real hardware is in progress. Not published to npm.

- BLE via [node-ble](https://github.com/chrvadala/node-ble) (BlueZ over D-Bus): **no privileged container, no capabilities, no `/dev` passthrough, no native modules**.
- Works in the official `homebridge/homebridge` Docker image with host networking and the host D-Bus socket mounted.

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Host setup (Raspberry Pi / Debian)](#host-setup-raspberry-pi--debian)
  - [Using a USB Bluetooth adapter](#using-a-usb-bluetooth-adapter)
- [Docker changes](#docker-changes)
- [Install (pre-release)](#install-pre-release)
- [Registration key](#registration-key)
- [Configuration](#configuration)
- [HomeKit](#homekit)
- [cosori-probe CLI](#cosori-probe-cli)
- [The one-connection limitation](#the-one-connection-limitation)
- [Troubleshooting](#troubleshooting)
- [Protocol notes](#protocol-notes)
- [Development](#development)
- [Credits](#credits)

## How it works

```
 HomeKit ── Homebridge (Docker, network_mode: host)
                 │  node-ble → dbus-next
                 ▼
   /run/dbus-host/system_bus_socket  (host D-Bus socket, mounted read-only)
                 │
            bluetoothd (BlueZ on the host) ── BLE radio ── kettle (GATT FFF0: FFF1 notify / FFF2 write)
```

The plugin never touches the Bluetooth hardware itself. BlueZ on the host owns the radio; the plugin asks it — over D-Bus — to connect, subscribe to notifications and write commands.

## Requirements

- Linux host running BlueZ (`bluetoothd`) with a BLE-capable adapter (tested target: Raspberry Pi 4, Raspberry Pi OS).
- Node.js 22.10+, 24 or 26 (the current `homebridge/homebridge` image ships a supported version).
- Homebridge 1.8+ or 2.x.
- The kettle within BLE range of the host.

## Host setup (Raspberry Pi / Debian)

Run on the host (not in the container):

```sh
systemctl status bluetooth          # must be "active (running)"
bluetoothctl show                   # must show "Powered: yes"
# if powered off / soft-blocked:
sudo rfkill unblock bluetooth
bluetoothctl power on
```

- **Do not pair or trust the kettle in `bluetoothctl`.** The kettle uses its own application-level registration, not BLE bonding.
- **No D-Bus policy file is needed** when the container runs as root (the default for `homebridge/homebridge`): BlueZ's stock policy (`/etc/dbus-1/system.d/bluetooth.conf`) already allows root. If you run the container rootless or with user-namespace remapping, install a policy for that user as described in the [node-ble README](https://github.com/chrvadala/node-ble#provide-permissions).
- **Pi 4 radio coexistence:** the onboard chip shares its antenna between 2.4 GHz Wi-Fi and Bluetooth. If connections are flaky, put the Pi on Ethernet or 5 GHz Wi-Fi.
- **Metal cases and USB 3 devices:** aluminium cases such as the Argon ONE shield the onboard antenna, and USB 3 drives and hubs emit noise in the 2.4 GHz band. In testing, a Pi 4 in an Argon ONE with a USB 3 SSD could not hear anything weaker than about -80 dBm, lost the connection within seconds to minutes of the kettle starting to heat, and then could not see the kettle at all. The fix is a USB Bluetooth adapter; see [Using a USB Bluetooth adapter](#using-a-usb-bluetooth-adapter). With one, the same Pi held the connection through a full heat-and-hold cycle.

### Using a USB Bluetooth adapter

Recommended for any Pi in a metal case, or whenever connections drop or the kettle isn't found.

1. **Buy** a USB Bluetooth 5.x adapter with a Realtek **RTL8761BU** chip (e.g. TP-Link UB500, ASUS USB-BT500). Its firmware ships in Raspberry Pi OS's `firmware-realtek` package (`sudo apt install firmware-realtek` if it's missing).
2. **Plug it into a USB 2.0 port** (black, not blue), ideally on a short extension cable outside the case and away from USB 3 drives.
3. **Check that the host sees it and power it on.** New adapters often start soft-blocked by rfkill, and BlueZ can't power on a blocked adapter:

   ```sh
   bluetoothctl list                                  # should now list two controllers
   sudo rfkill unblock bluetooth && sleep 2 && bluetoothctl power on
   ```

   `journalctl -k | grep -i rtl` should show `rtl8761bu_fw.bin` loading. If `power on` says `org.bluez.Error.Busy`, wait a second and run it again.
4. **Find its MAC address:** `docker exec homebridge cosori-probe adapters` (or `bluetoothctl list` on the host). The onboard Pi radio usually starts with `B8:27:EB`, `DC:A6:32`, `E4:5F:01`, `D8:3A:DD` or `2C:CF:67` (Raspberry Pi's vendor prefixes). The USB adapter is the other one.
5. **Set the plugin's `adapter` setting to that MAC address** (the "Bluetooth adapter" field in the plugin settings), then restart the plugin's child bridge. Use the MAC rather than `hci1`: `hciN` numbers follow the order the adapters come up, so after a reboot the USB adapter can become `hci0` and the plugin would silently go back to the weak onboard radio. The log then shows `Using Bluetooth adapter hci1 (AA:BB:…)`.
6. **Optional: turn off the onboard Bluetooth** if nothing else on the Pi uses it. Then there's only one adapter to pick from:

   ```sh
   echo 'dtoverlay=disable-bt' | sudo tee -a /boot/firmware/config.txt && sudo systemctl disable hciuart && sudo reboot
   ```

   This appends to the end of `config.txt`, which on Raspberry Pi OS is the `[all]` section; check with `tail /boot/firmware/config.txt` first if you've edited it. The reboot restarts Homebridge. Afterwards `bluetoothctl list` should show only the USB adapter. Keep the MAC in the `adapter` setting anyway. It still matches after the adapter is renumbered to `hci0`.

## Docker changes

The `homebridge/homebridge` image runs **its own** `dbus-daemon` at `/run/dbus` (used by Avahi for mDNS), and its setup script deletes `/var/run/dbus/pid` and `chown`s that directory on every start. Mounting the host's D-Bus directory **over** `/run/dbus` therefore collides with the container's daemon — and a writable mount can break the host's D-Bus ([docker-homebridge#557](https://github.com/homebridge/docker-homebridge/issues/557), [#561](https://github.com/homebridge/docker-homebridge/issues/561)).

Instead, mount the host bus **read-only at a separate path**; the plugin and probe find it there automatically:

```yaml
services:
  homebridge:
    image: homebridge/homebridge:latest
    container_name: homebridge
    restart: always
    network_mode: host                     # required for HomeKit (mDNS); already standard for Homebridge
    environment:
      - TZ=America/Chicago
    volumes:
      - homebridge:/homebridge
      - /run/dbus:/run/dbus-host:ro        # host system D-Bus → BlueZ. Read-only, separate path.
volumes:
  homebridge:
```

What each piece is for, and what is **not** needed:

| Setting | Needed? | Why |
|---|---|---|
| `network_mode: host` | yes | HomeKit/mDNS. Not needed for Bluetooth itself. |
| `/run/dbus:/run/dbus-host:ro` | yes | Gives node-ble the host's system bus, where BlueZ lives. `:ro` stops the image's setup script from modifying host files. |
| `privileged: true` | **no** | BlueZ does the radio work on the host. |
| `cap_add: [NET_ADMIN, NET_RAW]` | **no** | Only raw-HCI libraries (noble) need these. |
| `devices: [/dev/hci0]` | **no** | Same reason. |
| `security_opt: [apparmor:unconfined]` | only if D-Bus calls are denied | Some AppArmor-enforcing hosts block D-Bus from containers. Stock Raspberry Pi OS does not. |

> If you previously added `- /var/run/dbus:/run/dbus` and/or `- /run/dbus:/run/dbus:ro`, **remove both**. On Raspberry Pi OS `/var/run` is a symlink to `/run`, so those lines mount the same host directory over the container's own D-Bus directory.

Apply with `docker compose up -d` (or "Update the stack" in Portainer), then check from inside the container:

```sh
docker exec homebridge ls -l /run/dbus-host/system_bus_socket
```

## Install (pre-release)

Until the package is published, install it from a tarball into the container's Homebridge directory.

On your development machine:

```sh
git clone https://github.com/mdjhnson/homebridge-cosori-kettle-ble.git
cd homebridge-cosori-kettle-ble
npm install
npm pack                                  # → homebridge-cosori-kettle-ble-0.1.0.tgz
scp homebridge-cosori-kettle-ble-0.1.0.tgz your-pi:/tmp/
```

On the Pi:

```sh
docker cp /tmp/homebridge-cosori-kettle-ble-0.1.0.tgz homebridge:/homebridge/
docker exec homebridge npm install --prefix /homebridge /homebridge/homebridge-cosori-kettle-ble-0.1.0.tgz
docker exec homebridge cosori-probe help
```

(Alternatively: `docker exec homebridge npm install --prefix /homebridge github:mdjhnson/homebridge-cosori-kettle-ble` — this builds from source on the Pi and is slower.)

## Registration key

The kettle only accepts commands from a client that sends a known **16-byte registration key** right after connecting ("hello"). There are two ways to get one.

### Option A — reuse the VeSync app's key (recommended)

Reusing the app's key keeps the VeSync app working with the kettle. You record a Bluetooth trace while the app connects, and the probe finds the key in that trace.

**iPhone (with a Mac):**

1. **Install Apple's Bluetooth logging profile on the iPhone.**
   - Go to [developer.apple.com/bug-reporting/profiles-and-logs](https://developer.apple.com/bug-reporting/profiles-and-logs/) (a free Apple ID works), find **Bluetooth** for iOS, and download the profile.
   - Install it under *Settings → General → VPN & Device Management*, then restart the iPhone.
   - The profile expires after a few days. You can remove it once you have the key.
2. **Install PacketLogger on the Mac.** Download **Additional Tools for Xcode** from [developer.apple.com/download/all](https://developer.apple.com/download/all/); PacketLogger is in the `Hardware` folder of the disk image.
3. **Force-quit the VeSync app** so its next connection, and the key it sends, is captured from the start. Also make sure nothing else is connected to the kettle; the probe disconnects when it exits.
4. **Plug the iPhone into the Mac, unlock it and tap *Trust*.** In PacketLogger, choose *File → New iOS Trace*. Packets start scrolling.
5. **Open the VeSync app and open the kettle** until it shows the live temperature.
6. **Stop the trace and save it as a `.pklg` file** (*File → Save* / *Save As…*, e.g. `~/Desktop/kettle.pklg`). Use PacketLogger's own format, not a text export: text exports may contain only the truncated "Value: …" column, and then the full key is not in the file.
7. **Run the probe on the capture.** On the Mac, from a clone of this repo after `npm install`, run `node dist/cli/probe.js key-from-log ~/Desktop/kettle.pklg`; on the Pi, run `cosori-probe key-from-log …`:

   ```
   Hello (protocol V1, seq 4) → kettle ACCEPTED it (status 00)
   Registration key: 7f868962cde056b60b5403433ad42bdc
   ```

   It reads the capture's Bluetooth ACL packets, reassembles the app's three-part hello, checks the frame checksum, and reads the kettle's reply to confirm the key was accepted. Text exports that include raw packet bytes also work.

**Picking the packets by hand (optional).** The handshake is three consecutive *ATT Send → Write Request, Handle 0x000E* packets, sent right after connecting:
- the first value starts `A5 22 xx 24 00` and is 20 bytes
- the second is 20 bytes
- the third is 2 bytes

The kettle then answers with a notification on handle 0x0010 starting `A5 12 xx 05 00 … 01 81 D1 00`, where a final `00` means accepted.

- ⚠️ **PacketLogger's "Value:" column is cut off with "…".** Copy the **raw hex bytes** at the end of each line instead. Those include an 11-byte header (`05 04 1B 00 17 00 04 00 12 0E 00`), which the probe removes for you.
- Then run `cosori-probe key-from-packets "<raw 1>" "<raw 2>" "<raw 3>"`.

**Android:**

1. *Settings → Developer options → Enable Bluetooth HCI snoop log*, then turn Bluetooth off and on.
2. Force-quit the VeSync app, reopen it and open the kettle.
3. Run `adb bugreport bugreport.zip` and extract `FS/data/misc/bluetooth/logs/btsnoop_hci.log` (the path varies by vendor).
4. Open the log in Wireshark and filter with `btatt.opcode == 0x12 || btatt.opcode == 0x52`. Find the three writes described above and copy each **value** as hex (*Copy → …as Hex Stream*).
5. Run `cosori-probe key-from-packets <v1> <v2> <v3>`.

**Keep the key private.** Anyone within Bluetooth range who has it can control the kettle.

### Option B — pair as a new client

```sh
docker exec -it homebridge cosori-probe pair AA:BB:CC:DD:EE:FF --yes
```

The probe generates a random key and asks you to **press and hold the MyBrew button** to put the kettle into pairing mode. It then registers the key and verifies it with a hello. It is **not yet known whether registering a new key unpairs the VeSync app**, so use Option A if you rely on the app.

## Configuration

Configure the plugin in the Homebridge UI (the form is generated from `config.schema.json`), or add it to `config.json`. **Run it as a child bridge**, so that a Bluetooth problem can never affect your other accessories:

```json
{
  "platform": "CosoriKettleBLE",
  "name": "Kettle",
  "mac": "FC:58:FA:0F:C3:26",
  "registrationKey": "<32 hex characters>",
  "_bridge": { "username": "0E:A1:B2:C3:D4:E5", "port": 51830 }
}
```

| Option | Default | Description |
|---|---|---|
| `name` | `Kettle` | Accessory name |
| `mac` | — (required) | Kettle Bluetooth address (`cosori-probe scan`) |
| `registrationKey` | — | 32-hex-char key. Without it the plugin will not connect; see [Registration key](#registration-key) |
| `connectionMode` | `persistent` | `persistent`: always connected, real-time. `onDemand`: connect for commands and a slow poll, then disconnect so the VeSync app can connect |
| `pollInterval` | `5` | Seconds between status polls while connected. The kettle also pushes changes on its own |
| `onDemandPollInterval` | `300` | On demand: seconds between background status checks |
| `idleDisconnect` | `30` | On demand: seconds idle before disconnecting. The plugin stays connected while the kettle is heating |
| `temperatureUnit` | `F` | Display unit in HomeKit (`F` or `C`) |
| `keepWarmMinutes` | `30` | Keep-warm duration, 1–60 |
| `delayStartMinutes` | `30` | Delay used by the Delay Start switch, 1–720 |
| `accessories.onBaseSensor` | `true` | "On Base" occupancy sensor |
| `accessories.keepWarmSwitch` | `true` | Keep Warm switch |
| `accessories.delayStartSwitch` | `false` | Delay Start switch |
| `accessories.presets.{boil,greenTea,oolong,coffee,myBrew}` | only `boil` | Preset switches |
| `dbusAddress` | `auto` | `auto` uses `/run/dbus-host/system_bus_socket` if present (Docker), else the system bus |
| `adapter` | first adapter | Bluetooth adapter to use: its MAC address (recommended, stable across reboots) or a name like `hci1`. See [Using a USB Bluetooth adapter](#using-a-usb-bluetooth-adapter). With several adapters and no setting, the plugin logs a warning listing them |
| `protocolVersion` | `auto` | `auto` detects it from firmware; `0` or `1` forces it |
| `debug` | `false` | Log every Bluetooth frame |

**Choosing a connection mode.** Connecting can take 10–40 s when the signal is weak, and HomeKit reports "No Response" after about 10 s. `persistent` pays that cost once and then responds instantly; choose it unless you need the VeSync app to connect regularly.

## HomeKit

| Service | Behaviour |
|---|---|
| **Thermostat** (main tile) | Set the target (40–100 °C / 104–212 °F) and switch Heat/Off. A target equal to a preset (180/195/205/212 °F) uses that preset; any other value is stored as the MyBrew temperature and heats in MyBrew mode. Changing the target while idle is remembered and applied when heating starts. Current temperature is smoothed to hide the sensor's ±1 °F flicker. |
| **On Base** (occupancy) | "Occupied" while the kettle is on its base. Heating is refused while it is off the base. |
| **Preset switches** | On = heating in that mode. Turning one on starts that preset; turning it off stops the kettle. |
| **Keep Warm** | Whether heating holds the temperature for `keepWarmMinutes` afterwards. Toggling it while heating updates the running kettle. |
| **Delay Start** | Schedules heating to the current target after `delayStartMinutes`, using the kettle's own timer, so it runs even if Bluetooth drops. On while scheduled; turning it off cancels. |

The kettle's controls on the base and the VeSync app keep working. Changes made there show up in HomeKit on the next poll, or instantly when the kettle pushes them.

**Schedules.** For "every weekday at 6:30", create a Home app automation (*Automation → A Time of Day → Kettle → Heat*). The Delay Start switch is for "start in N minutes" when you want the kettle to keep the time itself.

When the plugin cannot reach the kettle, its tiles show **No Response** after about 90 seconds (persistent mode). Commands tapped while it is reconnecting wait for up to 45 seconds.

## cosori-probe CLI

`cosori-probe` validates Bluetooth access, the key and the protocol on your hardware, independently of Homebridge. Run it inside the container:

```sh
docker exec -it homebridge cosori-probe <command> [args] [options]
```

| Command | Writes to kettle? | Purpose |
|---|---|---|
| `adapters` | no | List the host's Bluetooth adapters with MAC address and power state, for the `adapter` setting |
| `scan [--all] [--duration 10]` | no | List nearby kettles, matched by name or Etekcity manufacturer ID, with MAC and RSSI |
| `info <mac>` | no | Connect, read model/firmware (Device Information Service), detect protocol version, show GATT flags |
| `key-from-log <file>` | — (offline) | Find and verify the app's key in a PacketLogger capture (`.pklg`, or a text export with raw bytes) |
| `key-from-packets <p1> <p2> <p3>` | — (offline) | Extract the key from the three hello writes, pasted as hex |
| `status <mac> --key K` | hello + poll | Verify the key, print one decoded status |
| `watch <mac> --key K [--interval 2]` | hello + polls | Live status until Ctrl-C |
| `pair <mac> --yes` | register | Register a new key (hold MyBrew) |
| `set-mybrew <mac> <°F> --key K --yes` | F3 | Store the MyBrew temperature |
| `hold <mac> <minutes> --key K --yes` | F2 | Set keep-warm time |
| `start <mac> <mode> --key K --yes [--hold-min N] [--temp F]` | F0 (+F3) | Start `boil` / `green` / `oolong` / `coffee` / `mybrew` |
| `delay <mac> <minutes> <mode> --key K --yes [--hold-min N] [--temp F]` | F1 (+F3) | Schedule heating on the kettle's own timer (like the app's Delay Start) |
| `stop <mac> --key K --yes` | F4 | Stop heating, or cancel a scheduled delay |
| `decode-log <file.pklg>` | — (offline) | List every frame in a PacketLogger capture, decoded, key redacted |

Common options: `--raw` (print every frame in hex), `--verbose`, `--dbus <path|address>`, `--adapter <MAC|hciN>`, `--protocol 0|1`, `--write-mode request|command`. You can put the key in the `COSORI_KEY` environment variable instead of passing `--key`:

```sh
docker exec -it -e COSORI_KEY=7f86… homebridge cosori-probe watch AA:BB:CC:DD:EE:FF --raw
```

Commands that change kettle state require `--yes`, and every such command prints the kettle's status before and after. The probe only sends the documented commands listed above; it never makes exploratory writes.

### Validation checklist (Checkpoint A)

1. `scan` shows the kettle (close the VeSync app first).
2. `info <mac>` prints the firmware versions and the detected protocol version.
3. `key-from-packets …` recovers your key.
4. `status <mac> --key K` prints "Hello accepted" and a sensible temperature and on-base state.
5. `watch <mac> --key K --raw` for a minute while you lift the kettle off the base and put it back.

## The one-connection limitation

The kettle accepts **only one BLE connection at a time**. While the plugin or probe is connected, the VeSync app cannot connect, and vice versa. While another client is connected, the kettle also stops advertising, so `scan` won't show it. Fully close the VeSync app (force-quit it) before running the probe.

The plugin will offer an **on-demand** connection mode that connects briefly for each command or slow poll and then disconnects, leaving room for the app.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `D-Bus connection … failed: connect ENOENT` | The host socket isn't mounted. Add `- /run/dbus:/run/dbus-host:ro` and recreate the container. |
| `BlueZ adapter lookup … timed out` / `org.bluez was not provided` | `bluetoothd` isn't running on the host: `sudo systemctl enable --now bluetooth`. |
| `adapter … is powered off` | `sudo rfkill unblock bluetooth && sleep 2 && bluetoothctl power on` on the host. A newly plugged-in USB adapter usually starts soft-blocked. |
| `Bluetooth adapter "…" not found. Available: …` | The `adapter` setting doesn't match any adapter. Check the list in the message (or `cosori-probe adapters`), and use the adapter's MAC address. |
| `Found 2 Bluetooth adapters … using the first` (warning) | Set `adapter` to the MAC address of the one you want. See [Using a USB Bluetooth adapter](#using-a-usb-bluetooth-adapter). |
| `AccessDenied` | The container isn't running as root, or AppArmor is blocking it. See [Host setup](#host-setup-raspberry-pi--debian) and the `security_opt` row in [Docker changes](#docker-changes). |
| `not found while scanning` / `scan` finds nothing | The kettle is out of range or unpowered, or the VeSync app is connected to it. **Raspberry Pi 4 in a metal case (e.g. Argon ONE):** the onboard antenna is heavily shielded and may not hear the kettle even at 3 m. Use a USB Bluetooth adapter on a short extension cable (see [Using a USB Bluetooth adapter](#using-a-usb-bluetooth-adapter)). |
| `le-connection-abort-by-local` / connect timeouts | Usually radio coexistence on the Pi 4 (see Host setup), or discovery running during connect. Retry. |
| `kettle rejected the registration key` | Wrong key. Re-capture it (Option A) or pair (Option B). |
| `not in pairing mode` | Hold the MyBrew button until the kettle signals pairing mode, then retry. |
| Temperature reads 1–3 °F below the setpoint while holding | Normal kettle behaviour. |
| `usocket@0.3.0 install` … `gyp ERR! Completion callback never invoked!` in an npm install log (for example when installing or updating any plugin) | Harmless. `usocket` is an optional native dependency of `dbus-next` (via `node-ble`), and its bundled node-gyp 7 can't build on Node 24. npm skips it and the install succeeds. Without it, `dbus-next` connects to the system bus with Node's own `net` socket, which is all this plugin needs. The warning comes back on every npm install in `/homebridge`, and a plugin can't silence it from its own `package.json`. |

## Protocol notes

These notes are based on the reverse-engineering work in the projects listed under [Credits](#credits), checked against real captured packets (see `test/fixtures/captures.ts`). The upstream docs differ from the captures in a few places; this implementation follows the captures. **The full verified reference, with the evidence for each field and a list of corrections to upstream, is in [docs/PROTOCOL.md](docs/PROTOCOL.md).**

- **Framing:** `A5 | type | seq | len_lo | len_hi | checksum | payload`. Type `0x22` is used for commands, and for status and completion frames the kettle sends on its own. Type `0x12` is used for ACKs and the extended status.
- **Checksum:** start at 0 and subtract every byte of the frame, treating the checksum byte itself as `0x01`, then take the result mod 256. This single rule matches every capture, for both V0 and V1. The "sum of header bytes" formula in upstream docs does not match real traffic.
- **Handshake:** first-time pairing is register (`80 D1`) followed by hello (`81 D1`). After that, hello alone. The key is sent as 32 ASCII hex characters. On first pairing, hello must not be sent before register.
- **16-bit fields are little-endian:** this covers the hold time in F2, F0 (start) and the status frames, and the F1 delay. One upstream library sends F0's hold big-endian. A capture of the VeSync app starting Green Tea with a 30-minute hold settles it: `01 F0 A3 00 01 00 01 08 07` is `0x0708` = 1800 s, so the field is little-endian. The app also sends `00` in F0's temperature byte for presets.
- **Delayed start (F1)** is a little-endian delay in seconds followed by exactly the F0 body: `01 F1 A3 00 | DC 05 | 01 00 01 08 07` means Green Tea in 1500 s (25 min) with a 1800 s hold. Verified from a VeSync-app capture. While a delay is pending, the kettle reports **stage 5**, which is not in upstream docs. The app cancels a delay with a plain stop (F4).
- **ACKs to F0, F1, F3 and F4 have no status byte.** Only register and hello replies carry one.
- **Tapping a preset in the VeSync app sends nothing.** The app keeps the selection locally until you press Start or Set Schedule.
- **Lifting the kettle** makes it push a compact status immediately, with payload `[9] = 01`. The extended status `[14]` confirms it on the next poll.
- **Extended status `[24–25]`** holds the app's saved "Hold Temp" duration (little-endian seconds), and `[23]` appears to be its on/off flag.
- **Extended status offsets** (payload): `[4]` stage, `[5]` mode, `[6]` setpoint °F, `[7]` current temperature °F, `[8]` MyBrew °F, `[10–11]` configured hold (LE), `[12–13]` remaining hold (LE), `[14]` on-base (`00` = on base), `[26]` baby-formula mode.
- All temperatures on the wire are °F. The setpoint range is 104–212 °F; readings outside 40–230 °F are discarded.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test          # protocol + client tests against captured packets, no hardware needed
npm run build
```

CI runs lint, type-check, build and tests on Node 22, 24 and 26.

## Credits

This is an independent TypeScript implementation. The BLE protocol knowledge, and the captured packets used as test fixtures, come from:

- **[CosoriKettleBLE](https://github.com/barrymichels/CosoriKettleBLE)** by Barry Michels ([@barrymichels](https://github.com/barrymichels)): the original reverse-engineering and ESPHome component, and the handshake-extraction guide.
- **[ha-cosori-kettle](https://github.com/rygwdn/ha-cosori-kettle)** by Ryan Wooden ([@rygwdn](https://github.com/rygwdn)): the Home Assistant integration and Python library, which added the V1 protocol, register/pairing, presets and hold.

Both projects state they are MIT-licensed, although neither repository currently contains a LICENSE file. No source code was copied from either.

"Cosori" and "VeSync" are trademarks of their respective owners. This project is not affiliated with or endorsed by them.

## License

[MIT](LICENSE)
