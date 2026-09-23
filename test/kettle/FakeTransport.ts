import { EventEmitter } from 'node:events';

import type { DeviceInfo, KettleTransport } from '../../src/ble/Transport.js';
import { buildFrame, FrameParser, fromHex, type Frame } from '../../src/protocol/index.js';

export type Responder = (frame: Frame, fake: FakeTransport) => void;

/**
 * In-memory kettle link. Reassembles written chunks into frames, records them, and lets tests
 * script replies. `respond` runs for every complete TX frame.
 */
export class FakeTransport extends EventEmitter implements KettleTransport {
  connected = false;
  readonly writes: Buffer[] = [];
  readonly sent: Frame[] = [];
  deviceInfo: DeviceInfo = { hardwareRevision: '1.0.00', softwareRevision: 'R0007V0012' };
  connectError?: Error;
  connectCount = 0;
  private readonly parser = new FrameParser();

  constructor(public respond: Responder = () => undefined) {
    super();
  }

  async connect(): Promise<void> {
    this.connectCount++;
    if (this.connectError) {
      throw this.connectError;
    }
    this.connected = true;
  }

  async write(chunk: Buffer): Promise<void> {
    if (!this.connected) {
      throw new Error('not connected');
    }
    if (chunk.length > 20) {
      throw new Error(`chunk too large: ${chunk.length}`);
    }
    this.writes.push(Buffer.from(chunk));
    for (const frame of this.parser.push(chunk)) {
      this.sent.push(frame);
      queueMicrotask(() => this.respond(frame, this));
    }
  }

  async readDeviceInfo(): Promise<DeviceInfo> {
    return this.deviceInfo;
  }

  async txFlags(): Promise<string[]> {
    return ['write', 'write-without-response'];
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async destroy(): Promise<void> {
    this.connected = false;
  }

  /** Deliver raw bytes as a notification, optionally split into several notifications. */
  notify(bytes: Buffer | string, splitAt: number[] = []): void {
    const buf = typeof bytes === 'string' ? fromHex(bytes) : bytes;
    let last = 0;
    for (const at of [...splitAt, buf.length]) {
      this.emit('data', buf.subarray(last, at));
      last = at;
    }
  }

  /** Reply with an ACK frame (type 0x12) echoing the request's seq and 4-byte header. */
  ack(request: Frame, tail: number[] = []): void {
    this.notify(buildFrame(0x12, request.seq, Buffer.concat([request.payload.subarray(0, 4), Buffer.from(tail)])));
  }

  /** Reply to a poll with a 29-byte extended status taken from a fixture payload. */
  extended(request: Frame, fixturePayload: Buffer): void {
    this.notify(buildFrame(0x12, request.seq, fixturePayload));
  }

  /** Simulate the link dropping. */
  drop(): void {
    this.connected = false;
    this.emit('disconnect');
  }
}
