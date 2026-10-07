import { ManagementClient } from "@basetenlabs/client";
import { sleep } from "./retry";

/**
 * Returns the bearer token to send on a request. Called for every request.
 *
 * A provider that caches tokens must drop its cached token when it matches
 * {@link SandboxTokenProviderContext.revokedToken}, since the server rejects
 * that token for good.
 */
export type SandboxTokenProvider = (context: SandboxTokenProviderContext) => Promise<string>;

/** What a {@link SandboxTokenProvider} is told about the token it is asked for. */
export interface SandboxTokenProviderContext {
  /**
   * A token the server just rejected as revoked, set when the request is
   * being sent again with a new one. Revocation can happen well before a
   * token's expiry, for example when any API key of the token's user changes.
   */
  revokedToken?: string;
}

// Refresh this long before the token's stated expiry, to allow for clock skew
// between this machine and the server, and for time spent in flight.
const TOKEN_EXPIRY_LEEWAY_MS = 60_000;

// A few retries cover a new token being invalidated in the same event as the
// old one. Past that, the rejection is returned, since tokens that keep
// getting rejected point at something a new token cannot fix.
const TOKEN_INVALIDATION_MAX_RETRIES = 2;

// Revocation rejects every token issued before a cutoff, the time of the
// revoking event rounded up to the next whole second. A token minted right
// after the event can fall before the cutoff and be rejected too, so after
// the first resend, each one waits this long to be minted past it.
const TOKEN_REVOKED_RETRY_DELAY_MS = 1000;

// Bounds one token exchange, which no caller's signal reaches, so a stalled
// exchange cannot stay cached for every later caller to wait on.
const TOKEN_MINT_TIMEOUT_MS = 30_000;

/**
 * Where each request's bearer token comes from: a caller's token provider,
 * or a token minted from an API key, cached until shortly before it expires.
 *
 * The API key is exchanged for a token because the sandbox APIs do not
 * accept API keys directly. Should that change, only this class changes.
 */
export class TokenSource {
  private readonly mint?: () => Promise<{ token: string; expiresAtMs: number }>;
  private readonly provider?: SandboxTokenProvider;
  private cached?: Promise<{ token: string; expiresAtMs: number }>;

  constructor(options: {
    apiKey: string;
    tokenProvider?: SandboxTokenProvider;
    managementBaseUrlOverride?: string;
    fetch: typeof fetch;
    headers?: Record<string, string>;
  }) {
    if (options.tokenProvider !== undefined) {
      if (options.apiKey !== "") {
        throw new Error("apiKey must be empty when tokenProvider is set");
      }
      this.provider = options.tokenProvider;
    } else if (options.apiKey !== "") {
      this.mint = async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort(
            new Error(`sandbox token exchange timed out after ${TOKEN_MINT_TIMEOUT_MS / 1000}s`),
          );
        }, TOKEN_MINT_TIMEOUT_MS);
        const api = new ManagementClient({
          apiKey: options.apiKey,
          baseUrlOverride: options.managementBaseUrlOverride,
          fetch: (input, init) => options.fetch(input, { ...init, signal: controller.signal }),
          headers: options.headers,
        }).api;
        try {
          const minted = await api.postToken({ request: { scopes: ["sandboxes"] } });
          return { token: minted.token, expiresAtMs: Date.parse(minted.expires_at) };
        } finally {
          clearTimeout(timer);
        }
      };
    }
  }

  /**
   * Returns the token for a request, or undefined when no Authorization
   * should be sent, which is the advanced opt-out of an empty API key with no
   * token provider.
   */
  async token(signal?: AbortSignal, revokedToken?: string): Promise<string | undefined> {
    // The provider cannot be told to stop, so only the waiting on it does.
    if (this.provider !== undefined) return abortable(this.provider({ revokedToken }), signal);
    if (this.mint === undefined) return undefined;
    let cached = this.cached;
    if (cached !== undefined) {
      let current: { token: string; expiresAtMs: number } | undefined;
      try {
        current = await abortable(cached, signal);
      } catch (err) {
        // The caller giving up is not a failed mint, so the entry stays.
        if (signal?.aborted) throw err;
      }
      if (current !== undefined && Date.now() < current.expiresAtMs - TOKEN_EXPIRY_LEEWAY_MS) {
        return current.token;
      }
      // A rejected or expired entry is replaced, unless a concurrent caller
      // already replaced it while this one was waiting.
      if (this.cached === cached) this.cached = undefined;
    }
    // Every caller shares one mint, so a burst on a cold cache sends a single
    // exchange. The mint takes no caller's signal, since one caller aborting
    // must not fail the others; each only stops waiting on its own.
    cached = this.cached ??= this.mint();
    const minted = await abortable(cached, signal).catch((err: unknown) => {
      if (!signal?.aborted && this.cached === cached) this.cached = undefined;
      throw err;
    });
    return minted.token;
  }

  /** Drops a token the server rejected, so the next request gets a new one. */
  async invalidate(token: string): Promise<void> {
    const cached = this.cached;
    if (cached === undefined) return;
    const current = await cached.catch(() => undefined);
    // Compared by value, so a rejection of an older token never discards a
    // newer one another request already minted.
    if (current?.token === token && this.cached === cached) this.cached = undefined;
  }
}

/**
 * Wraps a fetch to authenticate every request with a token from the source.
 */
export function authenticatedFetch(base: typeof fetch, tokens: TokenSource): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    // A stream body can be read only once, so a request carrying one is never
    // sent again. The SDK itself never sends one; only raw API calls can.
    const replayable =
      !(init?.body instanceof ReadableStream) && !(input instanceof Request && input.body !== null);
    let revokedToken: string | undefined;
    for (let retry = 0; ; retry++) {
      const token = await tokens.token(signal, revokedToken);
      const response = await base(input, withAuthorization(init, token));
      if (
        token === undefined ||
        !replayable ||
        retry >= TOKEN_INVALIDATION_MAX_RETRIES ||
        !isTokenRevoked(response)
      ) {
        return response;
      }
      await tokens.invalidate(token);
      await response.body?.cancel();
      revokedToken = token;
      if (retry > 0) await sleep(TOKEN_REVOKED_RETRY_DELAY_MS, signal);
    }
  };
}

/**
 * Reports whether the server rejected a request's token as revoked, which it
 * can do before the token's stated expiry, for example after a role change.
 * The request was rejected before any work was done, so sending it again with
 * a new token is safe even when it has side effects.
 */
function isTokenRevoked(response: Response): boolean {
  // Both the control plane and sandboxes send this header, while their
  // bodies differ.
  return response.status === 401 && response.headers.get("x-blaxel-error-code") === "TOKEN_REVOKED";
}

function withAuthorization(init: RequestInit | undefined, token: string | undefined): RequestInit {
  if (token === undefined) return init ?? {};
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/** Waits on a promise, but stops waiting once the signal aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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
