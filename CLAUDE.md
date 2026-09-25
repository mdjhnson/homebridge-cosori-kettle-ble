# CLAUDE.md — homebridge-cosori-kettle-ble

Homebridge dynamic-platform plugin (TypeScript, ESM) that controls a **Cosori Smart Gooseneck Kettle** over BLE through BlueZ/D-Bus (`node-ble`), designed to run in the `homebridge/homebridge` Docker image. Repo: https://github.com/mdjhnson/homebridge-cosori-kettle-ble (public, not published to npm).

**Read first:**
- `docs/STATUS.md`: current state, what's deployed, open issues, next steps.
- `docs/PROTOCOL.md`: the verified protocol reference. Treat it as the source of truth over upstream docs.
- `docs/FUTURE-WORK.md`: agreed ideas that are deliberately deferred.
- `docs/local/` (gitignored, may not exist): private deployment notes for the maintainer's Pi.

## Commands

```sh
npm run lint        # eslint, --max-warnings=0
npm run typecheck   # tsc over src + test
npm test            # vitest (≈300 tests, no hardware)
npm run build       # tsc -p tsconfig.build.json → dist/
npm pack            # tarball for installing into the Homebridge container
node dist/cli/probe.js help   # cosori-probe diagnostic CLI
```

Before every commit, run lint, typecheck, test and build, and **gate the commit on them passing**. Don't chain `git commit` after a test run whose failure you don't check. CI (`.github/workflows/ci.yml`) runs the same steps on Node 22, 24 and 26.

## Layout

| Path | What |
|---|---|
| `src/protocol/` | Pure protocol: constants, checksum, framing plus streaming parser, command builders, status decoders, key handling, `.pklg` reader, V0/V1 detection |
| `src/ble/` | `Transport` interface; `NodeBleTransport` (BlueZ over D-Bus, Docker socket auto-detect, adapter selection by MAC or hciN) |
| `src/kettle/` | `KettleClient` (seq/ACK, hello/register, commands, status events); `ConnectionManager` (persistent/on-demand loop, backoff, command queue) |
| `src/accessory/` | `KettleAccessory` (HAP services); `mapping.ts` (°F↔°C, smoothing, names), pure and unit-tested |
| `src/platform.ts`, `src/config.ts` | Homebridge platform; defensive config parsing |
| `src/cli/probe.ts` | `cosori-probe`: adapters, scan, info, key-from-log, key-from-packets, decode-log, status, watch, pair, set-mybrew, hold, start, delay, stop |
| `test/fixtures/captures.ts` | **Real captured frames** (upstream projects, plus `OWN_KETTLE_FRAMES` from the maintainer's kettle). Add every new real capture here |
| `test/kettle/FakeTransport.ts` | Scriptable fake kettle used by client, manager and accessory tests |
| `test/accessory/harness.ts` | Real `@homebridge/hap-nodejs` with a fake PlatformAccessory, for testing GET/SET handlers |

## Rules for this project

- **Only send documented writes to FFF2.** Every command must come from the prior art or from a capture of the VeSync app. No exploratory writes. A new command needs a capture first: have the user record a PacketLogger trace, then run `cosori-probe decode-log`.
- **The registration key is a secret.** Never print it, commit it, or pass it on a command line. Pipe it via stdin/env and redact the hello frames in logs (the probe's `decode-log` and `key-from-log` already redact). The key lives in Homebridge `config.json` on the Pi.
- **Upstream docs are wrong in places.** See `docs/PROTOCOL.md` ("Corrections to upstream"). Verify against captures, not prose.
- **Any state-changing command on real hardware needs the user's go-ahead**, with water in the kettle when heating could happen. Prefer `--cancel-after` style tests that always clean up.
- **Changes on the user's Pi:** ask before installs, config edits and restarts. Back up `config.json` first. For plugin updates, restart **only the kettle's child bridge**, never the whole container.
- Keep HAP service names plain (letters, digits, spaces). HAP rejects names like `Boil (212°F)`.
- Code style: follow the existing code (template eslint rules, 2-space indent, single quotes, curly braces always).

## Environment gotchas (maintainer's machines)

- In zsh on the Mac, `USERNAME` is a special variable. Never use it as a scratch variable (it caused an invalid child-bridge ID once).
- Foreground `sleep` in tool calls is blocked. Wait with `until …; do sleep N; done` or a background command.
- To time-limit the probe, run `timeout` **inside** the container (`docker exec homebridge timeout -s INT 60 cosori-probe …`). Killing `docker exec` from outside leaves the probe connected.
- `docker exec … cosori-probe` works because the image puts `/homebridge/node_modules/.bin` on PATH. The plugin's dependencies install nested under `node_modules/homebridge-cosori-kettle-ble/node_modules`.
