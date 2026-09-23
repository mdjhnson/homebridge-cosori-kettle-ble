import type { EventEmitter } from 'node:events';

export interface DeviceInfo {
  name?: string;
  address?: string;
  model?: string;
  manufacturer?: string;
  hardwareRevision?: string;
  softwareRevision?: string;
}

/**
 * Byte-level link to one kettle. Implementations own discovery, GATT lookup and notification
 * subscription; framing and protocol logic live in KettleClient.
 *
 * Events:
 *   'data'        (chunk: Buffer)  – a notification from FFF1
 *   'disconnect'  ()               – link dropped (not emitted for an explicit disconnect())
 */
export interface KettleTransport extends EventEmitter {
  readonly connected: boolean;
  /** Connect, resolve GATT services, and subscribe to FFF1 notifications. */
  connect(): Promise<void>;
  /** Write one ≤20-byte chunk to FFF2. */
  write(chunk: Buffer): Promise<void>;
  /** Read the standard Device Information Service strings (missing fields left undefined). */
  readDeviceInfo(): Promise<DeviceInfo>;
  /** GATT flags of the TX characteristic (e.g. ["write", "write-without-response"]). */
  txFlags(): Promise<string[]>;
  disconnect(): Promise<void>;
  /** Release D-Bus resources. The transport cannot be used afterwards. */
  destroy(): Promise<void>;
}
