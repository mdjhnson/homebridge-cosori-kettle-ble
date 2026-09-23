#!/usr/bin/env node
/**
 * cosori-probe — standalone diagnostic CLI for the Cosori Smart Gooseneck kettle.
 *
 * Validate BLE connectivity and the protocol on real hardware before using the Homebridge plugin.
 * Read-only commands never write to the kettle except the documented hello/poll; state-changing
 * commands require --yes. Run `cosori-probe help` for usage.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { NodeBleTransport, resolveDbusAddress, type ScanResult, type WriteMode } from '../ble/NodeBleTransport.js';
import { InvalidRegistrationKeyError, NotInPairingModeError } from '../kettle/errors.js';
import { describeCompletion, KettleClient, type KettleStatus } from '../kettle/KettleClient.js';
import {
  ADVERTISED_NAME, ETEKCITY_COMPANY_ID, findHandshakesInLog, generateKey, keyFromHelloPackets, keyToHex, MAX_HOLD_SECONDS, Mode, MODE_NAMES, parseKey,
  PRESET_TEMP_F, ProtocolVersion, STAGE_NAMES, toHex,
} from '../protocol/index.js';
import { delay, errorMessage } from '../util/async.js';
import { consoleLogger, type Logger } from '../util/log.js';
import { fToC, round1 } from '../util/temperature.js';

const USAGE = `cosori-probe — Cosori Smart Gooseneck Kettle BLE probe

Usage: cosori-probe <command> [args] [options]

Read-only:
  scan                         Scan for BLE devices (Cosori kettles highlighted; --all shows everything)
  info <mac>                   Connect, read device info / firmware, detect protocol version, show GATT flags
  key-from-log <file>          Find the VeSync app's registration key in a PacketLogger text export (offline)
  key-from-packets <p1> <p2> <p3>
                               Recover the key from the 3 hello writes, pasted as hex (offline)
  status <mac>                 Hello with --key, poll once, print decoded status
  watch <mac>                  Hello with --key, poll every --interval seconds and print live status (Ctrl-C to stop)

Changes kettle state (require --yes; documented commands only):
  pair <mac>                   Register a NEW key (hold MyBrew to enter pairing mode). May unpair the VeSync app.
  set-mybrew <mac> <°F>        Store the MyBrew temperature (104–212 °F)
  hold <mac> <minutes>         Set keep-warm time (0–60 min, 0 = off)
  start <mac> <mode>           Start heating. mode: boil | green | oolong | coffee | mybrew
                                 --hold-min N    keep warm N minutes afterwards
                                 --temp F        target °F (required for mybrew; for presets overrides byte[5])
                                 --hold-be       encode the hold field big-endian (encoding verification only)
  stop <mac>                   Stop heating / keep-warm

Options:
  --key <hex>                  32-hex-char registration key (or env COSORI_KEY)
  --dbus <address|path|auto>   D-Bus system bus (default auto: /run/dbus-host/system_bus_socket if present)
  --adapter <hciN>             BlueZ adapter (default: first adapter)
  --protocol <auto|0|1>        Payload version byte (default auto from firmware)
  --write-mode <auto|request|command>
                               GATT write type for FFF2 (default auto)
  --interval <s>               Poll interval for watch (default 2)
  --duration <s>               Scan duration (default 10)
  --raw                        Print every frame in hex
  --verbose                    Debug logging
  --yes                        Confirm state-changing commands
  --all                        scan: list every device, not only kettles
`;

const MODE_ARGS: Record<string, number> = {
  boil: Mode.BOIL,
  green: Mode.GREEN_TEA,
  'green-tea': Mode.GREEN_TEA,
  oolong: Mode.OOLONG,
  coffee: Mode.COFFEE,
  mybrew: Mode.MY_BREW,
};

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

type Flags = {
  key?: string;
  dbus?: string;
  adapter?: string;
  protocol?: string;
  'write-mode'?: string;
  interval?: string;
  duration?: string;
  'hold-min'?: string;
  temp?: string;
  'hold-be'?: boolean;
  raw?: boolean;
  verbose?: boolean;
  yes?: boolean;
  all?: boolean;
  help?: boolean;
};

class UsageError extends Error {}

function fmtTemp(f: number | undefined): string {
  return f === undefined ? '—' : `${f}°F (${round1(fToC(f))}°C)`;
}

function formatStatus(s: KettleStatus): string {
  const parts = [
    `stage=${STAGE_NAMES[s.stage] ?? `0x${s.stage.toString(16)}`}`,
    `mode=${MODE_NAMES[s.mode] ?? `0x${s.mode.toString(16)}`}`,
    `temp=${fmtTemp(s.tempF)}`,
    `setpoint=${fmtTemp(s.setpointF)}`,
    `mybrew=${fmtTemp(s.myTempF)}`,
    `hold=${s.remainingHoldSeconds}s left / ${s.configuredHoldSeconds}s set`,
    `onBase=${s.onBase === undefined ? '?' : s.onBase ? 'yes' : 'NO'}`,
  ];
  if (s.babyFormula) {
    parts.push('babyFormula=on');
  }
  return parts.join('  ');
}

function requireMac(value: string | undefined): string {
  if (!value || !MAC_RE.test(value)) {
    throw new UsageError(`expected a MAC address like AA:BB:CC:DD:EE:FF (got ${value ?? 'nothing'})`);
  }
  return value.toUpperCase();
}

function requireKey(flags: Flags): Buffer {
  const raw = flags.key ?? process.env.COSORI_KEY;
  if (!raw) {
    throw new UsageError('this command needs --key <32 hex chars> (or COSORI_KEY). Get one with key-from-packets or pair.');
  }
  return parseKey(raw);
}

function requireYes(flags: Flags, what: string): void {
  if (!flags.yes) {
    throw new UsageError(`${what} changes the kettle's state; re-run with --yes to confirm`);
  }
}

function parseNumber(value: string | undefined, name: string, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || !Number.isFinite(n) || n < min || n > max) {
    throw new UsageError(`${name} must be a number between ${min} and ${max} (got ${value ?? 'nothing'})`);
  }
  return n;
}

function protocolOption(flags: Flags): 'auto' | ProtocolVersion {
  switch (flags.protocol ?? 'auto') {
  case 'auto':
    return 'auto';
  case '0':
    return ProtocolVersion.V0;
  case '1':
    return ProtocolVersion.V1;
  default:
    throw new UsageError('--protocol must be auto, 0 or 1');
  }
}

function writeModeOption(flags: Flags): WriteMode {
  const mode = flags['write-mode'] ?? 'auto';
  if (mode !== 'auto' && mode !== 'request' && mode !== 'command') {
    throw new UsageError('--write-mode must be auto, request or command');
  }
  return mode;
}

/** Map common failures to an actionable hint. */
function hintFor(err: unknown): string | undefined {
  const msg = errorMessage(err);
  if (/ENOENT|ECONNREFUSED/.test(msg)) {
    return 'D-Bus socket not reachable. In Docker, mount the host bus: `- /run/dbus:/run/dbus-host:ro` (see README).';
  }
  if (/AccessDenied|not allowed/i.test(msg)) {
    return 'D-Bus policy denied access to BlueZ. Run as root in the container, or install a BlueZ D-Bus policy for this user (see README).';
  }
  if (/adapter lookup|No adapter|ServiceUnknown|org\.bluez was not provided/i.test(msg)) {
    return 'BlueZ not reachable. On the host: `systemctl status bluetooth`, `bluetoothctl show`.';
  }
  if (/not found while scanning|le-connection-abort|Software caused connection abort|BLE connect timed out/i.test(msg)) {
    return 'Kettle not reachable. Make sure it is powered, within range, and the VeSync app is fully closed (the kettle accepts only ONE connection).';
  }
  if (err instanceof InvalidRegistrationKeyError) {
    return 'Use the key captured from the VeSync app (key-from-packets), or register a new one with `pair`.';
  }
  if (err instanceof NotInPairingModeError) {
    return 'Press and hold the MyBrew button until the kettle signals pairing mode, then retry.';
  }
  return undefined;
}

