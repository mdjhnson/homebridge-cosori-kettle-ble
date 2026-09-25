/**
 * Protocol session with one kettle over a KettleTransport: sequence numbers, ACK matching,
 * handshake (register/hello), polling, and the documented control commands.
 *
 * It never reconnects by itself — ConnectionManager (Homebridge) or the probe CLI decide that.
 */
import { EventEmitter } from 'node:events';

import type { DeviceInfo, KettleTransport } from '../ble/Transport.js';
import {
  Cmd, Completion, FrameType, isHeatingStage, Mode, presetForTemp, ProtocolVersion, Stage,
} from '../protocol/constants.js';
import {
  commandFrame, compactStatusPayload, delayedStartPayload, helloPayload, pollPayload, registerPayload, setHoldPayload, setModePayload,
  setMyTempPayload, stopPayload, type SetModeOptions,
} from '../protocol/commands.js';
import { buildFrame, FrameParser, splitIntoChunks, toHex, type Frame } from '../protocol/frame.js';
import { decodeMessage, type AckMessage, type ExtendedStatus, type KettleMessage } from '../protocol/status.js';
import { detectProtocolVersion } from '../protocol/version.js';
import { delay, errorMessage, Mutex } from '../util/async.js';
import { type Logger, silentLogger } from '../util/log.js';
import {
  AckTimeoutError, CommandRejectedError, InvalidRegistrationKeyError, NotConnectedError, NotInPairingModeError,
} from './errors.js';

export interface KettleStatus {
  stage: number;
  mode: number;
  setpointF: number;
  tempF: number;
  /** Stored MyBrew temperature, from the last extended status: compact statuses don't carry it, so it can be stale. */
  myTempF?: number;
  configuredHoldSeconds: number;
  remainingHoldSeconds: number;
  /** Undefined until the first extended status has been received. */
  onBase?: boolean;
  babyFormula?: boolean;
  /** True while heating or keeping warm (stages 1–3). */
  active: boolean;
  /** True while a delayed start is scheduled (stage 5). */
  scheduled: boolean;
  /** Seconds until a scheduled delayed start begins (from the last extended status). */
  delayRemainingSeconds?: number;
  updatedAt: number;
}

export interface KettleClientOptions {
  /** 'auto' reads the Device Information Service after connecting. */
  protocolVersion?: 'auto' | ProtocolVersion;
  ackTimeoutMs?: number;
  /** Pause between the 20-byte chunks of a multi-chunk frame. */
  interChunkDelayMs?: number;
  log?: Logger;
  /** Log every frame in hex at debug level. */
  traceFrames?: boolean;
}

