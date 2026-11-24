import { type Credentials, ManagementClient, managementapi } from "@basetenlabs/client";
import {
  abortable,
  authenticatedTransport,
  TokenCache,
  withBearer,
} from "@basetenlabs/client/internal";
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
 * or a token minted with an API key or credentials, cached until shortly
 * before it expires.
 *
 * The API key is exchanged for a token because the sandbox APIs do not
 * accept API keys directly. Should that change, only this class changes.
 */
export class TokenSource {
  private readonly cache?: TokenCache;
  private readonly provider?: SandboxTokenProvider;

  constructor(options: {
    apiKey?: string;
    credentials?: Credentials;
    tokenProvider?: SandboxTokenProvider;
    managementBaseUrlOverride?: string;
    fetch: typeof fetch;
    headers?: Record<string, string>;
  }) {
    const { apiKey, credentials, tokenProvider } = options;
    const given = [
      apiKey !== undefined && apiKey !== "",
      credentials !== undefined,
      tokenProvider !== undefined,
    ].filter(Boolean).length;
    if (given > 1) {
      throw new Error("only one of apiKey, credentials, and tokenProvider may be set");
    }
    // An empty apiKey alone is the advanced opt-out from sending Authorization.
    if (given === 0 && apiKey === undefined) {
      throw new Error("one of apiKey, credentials, or tokenProvider is required");
    }
    if (
      credentials !== undefined &&
      Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === "authorization")
    ) {
      throw new Error("headers must not set Authorization when credentials is set");
    }
    if (tokenProvider !== undefined) {
      this.provider = tokenProvider;
    } else if (given === 1) {
      const baseUrl = options.managementBaseUrlOverride ?? ManagementClient.defaultBaseUrl();
      // Built once, so a token Baseten refused on one mint is replaced on the
      // next instead of being handed out again.
      const transport = authenticatedTransport(
        {
          ...(credentials === undefined ? { apiKey } : { credentials }),
          fetch: options.fetch,
          headers: options.headers,
        },
        baseUrl,
      );
      const transportFetch = transport.fetch ?? options.fetch;
      this.cache = new TokenCache({
        mint: async (signal) => {
          // The signal goes in above the credentials, so it also stops their
          // wait for an access token.
          const api = new managementapi.ApiClient({
            baseUrl,
            headers: transport.headers,
            fetch: (input, init) => transportFetch(input, { ...init, signal }),
          });
          const minted = await api.postToken({ request: { scopes: ["sandboxes"] } });
          return { value: minted.token, expiresAtMs: Date.parse(minted.expires_at) };
        },
        refreshLeewayMs: TOKEN_EXPIRY_LEEWAY_MS,
        mintTimeoutMs: TOKEN_MINT_TIMEOUT_MS,
        mintName: "sandbox token exchange",
      });
    }
  }

  /**
   * Returns the token for a request, or undefined when no Authorization
   * should be sent, which is the advanced opt-out of an empty API key with no
   * token provider. revokedToken is the token the previous send was rejected
   * with, if any.
   */
  async token(signal?: AbortSignal, revokedToken?: string): Promise<string | undefined> {
    // The provider cannot be told to stop, so only the waiting on it does.
    if (this.provider !== undefined) return abortable(this.provider({ revokedToken }), signal);
    if (this.cache === undefined) return undefined;
    return (await this.cache.token(signal)).value;
  }

  /** Drops a token the server rejected, so the next request gets a new one. */
  invalidate(token: string): void {
    this.cache?.invalidate(token);
  }
}

/**
 * Wraps a fetch to authenticate every request with a token from the source,
 * and to send it again with a new one when the server rejects the token as
 * revoked.
 */
export function authenticatedFetch(base: typeof fetch, tokens: TokenSource): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    // A stream body can be read only once, so a request carrying one is never
    // sent again.
    const replayable =
      !(init?.body instanceof ReadableStream) && !(input instanceof Request && input.body !== null);
    let revokedToken: string | undefined;
    for (let retry = 0; ; retry++) {
      const token = await tokens.token(signal, revokedToken);
      const response = await base(input, withBearer(input, init, token));
      if (token === undefined || !isTokenRevoked(response)) return response;
      // Dropped even when the request is not sent again, so later requests do
      // not reuse it.
      tokens.invalidate(token);
      if (!replayable || retry >= TOKEN_INVALIDATION_MAX_RETRIES) return response;
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
export function isTokenRevoked(response: Response): boolean {
  // Both the control plane and sandboxes send this header, while their bodies
  // differ.
  return response.status === 401 && response.headers.get("x-blaxel-error-code") === "TOKEN_REVOKED";
}
