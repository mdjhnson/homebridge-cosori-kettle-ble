export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor?: number;
  /** 0–1: fraction of the delay that is randomised. */
  jitter?: number;
  random?: () => number;
}

/** Exponential backoff with jitter. */
export class Backoff {
  private attempt = 0;

  constructor(private readonly options: BackoffOptions) {}

  get attempts(): number {
    return this.attempt;
  }

  next(): number {
    const { initialMs, maxMs, factor = 2, jitter = 0.2, random = Math.random } = this.options;
    const base = Math.min(maxMs, initialMs * factor ** this.attempt);
    this.attempt++;
    const spread = base * jitter;
    return Math.round(Math.min(maxMs, Math.max(0, base - spread + random() * 2 * spread)));
  }

  reset(): void {
    this.attempt = 0;
  }
}
