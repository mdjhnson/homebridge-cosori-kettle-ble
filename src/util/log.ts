/** Minimal logger interface satisfied by Homebridge's `Logging` and by the CLI console logger. */
export interface Logger {
  debug(message: string, ...params: unknown[]): void;
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Homebridge only prints `debug` when started with -D; this wrapper promotes it when the plugin's own debug flag is on. */
export function withDebug(log: Logger, debugEnabled: boolean): Logger {
  if (!debugEnabled) {
    return log;
  }
  return {
    debug: (message, ...params) => log.info(`[debug] ${message}`, ...params),
    info: (message, ...params) => log.info(message, ...params),
    warn: (message, ...params) => log.warn(message, ...params),
    error: (message, ...params) => log.error(message, ...params),
  };
}

export function consoleLogger(verbose: boolean): Logger {
  const ts = () => new Date().toISOString().slice(11, 23);
  return {
    debug: (message, ...params) => {
      if (verbose) {
        console.log(`${ts()} [debug] ${message}`, ...params);
      }
    },
    info: (message, ...params) => console.log(`${ts()} ${message}`, ...params),
    warn: (message, ...params) => console.warn(`${ts()} [warn] ${message}`, ...params),
    error: (message, ...params) => console.error(`${ts()} [error] ${message}`, ...params),
  };
}
