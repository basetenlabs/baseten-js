/** Options that apply to a single call rather than to the request data. */
export interface CallOptions {
  /** Aborts the call, including any retries and waits it is doing. */
  signal?: AbortSignal;
}

/**
 * Retry budgets for transient failures.
 *
 * Retries only ever apply to operations that are safe to repeat, such as
 * reads. Operations with side effects, such as running a process or creating
 * a sandbox, are never retried. Each budget counts retries after the first
 * attempt, so 0 disables that kind of retry.
 */
export interface SandboxRetryOptions {
  /** Retries of a read after a dropped or reset connection. Defaults to 5. */
  readMaxRetries?: number;

  /**
   * Retries after the edge in front of a sandbox answers 502, 503, or 504.
   * Each attempt can take as long as the edge's own timeout, so this is kept
   * small. Defaults to 2.
   */
  gatewayMaxRetries?: number;

  /** Retries of a file upload after a dropped or reset connection. Defaults to 3. */
  uploadMaxRetries?: number;
}

const DAY_MS = 86_400_000;

const DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** @internal Formats milliseconds as a control plane duration, rounded to whole milliseconds. */
export function formatDuration(ms: number): string {
  return `${Math.round(ms)}ms`;
}

/**
 * @internal Parses a control plane duration into milliseconds: Go duration
 * syntax, or a whole number of days or weeks on its own, at 24 hours per day.
 * `what` names the value in errors.
 */
export function parseDuration(value: string, what: string): number {
  const sign = value.startsWith("-") ? -1 : 1;
  const body = value.startsWith("-") || value.startsWith("+") ? value.slice(1) : value;
  if (body === "0") return 0;
  const whole = /^(\d+)([dw])$/.exec(body);
  if (whole !== null) {
    return sign * Number(whole[1]) * (whole[2] === "w" ? 7 : 1) * DAY_MS;
  }
  const part = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/y;
  let total = 0;
  let index = 0;
  while (index < body.length) {
    part.lastIndex = index;
    const match = part.exec(body);
    if (match === null) break;
    total += Number(match[1]) * DURATION_UNIT_MS[match[2]!]!;
    index = part.lastIndex;
  }
  if (body === "" || index < body.length) {
    throw new Error(`${what} is not a valid duration: ${JSON.stringify(value)}`);
  }
  return sign * total;
}

/**
 * @internal Parses an exec plane timestamp, which has no declared format, so
 * that an unknown format fails clearly rather than becoming an invalid date.
 * `what` names the value in errors.
 */
export function parseTimestamp(value: string, what: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${what} is not a valid timestamp: ${JSON.stringify(value)}`);
  }
  return date;
}

/** @internal Runs at most a fixed number of tasks at once, the rest in order of arrival. */
export class Limiter {
  #available: number;
  readonly #waiters: (() => void)[] = [];

  constructor(limit: number) {
    this.#available = limit;
  }

  /** Runs a task once a slot is free, or rejects with the signal's reason if it aborts first. */
  async run<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    await this.#acquire(signal);
    try {
      return await task();
    } finally {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#available++;
    }
  }

  #acquire(signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        reject(signal!.reason);
      };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
