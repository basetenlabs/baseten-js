import { requestHeaders, withBearer } from "./tokenauth";
import { applyUserAgentHeader } from "./userAgent";

/** A short-lived Baseten access token, sent as "Authorization: Bearer <token>". */
export interface AccessToken {
  token: string;
  expiresAt: Date;
}

/**
 * Options for {@link Credentials.accessToken}. Fields may be added in later
 * versions, so implementations should ignore ones they do not know.
 */
export interface AccessTokenOptions {
  /** Stops the caller's wait for a token. */
  signal?: AbortSignal;
  /**
   * A token Baseten refused before its stated expiry. Credentials that cache
   * tokens must not return it again.
   */
  refusedToken?: string;
}

/**
 * Supplies a current Baseten access token, for example
 * {@link WorkloadIdentityCredentials}. A client configured with credentials
 * asks them before every request, so the credentials decide when to refresh.
 */
export interface Credentials {
  accessToken(options: AccessTokenOptions): Promise<AccessToken>;
}

/**
 * Returns the headers and fetch a client sends its requests with, given
 * exactly one of apiKey and credentials. An empty apiKey counts as given: it
 * is the advanced opt-out from sending Authorization.
 */
export function authenticatedTransport(
  options: {
    apiKey?: string;
    credentials?: Credentials;
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
  credentials: Credentials | undefined,
  headers: Record<string, string> | undefined,
): void {
  // An empty apiKey next to credentials counts as unset, as in Go.
  if (apiKey !== undefined && apiKey !== "" && credentials !== undefined) {
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
 * Wraps a fetch to set "Authorization: Bearer" from credentials on each
 * request to baseUrl's origin, so a long-running operation picks up refreshed
 * tokens. Requests to other origins, and requests that already carry
 * Authorization, are passed through untouched. Redirects to another origin
 * drop Authorization, as the Fetch standard requires; a custom fetch must do
 * the same.
 */
export function bearerAuthFetch(
  base: typeof fetch,
  credentials: Credentials,
  baseUrl: string,
): typeof fetch {
  const origin = new URL(baseUrl).origin;
  // The last token Baseten refused, passed to the next accessToken call so the
  // credentials replace it.
  let refused: string | undefined;
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (new URL(url).origin !== origin || requestHeaders(input, init).has("authorization")) {
      return base(input, init);
    }
    const options: AccessTokenOptions = { signal: init?.signal ?? undefined };
    if (refused !== undefined) {
      options.refusedToken = refused;
      refused = undefined;
    }
    const { token } = await credentials.accessToken(options);
    if (token === "") throw new Error("the credentials returned an empty access token");
    const response = await base(input, withBearer(input, init, token));
    // The request is not sent again, since it may have side effects; only the
    // next request gets a new token.
    if (refusedByBaseten(response)) refused = token;
    return response;
  };
}

/**
 * Reports whether Baseten's auth layer refused the request's access token,
 * which it signals with this challenge. A model's own error response cannot
 * carry it, since its headers are not forwarded.
 */
function refusedByBaseten(response: Response): boolean {
  if (response.status !== 401) return false;
  // Headers joins several challenges into one comma-separated value.
  const challenge = response.headers.get("www-authenticate") ?? "";
  return (
    /(^|,\s*)Bearer /.test(challenge) &&
    challenge.includes('realm="baseten"') &&
    challenge.includes('error="invalid_token"')
  );
}
