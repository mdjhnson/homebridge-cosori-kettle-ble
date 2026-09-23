# homebridge-cosori-kettle-ble

Control a **Cosori Smart Gooseneck Electric Kettle** (0.8 L, Bluetooth — normally used with the VeSync app) from Apple HomeKit via [Homebridge](https://homebridge.io), talking to the kettle directly over Bluetooth LE.

> **Status: pre-release (Checkpoint A).** The protocol library and the `cosori-probe` diagnostic CLI are ready for testing on real hardware. The HomeKit layer is not implemented yet — installing the plugin now only adds the probe tool. Not published to npm.

- BLE via [node-ble](https://github.com/chrvadala/node-ble) (BlueZ over D-Bus): **no privileged container, no capabilities, no `/dev` passthrough, no native modules**.
- Works in the official `homebridge/homebridge` Docker image with host networking and the host D-Bus socket mounted.

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Host setup (Raspberry Pi / Debian)](#host-setup-raspberry-pi--debian)
- [Docker changes](#docker-changes)
- [Install (pre-release)](#install-pre-release)
- [Registration key](#registration-key)
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
- Node.js 22.10+ or 24 (the current `homebridge/homebridge` image ships a supported version).
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
scp homebridge-cosori-kettle-ble-0.1.0.tgz argonpi:/tmp/
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

Reusing the app's key keeps the VeSync app working with the kettle. You capture the hello the app sends when it connects, then extract the key with `cosori-probe key-from-packets`.

**iPhone (with a Mac):**

1. On the iPhone, install Apple's **Bluetooth logging profile** from [developer.apple.com/bug-reporting/profiles-and-logs](https://developer.apple.com/bug-reporting/profiles-and-logs/) (search "Bluetooth"), and reboot as instructed.
2. On the Mac, install **PacketLogger** (in *Additional Tools for Xcode*, from [developer.apple.com/download/all](https://developer.apple.com/download/all/)).
3. Connect the iPhone by cable, open PacketLogger → *File → New iOS Trace*.
4. Open the VeSync app and connect to the kettle.
5. In PacketLogger, find three consecutive **ATT Write Request/Command** packets to the kettle: the first value starts with `A5 22 xx 24 00` and is 20 bytes, the second is 20 bytes, and the third is 2 bytes.
6. Copy the three **values** (the bytes starting at `A5`; if you copy the whole ATT PDU, the probe skips the prefix).

**Android:**

1. *Settings → Developer options → Enable Bluetooth HCI snoop log*, then toggle Bluetooth off and on.
2. Open the VeSync app and connect to the kettle.
3. `adb bugreport bugreport.zip`, then extract `FS/data/misc/bluetooth/logs/btsnoop_hci.log` (the path varies by vendor).
4. Open it in Wireshark with the filter `btatt.opcode == 0x12 || btatt.opcode == 0x52`, and find the three consecutive writes described in step 5 above.

Then, anywhere the package is installed:

```sh
cosori-probe key-from-packets "A5 22 04 24 00 2E 01 81 D1 00 37 66 …" "65 30 35 …" "64 63"
# → Registration key: 7f868962cde056b60b5403433ad42bdc
```

The probe verifies the frame checksum, so a mistyped or reordered packet is rejected rather than producing a wrong key.

### Option B — pair as a new client

```sh
docker exec -it homebridge cosori-probe pair AA:BB:CC:DD:EE:FF --yes
```

The probe generates a random key and asks you to **press and hold the MyBrew button** to put the kettle into pairing mode. It then registers the key and verifies it with a hello. It is **not yet known whether registering a new key unpairs the VeSync app**, so use Option A if you rely on the app.

## cosori-probe CLI

`cosori-probe` validates Bluetooth access, the key and the protocol on your hardware, independently of Homebridge. Run it inside the container:

```sh
docker exec -it homebridge cosori-probe <command> [args] [options]
```

| Command | Writes to kettle? | Purpose |
|---|---|---|
| `scan [--all] [--duration 10]` | no | List nearby kettles (and their MAC addresses) |
| `info <mac>` | no | Connect, read model/firmware (Device Information Service), detect protocol version, show GATT flags |
| `key-from-packets <p1> <p2> <p3>` | — (offline) | Extract the registration key from a captured app hello |
| `status <mac> --key K` | hello + poll | Verify the key, print one decoded status |
| `watch <mac> --key K [--interval 2]` | hello + polls | Live status until Ctrl-C |
| `pair <mac> --yes` | register | Register a new key (hold MyBrew) |
| `set-mybrew <mac> <°F> --key K --yes` | F3 | Store the MyBrew temperature |
| `hold <mac> <minutes> --key K --yes` | F2 | Set keep-warm time |
| `start <mac> <mode> --key K --yes [--hold-min N] [--temp F]` | F0 (+F3) | Start `boil` / `green` / `oolong` / `coffee` / `mybrew` |
| `stop <mac> --key K --yes` | F4 | Stop heating |

Common options: `--raw` (print every frame in hex), `--verbose`, `--dbus <path|address>`, `--adapter hci1`, `--protocol 0|1`, `--write-mode request|command`. You can put the key in the `COSORI_KEY` environment variable instead of passing `--key`:

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
| `adapter is powered off` | `sudo rfkill unblock bluetooth && bluetoothctl power on` on the host. |
| `AccessDenied` | The container isn't running as root, or AppArmor is blocking it. See [Host setup](#host-setup-raspberry-pi--debian) and the `security_opt` row in [Docker changes](#docker-changes). |
| `not found while scanning` | The kettle is out of range or unpowered, or the VeSync app is connected to it. |
| `le-connection-abort-by-local` / connect timeouts | Usually radio coexistence on the Pi 4 (see Host setup), or discovery running during connect. Retry. |
| `kettle rejected the registration key` | Wrong key. Re-capture it (Option A) or pair (Option B). |
| `not in pairing mode` | Hold the MyBrew button until the kettle signals pairing mode, then retry. |
| Temperature reads 1–3 °F below the setpoint while holding | Normal kettle behaviour. |

## Protocol notes

These notes are based on the reverse-engineering work in the projects listed under [Credits](#credits), checked against real captured packets (see `test/fixtures/captures.ts`). The upstream docs differ from the captures in a few places; this implementation follows the captures.

- **Framing:** `A5 | type | seq | len_lo | len_hi | checksum | payload`. Type `0x22` is used for commands, and for status and completion frames the kettle sends on its own. Type `0x12` is used for ACKs and the extended status.
- **Checksum:** start at 0 and subtract every byte of the frame, treating the checksum byte itself as `0x01`, then take the result mod 256. This single rule matches every capture, for both V0 and V1. The "sum of header bytes" formula in upstream docs does not match real traffic.
- **Handshake:** first-time pairing is register (`80 D1`) followed by hello (`81 D1`). After that, hello alone. The key is sent as 32 ASCII hex characters. On first pairing, hello must not be sent before register.
- **16-bit fields are little-endian:** this covers the hold time in F2 and in the status frames, and the F1 delay. The hold field in F0 (start) is little-endian in captures but big-endian in one upstream library; it is flagged for on-device verification (`start … --hold-min 5`, with or without `--hold-be`).
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

CI runs lint, type-check, build and tests on Node 22 and 24.

## Credits

This is an independent TypeScript implementation. The BLE protocol knowledge, and the captured packets used as test fixtures, come from:

- **[CosoriKettleBLE](https://github.com/barrymichels/CosoriKettleBLE)** by Barry Michels ([@barrymichels](https://github.com/barrymichels)): the original reverse-engineering and ESPHome component, and the handshake-extraction guide.
- **[ha-cosori-kettle](https://github.com/rygwdn/ha-cosori-kettle)** by Ryan Wooden ([@rygwdn](https://github.com/rygwdn)): the Home Assistant integration and Python library, which added the V1 protocol, register/pairing, presets and hold.

Both projects state they are MIT-licensed, although neither repository currently contains a LICENSE file. No source code was copied from either.

"Cosori" and "VeSync" are trademarks of their respective owners. This project is not affiliated with or endorsed by them.

## License

[MIT](LICENSE)
