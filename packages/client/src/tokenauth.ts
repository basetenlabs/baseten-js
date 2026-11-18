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
  refreshLeewayMs: number;

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
  // The token last dropped for being due for refresh. It is still valid until
  // it expires, so it stands in when a refresh fails.
  #previous?: Token;

  constructor(options: TokenCacheOptions) {
    this.#options = options;
  }

  /**
   * Returns the cached token, minting a new one when none is cached or the
   * cached one is due for refresh. The signal only stops this caller's wait.
   */
  async token(signal?: AbortSignal): Promise<Token> {
    let joinedFailure = false;
    for (;;) {
      let mint = this.#current;
      const started = mint === undefined;
      if (mint === undefined) mint = this.#startMint();
      let token: Token;
      try {
        token = await abortable(mint.promise, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        // Another caller's failed mint gets one more try, which may be this
        // caller's own; the failed one already left the cache.
        if (!started && !joinedFailure) {
          joinedFailure = true;
          continue;
        }
        // A refresh that fails while the replaced token is still valid falls
        // back to it, so a brief outage of the minting endpoint does not fail
        // requests the old token can still serve.
        const previous = this.#previous;
        if (previous !== undefined && Date.now() < previous.expiresAtMs) return previous;
        throw err;
      }
      // A token this caller just minted is used even if already due for
      // refresh, so a skewed clock cannot loop here forever.
      if (started || Date.now() < mint.refreshAtMs) return token;
      if (this.#current === mint) {
        this.#current = undefined;
        this.#previous = token;
      }
    }
  }

  /** Drops token if it is still the cached one, so the next caller gets a new one. */
  invalidate(token: string): void {
    if (this.#previous?.value === token) this.#previous = undefined;
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
    const { mintTimeoutMs, refreshLeewayMs } = this.#options;
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
      mint.refreshAtMs = token.expiresAtMs - Math.min(refreshLeewayMs, lifetimeMs / 2);
      mint.token = token;
      this.#previous = undefined;
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
