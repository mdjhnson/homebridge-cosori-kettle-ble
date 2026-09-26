# Changelog

All notable changes to this plugin. Versions follow [semver](https://semver.org); while in `0.x`, a minor version may change the config or the Home app tiles.

## Unreleased

## 0.3.0-beta.2 (2026-09-26)

Published under the `next` dist-tag.

### Changes

- **A command that a dropped Bluetooth link cuts off is now sent again after the reconnect.** On a weak link the kettle can go silent for a few seconds before the drop is noticed. A tap, a Siri request or an automation sent in that window used to fail and turn the switch back off. Now it's sent once more when the link is back, as long as that's within 30 s. The log shows `Sending "Green Tea (180°F)" again: the link dropped before the kettle confirmed it`.
- **Commands reach the kettle one at a time, in the order you sent them.** A Stop sent while a Heat is still waiting goes after it, so the kettle ends up off. A new target temperature set while a Heat is waiting is sent after it, so that's the one it heats to. This also fixes a rare case where a command could land between the two writes of a custom-temperature heat.
- When a Bluetooth write fails, the log now includes BlueZ's reason.
- When Homebridge stops the plugin, commands still waiting fail at once instead of waiting for their timeout.

## 0.3.0-beta.1 (2026-09-25)

Published under the `next` dist-tag.

### Changes

- **Bluetooth now goes through a small built-in BlueZ client on `@homebridge/dbus-native`** (the D-Bus library Homebridge already installs) instead of `node-ble`. Nothing to change in your config. This removes all 11 `npm audit` findings, the deprecated-package warnings, and the `usocket` `gyp ERR!` from npm install logs.
- If the kettle drops the link while the plugin is still connecting, the attempt now fails at once instead of waiting 30 s or reporting a connection that is already gone.
- Bluetooth events are accepted only from BlueZ itself. Another program on the host's system bus can no longer feed the plugin fake kettle status or fake disconnects.
- If the connection to the system D-Bus itself is lost, the plugin now treats it as a dropped link and reconnects right away, instead of waiting for status polls to fail.

## 0.2.0-beta.1 (2026-09-25)

The first release on npm, published under the `next` dist-tag. Earlier builds (`0.1.0`) were only installed from tarballs.

### Features

- Thermostat tile for the kettle: current water temperature, target temperature (104–212 °F or 40–100 °C) and Heat/Off. A target that matches a kettle preset uses that preset; any other target heats in MyBrew mode.
- **Temperature switches:** an editable list in the plugin settings (name and temperature, °F or °C). Each item is a switch that heats to its temperature and shows On while the kettle heats or holds at it. The default list is the kettle's four presets: Green Tea, Oolong, Coffee and Boil.
- Keep Warm switch, with the hold time set by `keepWarmMinutes`.
- "On Base" occupancy sensor.
- Persistent or on-demand Bluetooth connection, with reconnects after a dropped link that are logged.
- Bluetooth adapter selection by MAC address or `hciN` name.
- `cosori-probe` CLI for setup and diagnostics: scanning, reading the registration key from a VeSync app capture, status, pairing and test commands.

### Changes since the 0.1.0 tarball builds

- The fixed preset checkboxes (`accessories.presets`) became the temperature switch list. Old configs are migrated automatically and keep their tiles.
- **Removed: the MyBrew switch.** Add a switch with your own temperature instead.
- **Removed: the Delay Start switch** (`accessories.delayStartSwitch`, `delayStartMinutes`). Use a Home app automation, or ask Siri ("at 6:30 turn on Green Tea"). Its tile is removed on the next start.
- Fixed: after changing from one custom temperature to another while heating, the target and the switches showed the old temperature until the next full status.