async function withClient<T>(mac: string, flags: Flags, log: Logger, fn: (client: KettleClient) => Promise<T>): Promise<T> {
  const transport = new NodeBleTransport(mac, {
    dbusAddress: flags.dbus ?? 'auto',
    adapter: flags.adapter,
    writeMode: writeModeOption(flags),
    log,
  });
  const client = new KettleClient(transport, {
    protocolVersion: protocolOption(flags),
    log,
    traceFrames: false,
  });
  if (flags.raw) {
    client.on('frame', (dir, bytes) => log.info(`${dir === 'tx' ? 'TX →' : 'RX ←'} ${toHex(bytes)}`));
  }
  client.on('completion', (code) => {
    log.info(`Kettle says: ${describeCompletion(code)}`);
  });

  const stopSignals = () => {
    log.info('Interrupted, disconnecting…');
    void client.destroy().finally(() => process.exit(130));
  };
  process.once('SIGINT', stopSignals);
  process.once('SIGTERM', stopSignals);

  log.info(`Connecting to ${mac} (D-Bus: ${resolveDbusAddress(flags.dbus ?? 'auto') ?? 'default system bus'})…`);
  try {
    await client.connect();
    const info = client.deviceInfo;
    log.info(`Connected. model=${info.model ?? '?'} manufacturer=${info.manufacturer ?? '?'} hw=${info.hardwareRevision ?? '?'} `
      + `sw=${info.softwareRevision ?? '?'} → protocol V${client.protocolVersion}`);
    return await fn(client);
  } finally {
    process.off('SIGINT', stopSignals);
    process.off('SIGTERM', stopSignals);
    await client.destroy().catch(() => undefined);
  }
}