interface Pending {
  command: number;
  resolve: (value: { frame: Frame; message: KettleMessage }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

type Events = {
  status: [status: KettleStatus];
  compact: [status: KettleStatus, changed: boolean];
  completion: [code: number];
  frame: [direction: 'tx' | 'rx', bytes: Buffer];
  disconnect: [];
};

export function describeCompletion(code: number): string {
  if (code === Completion.HEATING_DONE) {
    return 'heating complete';
  }
  if (code === Completion.HOLD_DONE) {
    return 'keep-warm complete';
  }
  return `completion 0x${code.toString(16)}`;
}

export class KettleClient extends EventEmitter<Events> {
  private readonly parser = new FrameParser();
  private readonly pending = new Map<number, Pending>();
  private readonly mutex = new Mutex();
  private readonly log: Logger;
  private txSeq = 0;
  private versionByte: ProtocolVersion = ProtocolVersion.V1;
  private info: DeviceInfo = {};
  private last?: KettleStatus;
  private authenticated = false;
  private lastRxAt = 0;

  private readonly onData = (chunk: Buffer) => this.handleData(chunk);
  private readonly onTransportDisconnect = () => this.handleDisconnect();

  constructor(private readonly transport: KettleTransport, private readonly options: KettleClientOptions = {}) {
    super();
    this.log = options.log ?? silentLogger;
    if (options.protocolVersion !== undefined && options.protocolVersion !== 'auto') {
      this.versionByte = options.protocolVersion;
    }
    transport.on('data', this.onData);
    transport.on('disconnect', this.onTransportDisconnect);
  }

  get connected(): boolean {
    return this.transport.connected;
  }

  get isAuthenticated(): boolean {
    return this.transport.connected && this.authenticated;
  }

  get protocolVersion(): ProtocolVersion {
    return this.versionByte;
  }

  get deviceInfo(): DeviceInfo {
    return this.info;
  }

  get status(): KettleStatus | undefined {
    return this.last;
  }

  /** GATT flags of the TX characteristic (diagnostics). */
  txFlags(): Promise<string[]> {
    return this.transport.txFlags();
  }

  /** Connect the transport and (if 'auto') detect the protocol version from DIS. */
  async connect(): Promise<void> {
    this.parser.reset();
    this.authenticated = false;
    await this.transport.connect();
    this.info = await this.transport.readDeviceInfo().catch(() => ({}));
    if (this.options.protocolVersion === undefined || this.options.protocolVersion === 'auto') {
      this.versionByte = detectProtocolVersion(this.info.hardwareRevision, this.info.softwareRevision);
    }
    const { model, hardwareRevision, softwareRevision } = this.info;
    this.log.debug(`Device info: model=${model ?? '?'} hw=${hardwareRevision ?? '?'} sw=${softwareRevision ?? '?'} → protocol V${this.versionByte}`);
  }

  async disconnect(): Promise<void> {
    this.authenticated = false;
    this.rejectAll(new NotConnectedError());
    await this.transport.disconnect();
  }

  /** Detach from the transport and release it. */
  async destroy(): Promise<void> {
    await this.disconnect().catch(() => undefined);
    this.transport.off('data', this.onData);
    this.transport.off('disconnect', this.onTransportDisconnect);
    await this.transport.destroy();
    this.removeAllListeners();
  }

  /** Authenticate with a registered key. Throws InvalidRegistrationKeyError if the kettle rejects it. */
  async hello(key: Uint8Array): Promise<void> {
    const ack = await this.send(Cmd.HELLO, helloPayload(this.versionByte, key), { retry: false, checkStatus: false });
    if (ack.status === 0x01) {
      throw new InvalidRegistrationKeyError();
    }
    if (ack.status !== undefined && ack.status !== 0x00) {
      throw new CommandRejectedError(Cmd.HELLO, ack.status);
    }
    this.authenticated = true;
  }

  /**
   * Register a new key. The kettle must be in pairing mode (hold MyBrew). Follow with hello().
   * Never call hello() before register() on first pairing — the kettle rejects the unknown key.
   */
  async register(key: Uint8Array): Promise<void> {
    const ack = await this.send(Cmd.REGISTER, registerPayload(this.versionByte, key), { retry: false, checkStatus: false });
    if (ack.status === 0x01) {
      throw new NotInPairingModeError();
    }
    if (ack.status !== undefined && ack.status !== 0x00) {
      throw new CommandRejectedError(Cmd.REGISTER, ack.status);
    }
  }

  /** Request and return the extended status (also emitted as 'status'). */
  async poll(): Promise<KettleStatus> {
    const { message } = await this.sendRaw(Cmd.POLL, pollPayload(this.versionByte), { retry: true });
    if (message.kind !== 'extended') {
      throw new Error(`unexpected poll reply (${message.kind}${message.kind === 'invalid' ? `: ${message.reason}` : ''})`);
    }
    return this.last!;
  }

  async requestCompactStatus(): Promise<void> {
    await this.sendRaw(Cmd.COMPACT_STATUS, compactStatusPayload(this.versionByte), { retry: true });
  }

  async setMyTemp(tempF: number): Promise<void> {
    await this.send(Cmd.SET_MY_TEMP, setMyTempPayload(this.versionByte, tempF));
  }

  async setHold(holdSeconds: number): Promise<void> {
    await this.send(Cmd.SET_HOLD, setHoldPayload(this.versionByte, holdSeconds));
  }

  async setMode(mode: number, options: SetModeOptions = {}): Promise<void> {
    await this.send(Cmd.SET_MODE, setModePayload(this.versionByte, mode, options));
  }

  /** Stop heating / keep-warm, or cancel a scheduled delayed start. */
  async stop(): Promise<void> {
    await this.send(Cmd.STOP, stopPayload(this.versionByte));
  }

  /** Schedule heating to start in `delaySeconds` (kettle-side timer; the link may drop meanwhile). */
  async delayedStart(delaySeconds: number, mode: number, options: SetModeOptions = {}): Promise<void> {
    await this.send(Cmd.DELAYED_START, delayedStartPayload(this.versionByte, delaySeconds, mode, options));
  }

  /** Like heatTo(), but scheduled: preset when the target is a preset temperature, else MyBrew (F3 first). */
  async heatToLater(delaySeconds: number, tempF: number, holdSeconds = 0): Promise<number> {
    const mode = presetForTemp(tempF);
    if (mode !== undefined) {
      await this.delayedStart(delaySeconds, mode, { holdSeconds });
      return mode;
    }
    await this.setMyTemp(tempF);
    await this.delayedStart(delaySeconds, Mode.MY_BREW, { tempF, holdSeconds });
    return Mode.MY_BREW;
  }

  /**
   * Heat to a temperature. Uses the matching preset mode when the target is a preset temperature,
   * otherwise stores it as the MyBrew temperature (F3) and starts MyBrew (F0 mode 5).
   */
  async heatTo(tempF: number, holdSeconds = 0, extra: Omit<SetModeOptions, 'holdSeconds' | 'tempF'> = {}): Promise<number> {
    const mode = presetForTemp(tempF);
    if (mode !== undefined) {
      await this.setMode(mode, { ...extra, holdSeconds });
      return mode;
    }
    await this.setMyTemp(tempF);
    await this.setMode(Mode.MY_BREW, { ...extra, tempF, holdSeconds });
    return Mode.MY_BREW;
  }

  // ---------------------------------------------------------------------------------------------

  private async send(command: number, payload: Buffer, opts: { retry?: boolean; checkStatus?: boolean } = {}): Promise<AckMessage> {
    const { message } = await this.sendRaw(command, payload, { retry: opts.retry ?? true });
    const ack: AckMessage = message.kind === 'ack' ? message : { kind: 'ack', command };
    if ((opts.checkStatus ?? true) && ack.status !== undefined && ack.status !== 0x00) {
      throw new CommandRejectedError(command, ack.status);
    }
    return ack;
  }

  private sendRaw(command: number, payload: Buffer, opts: { retry: boolean }): Promise<{ frame: Frame; message: KettleMessage }> {
    return this.mutex.run(async () => {
      try {
        return await this.sendOnce(command, payload);
      } catch (err) {
        if (!opts.retry || !(err instanceof AckTimeoutError) || !this.transport.connected) {
          throw err;
        }
        this.log.debug(`${errorMessage(err)}; retrying once`);
        return this.sendOnce(command, payload);
      }
    });
  }

  private async sendOnce(command: number, payload: Buffer): Promise<{ frame: Frame; message: KettleMessage }> {
    if (!this.transport.connected) {
      throw new NotConnectedError();
    }
    if (this.parser.pending > 0 && Date.now() - this.lastRxAt > 1_000) {
      this.log.debug(`Dropping ${this.parser.pending} stale partial bytes`);
      this.parser.reset();
    }
    const seq = this.txSeq;
    this.txSeq = (this.txSeq + 1) & 0xff;
    const frame = commandFrame(seq, payload);
    const timeoutMs = this.options.ackTimeoutMs ?? 5_000;

    const reply = new Promise<{ frame: Frame; message: KettleMessage }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new AckTimeoutError(command, timeoutMs));
      }, timeoutMs);
      this.pending.set(seq, { command, resolve, reject, timer });
    });
    // Avoid an unhandled rejection if the write itself throws and we never await `reply`.
    reply.catch(() => undefined);

    this.trace('tx', frame);
    try {
      const chunks = splitIntoChunks(frame);
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0 && (this.options.interChunkDelayMs ?? 0) > 0) {
          await delay(this.options.interChunkDelayMs!);
        }
        await this.transport.write(chunks[i]!);
      }
    } catch (err) {
      const p = this.pending.get(seq);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(seq);
      }
      throw err;
    }
    return reply;
  }

  private handleData(chunk: Buffer): void {
    this.lastRxAt = Date.now();
    let frames: Frame[];
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this.log.warn(`Failed to parse notification: ${errorMessage(err)}`);
      this.parser.reset();
      return;
    }
    for (const frame of frames) {
      try {
        this.handleFrame(frame);
      } catch (err) {
        this.log.warn(`Error handling frame: ${errorMessage(err)}`);
      }
    }
  }

  private handleFrame(frame: Frame): void {
    this.trace('rx', frame);
    const message = decodeMessage(frame);

    switch (message.kind) {
    case 'extended':
      this.updateFromExtended(message);
      break;
    case 'compact': {
      const prev = this.last;
      const changed = !prev || prev.stage !== message.stage || prev.mode !== message.mode || prev.setpointF !== message.setpointF;
      this.last = {
        configuredHoldSeconds: 0,
        remainingHoldSeconds: 0,
        ...prev,
        stage: message.stage,
        mode: message.mode,
        setpointF: message.setpointF,
        tempF: message.tempF,
        active: isHeatingStage(message.stage),
        scheduled: message.stage === Stage.DELAY_SCHEDULED,
        updatedAt: Date.now(),
      };
      this.emit('compact', this.last, changed);
      this.emit('status', this.last);
      break;
    }
    case 'completion':
      this.log.debug(`Completion: ${describeCompletion(message.code)}`);
      this.emit('completion', message.code);
      break;
    case 'invalid':
      this.log.debug(`Ignoring frame: ${message.reason}`);
      break;
    default:
      break;
    }

    if (frame.frameType === FrameType.ACK) {
      const pending = this.pending.get(frame.seq);
      if (pending && frame.payload[1] === pending.command) {
        clearTimeout(pending.timer);
        this.pending.delete(frame.seq);
        pending.resolve({ frame, message });
      } else if (pending) {
        this.log.debug(`ACK seq ${frame.seq} for cmd 0x${frame.payload[1]?.toString(16)} doesn't match pending 0x${pending.command.toString(16)}`);
      }
    }
  }

  private updateFromExtended(s: ExtendedStatus): void {
    this.last = {
      stage: s.stage,
      mode: s.mode,
      setpointF: s.setpointF,
      tempF: s.tempF,
      myTempF: s.myTempF,
      configuredHoldSeconds: s.configuredHoldSeconds,
      remainingHoldSeconds: s.remainingHoldSeconds,
      onBase: s.onBase,
      babyFormula: s.babyFormula,
      delayRemainingSeconds: s.delayRemainingSeconds,
      active: isHeatingStage(s.stage),
      scheduled: s.stage === Stage.DELAY_SCHEDULED,
      updatedAt: Date.now(),
    };
    this.emit('status', this.last);
  }

  private handleDisconnect(): void {
    this.authenticated = false;
    this.parser.reset();
    this.rejectAll(new NotConnectedError());
    this.emit('disconnect');
  }

  private rejectAll(err: Error): void {
    for (const [seq, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(seq);
    }
  }

  private trace(direction: 'tx' | 'rx', frame: Buffer | Frame): void {
    const bytes = Buffer.isBuffer(frame) ? frame : buildFrame(frame.frameType, frame.seq, frame.payload);
    this.emit('frame', direction, bytes);
    if (this.options.traceFrames) {
      this.log.debug(`${direction === 'tx' ? '→' : '←'} ${toHex(bytes)}`);
    }
  }
}
