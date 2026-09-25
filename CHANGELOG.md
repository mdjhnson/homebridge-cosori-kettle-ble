# Changelog

All notable changes to this plugin. Versions follow [semver](https://semver.org); while in `0.x`, a minor version may change the config or the Home app tiles.

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
