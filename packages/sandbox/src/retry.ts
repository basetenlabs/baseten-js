import type { SandboxRetryOptions } from "./common";
import { SandboxApiError, SandboxGatewayError } from "./errors";

const DEFAULT_READ_MAX_RETRIES = 5;
const DEFAULT_GATEWAY_MAX_RETRIES = 2;
const DEFAULT_UPLOAD_MAX_RETRIES = 3;

const BACKOFF_BASE_MS = 200;
const BACKOFF_MAX_MS = 2000;

// Transport error codes, found on an error or anywhere in its cause chain, that
// mean the connection dropped before a response arrived. UND_ERR_SOCKET is how
// undici, which backs Node's fetch, reports a connection closed mid-request.
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
  "UND_ERR_SOCKET",
]);

// HTTP/2 reset markers in error messages. Bare "INTERNAL_ERROR" and
// "fetch failed" are deliberately absent: both also appear on failures that
// are not transient.
const TRANSIENT_RESET_MARKERS = [
  "ENHANCE_YOUR_CALM",
  "NGHTTP2_INTERNAL_ERROR",
  "ERR_HTTP2",
  "GOAWAY",
];

/** Fills in the default retry budgets. */
export function resolveRetryOptions(options?: SandboxRetryOptions): Required<SandboxRetryOptions> {
  return {
    readMaxRetries: options?.readMaxRetries ?? DEFAULT_READ_MAX_RETRIES,
    gatewayMaxRetries: options?.gatewayMaxRetries ?? DEFAULT_GATEWAY_MAX_RETRIES,
    uploadMaxRetries: options?.uploadMaxRetries ?? DEFAULT_UPLOAD_MAX_RETRIES,
  };
}

/**
 * Reports whether an error is a dropped or reset connection, as opposed to a
 * response from the server. Only then is repeating an idempotent call safe.
 */
export function isTransientResetError(err: unknown): boolean {
  // A response came back, so the server handled the request, even when its
  // body happens to contain one of the markers.
  if (err instanceof SandboxApiError) return false;
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const node = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    if (node.name === "AbortError") return false;
    if (typeof node.code === "string" && TRANSIENT_ERROR_CODES.has(node.code)) return true;
    if (
      typeof node.message === "string" &&
      TRANSIENT_RESET_MARKERS.some((marker) => (node.message as string).includes(marker))
    ) {
      return true;
    }
    current = node.cause;
  }
  return false;
}

/**
 * Exponential backoff capped at a maximum, plus up to one base delay of
 * jitter so that many clients failing together do not retry together.
 */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const capped = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  return capped + Math.floor(Math.random() * baseMs);
}

/** Resolves after a delay, or rejects with the signal's reason once aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs an idempotent call, retrying dropped connections and edge gateway
 * errors on separate budgets. Must never wrap a call with side effects, since
 * a dropped connection does not tell whether the server acted on it.
 */
export async function retryIdempotent<T>(
  fn: () => Promise<T>,
  options: { maxRetries: number; gatewayMaxRetries: number; signal?: AbortSignal },
): Promise<T> {
  let attempt = 0;
  let gatewayAttempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (options.signal?.aborted) throw err;
      let delayMs: number;
      if (err instanceof SandboxGatewayError) {
        gatewayAttempt++;
        if (gatewayAttempt > options.gatewayMaxRetries) throw err;
        delayMs = backoffDelayMs(gatewayAttempt, BACKOFF_BASE_MS, BACKOFF_MAX_MS);
      } else {
        attempt++;
        if (attempt > options.maxRetries || !isTransientResetError(err)) throw err;
        delayMs = backoffDelayMs(attempt, BACKOFF_BASE_MS, BACKOFF_MAX_MS);
      }
      await sleep(delayMs, options.signal);
    }
  }
}
