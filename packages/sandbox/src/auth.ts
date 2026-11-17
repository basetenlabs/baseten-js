import { type Credentials, ManagementClient } from "@basetenlabs/client";
import { abortable, fetchWithBearerToken, TokenCache } from "@basetenlabs/client/internal";

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
// between this machine and the server, and for time spent in flight. Capped at
// half the token's lifetime.
const TOKEN_EXPIRY_LEEWAY_MS = 60_000;

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
    if (tokenProvider !== undefined) {
      this.provider = tokenProvider;
    } else if (given === 1) {
      this.cache = new TokenCache({
        mint: async (signal) => {
          const api = new ManagementClient({
            ...(credentials === undefined ? { apiKey } : { credentials }),
            baseUrlOverride: options.managementBaseUrlOverride,
            fetch: (input, init) => options.fetch(input, { ...init, signal }),
            headers: options.headers,
          }).api;
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
    if (revokedToken !== undefined) this.cache.invalidate(revokedToken);
    return (await this.cache.token(signal)).value;
  }
}

/**
 * Wraps a fetch to authenticate every request with a token from the source.
 */
export function authenticatedFetch(base: typeof fetch, tokens: TokenSource): typeof fetch {
  return (input, init) =>
    fetchWithBearerToken(
      base,
      input,
      init,
      (signal, revokedToken) => tokens.token(signal, revokedToken),
      TOKEN_REVOKED_RETRY_DELAY_MS,
    );
}