async function authenticate(client: KettleClient, flags: Flags, log: Logger): Promise<void> {
  await client.hello(requireKey(flags));
  log.info('Hello accepted — registration key is valid.');
}

async function reportAfterWrite(client: KettleClient, before: KettleStatus, log: Logger): Promise<void> {
  log.info(`Before: ${formatStatus(before)}`);
  await delay(1500);
  const after = await client.poll();
  log.info(`After:  ${formatStatus(after)}`);
}

function looksLikeKettle(r: ScanResult): boolean {
  return r.manufacturerIds.includes(ETEKCITY_COMPANY_ID) || !!r.name?.toLowerCase().includes('cosori');
}

async function cmdScan(flags: Flags, log: Logger): Promise<void> {
  const durationMs = parseNumber(flags.duration ?? '10', '--duration', 1, 120) * 1000;
  log.info(`Scanning for ${durationMs / 1000}s…`);
  const results = await NodeBleTransport.scan({ dbusAddress: flags.dbus ?? 'auto', adapter: flags.adapter, durationMs, log });
  const kettles = results.filter(looksLikeKettle);
  const shown = (flags.all ? results : kettles).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  for (const r of shown) {
    const star = looksLikeKettle(r) ? '★ ' : '  ';
    const mfr = r.manufacturerIds.length ? `  mfr=${r.manufacturerIds.map((id) => `0x${id.toString(16).padStart(4, '0')}`).join(',')}` : '';
    console.log(`${star}${r.address}  rssi=${r.rssi ?? '?'}  name=${r.name ?? '(none)'}${mfr}`);
  }
  if (kettles.length === 0) {
    log.warn(`No kettle found (${results.length} devices seen). A kettle advertises as "${ADVERTISED_NAME}" with Etekcity manufacturer data. `
      + 'Make sure the VeSync app is closed and the kettle is in range (the Pi 4 onboard radio is weak in metal cases); try --all.');
  } else {
    log.info(`${kettles.length} kettle(s) found. Weak signal (below about -85 dBm) means connections may be unreliable.`);
  }
}

async function cmdInfo(mac: string, flags: Flags, log: Logger): Promise<void> {
  // Read-only: no frames are written. withClient already printed DIS + detected version.
  await withClient(mac, flags, log, async (client) => {
    log.info(`FFF2 (TX) GATT flags: ${(await client.txFlags()).join(', ') || '(none reported)'}`);
    log.info('No commands sent. Use `status --key …` to test a registration key.');
  });
}

function cmdKeyFromPackets(packets: string[]): void {
  if (packets.length === 0) {
    throw new UsageError('pass the three captured hello packets as hex strings, in order');
  }
  const key = keyFromHelloPackets(packets);
  console.log(`Registration key: ${keyToHex(key)}`);
  console.log('Next: cosori-probe status <mac> --key ' + keyToHex(key));
}

