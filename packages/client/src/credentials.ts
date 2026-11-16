import { fetchWithBearerToken, requestHeaders, withBearer } from "./tokenauth";
import { applyUserAgentHeader } from "./userAgent";

/** A short-lived Baseten access token, sent as "Authorization: Bearer <token>". */
export interface AccessToken {
  token: string;
  expiresAt: Date;
}

/** Options for {@link AccessTokenSource.accessToken}. */
export interface AccessTokenOptions {
  /** Stops the caller's wait for a token. */
  signal?: AbortSignal;
}

/**
 * Supplies a current Baseten access token, for example
 * {@link WorkloadIdentityCredentials}. A client configured with one asks it
 * before every request, so the source decides when to refresh.
 */
export interface AccessTokenSource {
  accessToken(options?: AccessTokenOptions): Promise<AccessToken>;

  /**
   * Drops token if it is still the cached one. Implemented by a source that
   * caches tokens. When Baseten refuses a token before it expires, for example
   * because it was revoked, a client drops it with this, asks the source for a
   * new one, and sends the request again. Clients resend only for sources that
   * implement this.
   */
  invalidateAccessToken?(token: string): void;
}

// Revocation refuses every token issued before a cutoff that can fall a moment
// after the revoking event, so the second resend waits this long for the next
// token to be minted past it.
const ACCESS_TOKEN_RESEND_DELAY_MS = 1000;

/**
 * Returns the headers and fetch a client sends its requests with, given
 * exactly one of apiKey and credentials. An empty apiKey counts as given: it
 * is the advanced opt-out from sending Authorization.
 */
export function authenticatedTransport(
  options: {
    apiKey?: string;
    credentials?: AccessTokenSource;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
  },
  baseUrl: string,
): { headers: Record<string, string>; fetch?: typeof fetch } {
  validateAuthOptions(options.apiKey, options.credentials, options.headers);
  const headers: Record<string, string> = { ...options.headers };
  if (options.apiKey !== undefined && options.apiKey !== "") {
    headers["Authorization"] = `Api-Key ${options.apiKey}`;
  }
  applyUserAgentHeader(headers);
  if (options.credentials === undefined) return { headers, fetch: options.fetch };
  // Resolved per call so a fetch replaced after construction is still used.
  const base = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return { headers, fetch: bearerAuthFetch(base, options.credentials, baseUrl) };
}

function validateAuthOptions(
  apiKey: string | undefined,
  credentials: AccessTokenSource | undefined,
  headers: Record<string, string> | undefined,
): void {
  if (apiKey !== undefined && credentials !== undefined) {
    throw new Error("apiKey and credentials are mutually exclusive");
  }
  if (apiKey === undefined && credentials === undefined) {
    throw new Error("one of apiKey or credentials is required");
  }
  if (
    credentials !== undefined &&
    Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization")
  ) {
    throw new Error("headers must not set Authorization when credentials is set");
  }
}

/**
 * Wraps a fetch to set "Authorization: Bearer" from source on each request to
 * baseUrl's origin, so a long-running operation picks up refreshed tokens.
 * Requests to other origins, and requests that already carry Authorization,
 * are passed through untouched. Redirects to another origin drop
 * Authorization, as the Fetch standard requires; a custom fetch must do the
 * same.
 */
export function bearerAuthFetch(
  base: typeof fetch,
  source: AccessTokenSource,
  baseUrl: string,
): typeof fetch {
  const origin = new URL(baseUrl).origin;
  const resend = source.invalidateAccessToken !== undefined;
  const getToken = async (signal: AbortSignal | undefined, refused: string | undefined) => {
    if (refused !== undefined) source.invalidateAccessToken!(refused);
    const { token } = await source.accessToken({ signal });
    if (token === "") throw new Error("the access token source returned an empty token");
    return token;
  };
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (new URL(url).origin !== origin || requestHeaders(input, init).has("authorization")) {
      return base(input, init);
    }
    if (!resend) {
      // Without a way to drop the refused token, the source would return it
      // again, so the request is sent once.
      const token = await getToken(init?.signal ?? undefined, undefined);
      return base(input, withBearer(input, init, token));
    }
    return fetchWithBearerToken(base, input, init, getToken, ACCESS_TOKEN_RESEND_DELAY_MS);
  };
}
