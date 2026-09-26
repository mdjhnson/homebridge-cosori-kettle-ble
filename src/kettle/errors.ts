export class KettleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotConnectedError extends KettleError {
  constructor() {
    super('kettle is not connected');
  }
}

export class AckTimeoutError extends KettleError {
  constructor(public readonly command: number, ms: number) {
    super(`no response from kettle to command 0x${command.toString(16)} within ${ms} ms`);
  }
}

/**
 * A GATT write to the kettle failed while the link still looked up. On a weak link this is usually
 * the first sign of a drop: BlueZ's write timeout (5 s) fires before the 6 s supervision timeout.
 */
export class WriteFailedError extends KettleError {
  constructor(cause: unknown) {
    super(`write to the kettle failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Hello rejected (status 01): the key isn't registered with this kettle. */
export class InvalidRegistrationKeyError extends KettleError {
  constructor() {
    super('kettle rejected the registration key (hello status 01) — use the key from the VeSync app, or pair a new one');
  }
}

/** Register rejected (status 01): kettle wasn't in pairing mode. */
export class NotInPairingModeError extends KettleError {
  constructor() {
    super('kettle is not in pairing mode (register status 01) — press and hold the MyBrew button, then retry');
  }
}

export class CommandRejectedError extends KettleError {
  constructor(public readonly command: number, public readonly status: number) {
    super(`kettle rejected command 0x${command.toString(16)} (status 0x${status.toString(16).padStart(2, '0')})`);
  }
}