function cmdKeyFromLog(file: string | undefined): void {
  if (!file) {
    throw new UsageError('pass the path of a PacketLogger text export (File → Export… as text)');
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ${errorMessage(err)}`);
  }
  if (text.slice(0, 4096).includes('\u0000')) {
    throw new UsageError(`${file} looks binary (a .pklg file?). In PacketLogger use File → Export… and save as text.`);
  }
  const result = findHandshakesInLog(text);
  console.log(`Scanned ${result.writeLines} ATT write line(s) and ${result.notifyLines} notification line(s).`);
  if (result.handshakes.length === 0) {
    const why = result.writeLines === 0
      ? 'No "ATT Send … Write Request" lines with raw hex bytes were found. Check the export includes the raw packet bytes, '
        + 'and that the trace covers the moment the VeSync app connected to the kettle.'
      : 'Writes were found but none formed a valid hello/register frame. The capture may have started after the app connected: '
        + 'force-quit the app, start a new trace, then open the app again.';
    throw new Error(`no registration handshake found. ${why}`);
  }
  const unique = new Map<string, typeof result.handshakes[number]>();
  for (const h of result.handshakes) {
    unique.set(keyToHex(h.key), h);
  }
  for (const [key, h] of unique) {
    const verdict = h.ackStatus === undefined
      ? 'kettle reply not in the log (key not yet confirmed — test it with `status`)'
      : h.ackStatus === 0
        ? 'kettle ACCEPTED it (status 00)'
        : `kettle REJECTED it (status 0x${h.ackStatus.toString(16).padStart(2, '0')})`;
    console.log(`\n${h.command === 'hello' ? 'Hello' : 'Register'} (protocol V${h.protocolVersion}, seq ${h.seq}) → ${verdict}`);
    console.log(`Registration key: ${key}`);
  }
  if (unique.size > 1) {
    console.log('\nMore than one key was found; use the one the kettle accepted.');
  }
}

async function cmdStatus(mac: string, flags: Flags, log: Logger): Promise<void> {
  await withClient(mac, flags, log, async (client) => {
    await authenticate(client, flags, log);
    const s = await client.poll();
    log.info(formatStatus(s));
  });
}

async function cmdWatch(mac: string, flags: Flags, log: Logger): Promise<void> {
  const intervalMs = parseNumber(flags.interval ?? '2', '--interval', 0.5, 600) * 1000;
  await withClient(mac, flags, log, async (client) => {
    await authenticate(client, flags, log);
    let lastLine = '';
    client.on('compact', (_s, changed) => {
      if (changed) {
        log.info('Compact status pushed by kettle (state changed)');
      }
    });
    client.on('status', (s) => {
      const line = formatStatus(s);
      if (line !== lastLine) {
        log.info(line);
        lastLine = line;
      }
    });
    log.info(`Watching (poll every ${intervalMs / 1000}s). Ctrl-C to stop.`);
    let failures = 0;
    while (client.connected) {
      try {
        await client.poll();
        failures = 0;
      } catch (err) {
        failures++;
        log.warn(`Poll failed (${failures}): ${errorMessage(err)}`);
        if (failures >= 5) {
          throw new Error('5 consecutive polls failed; giving up', { cause: err });
        }
      }
      await delay(intervalMs);
    }
    log.warn('Kettle disconnected.');
  });
}

async function cmdPair(mac: string, flags: Flags, log: Logger): Promise<void> {
  requireYes(flags, 'pair');
  const key = (flags.key ?? process.env.COSORI_KEY) ? requireKey(flags) : generateKey();
  log.warn('Registering a new key may unpair the VeSync app from this kettle (unverified). Prefer key-from-packets if you use the app.');
  await withClient(mac, flags, log, async (client) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (let attempt = 1; ; attempt++) {
        await rl.question('Press and hold the MyBrew button on the kettle until it signals pairing mode, then press Enter… ');
        try {
          await client.register(key);
          break;
        } catch (err) {
          if (err instanceof NotInPairingModeError && attempt < 3) {
            log.warn('Kettle is not in pairing mode yet. Try again.');
            continue;
          }
          throw err;
        }
      }
    } finally {
      rl.close();
    }
    log.info('Register accepted. Sending hello…');
    await client.hello(key);
    const s = await client.poll();
    log.info(formatStatus(s));
    console.log(`\nPaired. Registration key: ${keyToHex(key)}\nPut it in the plugin config as "registrationKey".`);
  });
}

async function cmdSetMyBrew(mac: string, tempArg: string | undefined, flags: Flags, log: Logger): Promise<void> {
  requireYes(flags, 'set-mybrew');
  const tempF = parseNumber(tempArg, 'temperature (°F)', 104, 212);
  await withClient(mac, flags, log, async (client) => {
    await authenticate(client, flags, log);
    const before = await client.poll();
    log.info(`Sending F3 set MyBrew = ${tempF}°F`);
    await client.setMyTemp(tempF);
    await reportAfterWrite(client, before, log);
  });
}

async function cmdHold(mac: string, minutesArg: string | undefined, flags: Flags, log: Logger): Promise<void> {
  requireYes(flags, 'hold');
  const minutes = parseNumber(minutesArg, 'minutes', 0, MAX_HOLD_SECONDS / 60);
  const seconds = Math.round(minutes * 60);
  await withClient(mac, flags, log, async (client) => {
    await authenticate(client, flags, log);
    const before = await client.poll();
    log.info(`Sending F2 set hold = ${seconds}s`);
    await client.setHold(seconds);
    await reportAfterWrite(client, before, log);
  });
}

async function cmdStart(mac: string, modeArg: string | undefined, flags: Flags, log: Logger): Promise<void> {
  requireYes(flags, 'start');
  const mode = modeArg ? MODE_ARGS[modeArg.toLowerCase()] : undefined;
  if (mode === undefined) {
    throw new UsageError(`mode must be one of: ${Object.keys(MODE_ARGS).join(', ')}`);
  }
  const holdSeconds = flags['hold-min'] ? Math.round(parseNumber(flags['hold-min'], '--hold-min', 0, MAX_HOLD_SECONDS / 60) * 60) : 0;
  const tempF = flags.temp ? parseNumber(flags.temp, '--temp', 0, 212) : undefined;
  if (mode === Mode.MY_BREW && tempF === undefined) {
    throw new UsageError('mybrew needs --temp <°F>');
  }
  const holdByteOrder = flags['hold-be'] ? 'be' : 'le';
  await withClient(mac, flags, log, async (client) => {
    await authenticate(client, flags, log);
    const before = await client.poll();
    if (before.onBase === false) {
      log.warn('Kettle reports it is OFF the base; it will not heat.');
    }
    if (mode === Mode.MY_BREW) {
      log.info(`Sending F3 set MyBrew = ${tempF}°F`);
      await client.setMyTemp(tempF!);
    }
    log.info(`Sending F0 start ${MODE_NAMES[mode]} (target ${PRESET_TEMP_F[mode] ?? tempF}°F), hold ${holdSeconds}s [${holdByteOrder}]`);
    await client.setMode(mode, { tempF, holdSeconds, holdByteOrder });
    await reportAfterWrite(client, before, log);
    if (holdSeconds > 0) {
      const s = client.status!;
      const verdict = s.configuredHoldSeconds === holdSeconds
        ? 'MATCHES — this hold byte order is correct'
        : `does NOT match (${s.configuredHoldSeconds}s reported) — note this result`;
      log.info(`Hold check: requested ${holdSeconds}s, kettle reports configured ${s.configuredHoldSeconds}s → ${verdict}`);
    }
  });
}

async function cmdStop(mac: string, flags: Flags, log: Logger): Promise<void> {
  requireYes(flags, 'stop');
  await withClient(mac, flags, log, async (client) => {
    await authenticate(client, flags, log);
    const before = await client.poll();
    log.info('Sending F4 stop');
    await client.stop();
    await reportAfterWrite(client, before, log);
  });
}

async function main(argv: string[]): Promise<number> {
  let positionals: string[];
  let flags: Flags;
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        key: { type: 'string' },
        dbus: { type: 'string' },
        adapter: { type: 'string' },
        protocol: { type: 'string' },
        'write-mode': { type: 'string' },
        interval: { type: 'string' },
        duration: { type: 'string' },
        'hold-min': { type: 'string' },
        temp: { type: 'string' },
        'hold-be': { type: 'boolean' },
        raw: { type: 'boolean' },
        verbose: { type: 'boolean', short: 'v' },
        yes: { type: 'boolean', short: 'y' },
        all: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    positionals = parsed.positionals;
    flags = parsed.values as Flags;
  } catch (err) {
    console.error(errorMessage(err));
    console.error(USAGE);
    return 2;
  }

  const [command, ...args] = positionals;
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return command || flags.help ? 0 : 2;
  }
  const log = consoleLogger(!!flags.verbose);

  try {
    switch (command) {
    case 'scan':
      await cmdScan(flags, log);
      break;
    case 'info':
      await cmdInfo(requireMac(args[0]), flags, log);
      break;
    case 'key-from-packets':
      cmdKeyFromPackets(args);
      break;
    case 'key-from-log':
      cmdKeyFromLog(args[0]);
      break;
    case 'status':
      await cmdStatus(requireMac(args[0]), flags, log);
      break;
    case 'watch':
      await cmdWatch(requireMac(args[0]), flags, log);
      break;
    case 'pair':
      await cmdPair(requireMac(args[0]), flags, log);
      break;
    case 'set-mybrew':
      await cmdSetMyBrew(requireMac(args[0]), args[1], flags, log);
      break;
    case 'hold':
      await cmdHold(requireMac(args[0]), args[1], flags, log);
      break;
    case 'start':
      await cmdStart(requireMac(args[0]), args[1], flags, log);
      break;
    case 'stop':
      await cmdStop(requireMac(args[0]), flags, log);
      break;
    default:
      throw new UsageError(`unknown command "${command}"`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`Error: ${err.message}\n`);
      console.error('Run `cosori-probe help` for usage.');
      return 2;
    }
    log.error(errorMessage(err));
    const hint = hintFor(err);
    if (hint) {
      log.info(`Hint: ${hint}`);
    }
    if (flags.verbose && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
