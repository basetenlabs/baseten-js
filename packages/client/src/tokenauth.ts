// What every short-lived Baseten token needs: a cache that mints a new token
// shortly before the current one expires, and sending a request again with a
// new token when the server refuses the current one.

/** A minted bearer token. */
export interface Token {
  value: string;
  expiresAtMs: number;
}

/** Options for {@link TokenCache}. */
export interface TokenCacheOptions {
  /**
   * Gets a new token. Its signal carries no caller's abort, only the mint
   * timeout.
   */
  mint: (signal: AbortSignal) => Promise<Token>;

  /**
   * How long before expiry a token is replaced, capped at half the token's
   * lifetime so a short-lived token is still reused.
   */
  refreshBeforeMs: number;

  /** Bounds one mint, which every waiting caller shares. */
  mintTimeoutMs: number;

  /** Names the mint in its timeout error, such as "sandbox token exchange". */
  mintName: string;
}

class Mint {
  promise!: Promise<Token>;
  // Set once the mint succeeds.
  token?: Token;
  refreshAtMs = 0;
}

/**
 * Holds one token and shares one mint among the callers that ask while it is
 * in flight.
 */
export class TokenCache {
  readonly #options: TokenCacheOptions;
  #current?: Mint;

  constructor(options: TokenCacheOptions) {
    this.#options = options;
  }

  /**
   * Returns the cached token, minting a new one when none is cached or the
   * cached one is due for refresh. The signal only stops this caller's wait.
   */
  async token(signal?: AbortSignal): Promise<Token> {
    for (;;) {
      let mint = this.#current;
      const started = mint === undefined;
      if (mint === undefined) mint = this.#startMint();
      let token: Token;
      try {
        token = await abortable(mint.promise, signal);
      } catch (err) {
        // Another caller's failed mint gets one more try of this caller's
        // own; the failed one already left the cache.
        if (signal?.aborted || started) throw err;
        continue;
      }
      // A token this caller just minted is used even if already due for
      // refresh, so a skewed clock cannot loop here forever.
      if (started || Date.now() < mint.refreshAtMs) return token;
      if (this.#current === mint) this.#current = undefined;
    }
  }

  /** Drops token if it is still the cached one, so the next caller gets a new one. */
  invalidate(token: string): void {
    // A mint still in flight is already newer than any refused token. Compared
    // by value, so a refusal of an older token never discards a newer one
    // another caller already minted.
    if (this.#current?.token?.value === token) this.#current = undefined;
  }

  // The mint runs without any caller's signal, since one caller giving up must
  // not fail the others waiting on it; each only stops waiting on its own. The
  // timeout bounds it instead, so a stalled mint cannot hold every caller.
  #startMint(): Mint {
    const mint = new Mint();
    // Cached before the mint starts, so a mint that fails synchronously still
    // leaves the cache.
    this.#current = mint;
    mint.promise = this.#runMint(mint);
    // A caller that aborts before the mint settles leaves no one awaiting it.
    mint.promise.catch(() => {});
    return mint;
  }

  async #runMint(mint: Mint): Promise<Token> {
    const { mintTimeoutMs, refreshBeforeMs } = this.#options;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new Error(`${this.#options.mintName} timed out after ${mintTimeoutMs / 1000}s`),
      );
    }, mintTimeoutMs);
    const startedAtMs = Date.now();
    try {
      // Raced against the timeout too, in case the mint ignores its signal.
      const token = await abortable(this.#options.mint(controller.signal), controller.signal);
      const lifetimeMs = Math.max(token.expiresAtMs - startedAtMs, 0);
      mint.refreshAtMs = token.expiresAtMs - Math.min(refreshBeforeMs, lifetimeMs / 2);
      mint.token = token;
      return token;
    } catch (err) {
      // A failed mint is not cached, so the next caller tries again.
      if (this.#current === mint) this.#current = undefined;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// A few resends cover a new token being invalidated in the same event as the
// old one. Past that, the refusal is returned, since tokens that keep getting
// refused point at something a new token cannot fix.
const MAX_RESENDS = 2;

/**
 * Returns the token for a request, or undefined to send it without
 * Authorization. refused is the token the previous send was refused with, if
 * any, which the getter must not return again.
 */
export type BearerTokenGetter = (
  signal: AbortSignal | undefined,
  refused: string | undefined,
) => Promise<string | undefined>;

/**
 * Sends a request through base with "Authorization: Bearer <token>". When the
 * server refuses the token (see {@link isTokenRefused}), asks for a token
 * again naming the refused one and sends the request again, at most twice,
 * waiting resendDelayMs before the second resend. An undefined token sends the
 * request without Authorization, once.
 *
 * Revocation refuses every token issued before a cutoff that can fall a moment
 * after the revoking event, so a token minted right after it can be refused
 * too; resendDelayMs lets the next one be minted past the cutoff.
 */
export async function fetchWithBearerToken(
  base: typeof fetch,
  input: string | URL | Request,
  init: RequestInit | undefined,
  getToken: BearerTokenGetter,
  resendDelayMs: number,
): Promise<Response> {
  const signal = init?.signal ?? undefined;
  // A stream body can be read only once, so a request carrying one is never
  // sent again.
  const replayable =
    !(init?.body instanceof ReadableStream) && !(input instanceof Request && input.body !== null);
  let refused: string | undefined;
  for (let resend = 0; ; resend++) {
    const token = await getToken(signal, refused);
    const response = await base(input, withBearer(input, init, token));
    if (token === undefined || !replayable || resend >= MAX_RESENDS || !isTokenRefused(response)) {
      return response;
    }
    await response.body?.cancel();
    refused = token;
    if (resend > 0) await sleep(resendDelayMs, signal);
  }
}

/**
 * Reports whether the server refused a request's token before its stated
 * expiry, for example after it was revoked. The request was refused before
 * any work was done, so sending it again with a new token is safe even when
 * it has side effects.
 */
export function isTokenRefused(response: Response): boolean {
  if (response.status !== 401) return false;
  // Sandboxes, and the control plane for sandbox tokens, send this header.
  if (response.headers.get("x-blaxel-error-code") === "TOKEN_REVOKED") return true;
  // The RFC 6750 response to a refused access token. Headers joins repeated
  // challenges into one value.
  return response.headers.get("www-authenticate")?.includes('error="invalid_token"') ?? false;
}

/** Returns init with "Authorization: Bearer <token>" added to the headers fetch would send. */
export function withBearer(
  input: string | URL | Request,
  init: RequestInit | undefined,
  token: string | undefined,
): RequestInit {
  if (token === undefined) return init ?? {};
  const headers = requestHeaders(input, init);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/** Returns the headers fetch sends for input and init, where init's replace a Request's. */
export function requestHeaders(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

/** Waits on a promise, but stops waiting once the signal aborts. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
