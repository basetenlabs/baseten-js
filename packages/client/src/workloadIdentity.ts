import type { AccessToken, AccessTokenOptions, Credentials } from "./credentials";
import { ManagementClient } from "./management";
import { ApiClient, ResponseError, type TokenExchangeResponse } from "./managementapi";
import { TokenCache, type Token } from "./tokenauth";
import { applyUserAgentHeader } from "./userAgent";

// The token exchange takes an RFC 8693 request naming the trust rule as its audience.
const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";

const DEFAULT_REFRESH_LEEWAY_MS = 5 * 60_000;
// As in the Go SDK.
const EXCHANGE_TIMEOUT_MS = 10_000;

/** Options for {@link IdentityTokenGetter}. */
export interface IdentityTokenOptions {
  /** Aborts when the exchange the token is for times out. */
  signal: AbortSignal;
}

/** Returns the identity provider's JWT. Called on every exchange. */
export type IdentityTokenGetter = (options: IdentityTokenOptions) => Promise<string> | string;

/**
 * Options for {@link WorkloadIdentityCredentials}. Credentials are supplied
 * explicitly; the SDK reads no environment variables.
 */
export interface WorkloadIdentityCredentialsOptions {
  /** The Baseten trust rule the identity token is exchanged under. */
  trustRuleId: string;

  /**
   * Returns the identity provider's JWT. Exactly one of identityToken and
   * {@link identityTokenFile} is required.
   */
  identityToken?: IdentityTokenGetter;

  /**
   * A file holding the identity provider's JWT, for example a projected
   * Kubernetes service account token. Re-read on every exchange, since such
   * files are rotated in place. Needs Node 22.3 or newer. Exactly one of
   * {@link identityToken} and identityTokenFile is required.
   */
  identityTokenFile?: string;

  /**
   * Management API base URL the exchange is sent to. Defaults to
   * https://api.baseten.co. Must point at the same environment as the client
   * using these credentials, since an access token is valid only there.
   */
  baseUrl?: string;

  /**
   * Custom fetch implementation for the exchange. Defaults to
   * globalThis.fetch. The exchange asks not to follow redirects, since its
   * body carries the identity token, so a custom fetch should honor
   * `redirect: "manual"`.
   */
  fetch?: typeof fetch;

  /**
   * How long before expiry the access token is replaced. Defaults to five
   * minutes. Either way it is capped at half the token's lifetime.
   */
  refreshLeewayMs?: number;
}

/**
 * Exchanges an identity provider's JWT for a Baseten access token under a
 * trust rule (OIDC workload identity federation), for use as a client's
 * `credentials` instead of an API key. The exchange happens on first use; the
 * access token is cached in memory and replaced shortly before it expires.
 * Concurrent callers share one exchange.
 *
 * A failed exchange throws the management API's `ResponseError`, carrying the
 * status code and response body.
 *
 * @example
 * A workload exchanges a projected Kubernetes service account token:
 * ```typescript
 * import { ManagementClient, WorkloadIdentityCredentials } from "@basetenlabs/client";
 *
 * const credentials = new WorkloadIdentityCredentials({
 *   identityTokenFile: "/var/run/secrets/tokens/baseten",
 *   trustRuleId: "my-trust-rule-id",
 * });
 * const client = new ManagementClient({ credentials });
 * console.log((await client.api.getOrganizationsMe()).org_id);
 * ```
 */
export class WorkloadIdentityCredentials implements Credentials {
  readonly #trustRuleId: string;
  readonly #identityToken: IdentityTokenGetter;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #cache: TokenCache;

  /** Validates options. Does not contact Baseten; the first exchange happens on first use. */
  constructor(options: WorkloadIdentityCredentialsOptions) {
    if ((options.identityToken === undefined) === (options.identityTokenFile === undefined)) {
      throw new Error("exactly one of identityToken and identityTokenFile is required");
    }
    if (options.identityToken !== undefined && typeof options.identityToken !== "function") {
      throw new Error("identityToken must be a function returning the identity token");
    }
    if (options.identityTokenFile === "") throw new Error("identityTokenFile must not be empty");
    if (!options.trustRuleId) throw new Error("trustRuleId is required");
    const refreshLeewayMs = options.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS;
    if (!(refreshLeewayMs >= 0)) throw new Error("refreshLeewayMs must not be negative");
    checkMaxDelay("refreshLeewayMs", refreshLeewayMs);
    this.#trustRuleId = options.trustRuleId;
    if (options.identityToken !== undefined) {
      const getter = options.identityToken;
      this.#identityToken = async (getOptions) => {
        try {
          return await getter(getOptions);
        } catch (err) {
          throw new Error(`getting identity token: ${errorMessage(err)}`, { cause: err });
        }
      };
    } else {
      // Its errors already name the file.
      this.#identityToken = identityTokenFromFile(options.identityTokenFile!);
    }
    const baseUrl = (options.baseUrl ?? ManagementClient.defaultBaseUrl()).replace(/\/+$/, "");
    this.#baseUrl = baseUrl;
    const customFetch = options.fetch;
    // Resolved per call so a fetch replaced after construction is still used.
    this.#fetch = customFetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#cache = new TokenCache({
      mint: (signal) => this.#exchange(signal),
      refreshLeewayMs,
      mintTimeoutMs: EXCHANGE_TIMEOUT_MS,
      mintName: "workload identity token exchange",
    });
  }

  /**
   * Returns a current access token, exchanging the identity token for a new
   * one when none is cached or the cached one is within the refresh leeway of
   * expiry.
   */
  async accessToken(options?: AccessTokenOptions): Promise<AccessToken> {
    if (options?.refusedToken !== undefined) this.#cache.invalidate(options.refusedToken);
    const token = await this.#cache.token(options?.signal);
    return { token: token.value, expiresAt: new Date(token.expiresAtMs) };
  }

  async #exchange(signal: AbortSignal): Promise<Token> {
    const assertion = (await this.#identityToken({ signal })).trim();
    if (assertion === "") throw new Error("getting identity token: the identity token is empty");
    const headers: Record<string, string> = {};
    applyUserAgentHeader(headers);
    // No credentials: the identity token in the body is what authenticates.
    // Built per exchange so the exchange's abort signal reaches its fetch.
    // Redirects are not followed, as in the other SDKs, since the body carries
    // the identity token.
    const api = new ApiClient({
      baseUrl: this.#baseUrl,
      headers,
      fetch: (input, init) => this.#fetch(input, { ...init, signal, redirect: "manual" }),
    });
    // Taken before sending, so the computed expiry errs early.
    const issuedAtMs = Date.now();
    let decoded: TokenExchangeResponse;
    try {
      decoded = await api.postAuthToken({
        request: {
          grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
          subject_token: assertion,
          subject_token_type: JWT_TOKEN_TYPE,
          audience: this.#trustRuleId,
        },
      });
    } catch (err) {
      if (err instanceof ResponseError) throw this.#exchangeError(err);
      throw new Error(`workload identity token exchange: ${errorMessage(err)}`, { cause: err });
    }
    const { access_token, token_type, expires_in } = decoded;
    if (typeof access_token !== "string" || access_token === "") {
      throw new Error("workload identity token exchange: the response carried no access_token");
    }
    if (typeof token_type !== "string" || token_type.toLowerCase() !== "bearer") {
      throw new Error(
        `workload identity token exchange: unsupported token_type ${JSON.stringify(token_type)}`,
      );
    }
    if (typeof expires_in !== "number" || !(expires_in > 0)) {
      throw new Error(
        `workload identity token exchange: invalid expires_in ${JSON.stringify(expires_in)}`,
      );
    }
    return { value: access_token, expiresAtMs: issuedAtMs + expires_in * 1000 };
  }

  #exchangeError(err: ResponseError): ResponseError {
    // The server sends every refusal as the same OAuth invalid_grant, so the
    // hint covers each possible cause.
    const context =
      oauthErrorCode(err.body) === "invalid_grant"
        ? `workload identity token exchange refused for trust rule ${this.#trustRuleId} ` +
          "(the trust rule may not exist or may not match the identity token's issuer, audience, or claims, " +
          "or the identity token may have expired)"
        : "workload identity token exchange";
    err.message = `${context}: ${err.message}`;
    return err;
  }
}

/**
 * Returns an {@link IdentityTokenGetter} that reads the identity provider's
 * JWT from a file on every call, since such files are rotated in place.
 * Node only.
 */
export function identityTokenFromFile(path: string): IdentityTokenGetter {
  return async () => {
    // Reached through getBuiltinModule rather than an import of node:fs, so
    // the package still loads in browsers and edge runtimes.
    const fs = (
      typeof process === "undefined" ? undefined : process.getBuiltinModule?.("node:fs/promises")
    ) as { readFile(path: string, encoding: "utf8"): Promise<string> } | undefined;
    if (fs === undefined) {
      throw new Error("reading an identity token file needs Node 22.3 or newer");
    }
    let token: string;
    try {
      token = (await fs.readFile(path, "utf8")).trim();
    } catch (err) {
      throw new Error(`reading identity token file: ${errorMessage(err)}`, { cause: err });
    }
    if (token === "") throw new Error(`reading identity token file ${path}: the file is empty`);
    return token;
  };
}

// setTimeout fires after 1 ms when given a delay above this.
const MAX_TIMEOUT_MS = 2_147_483_647;

function checkMaxDelay(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms > MAX_TIMEOUT_MS) {
    throw new Error(
      `${name} must be a finite number of milliseconds no greater than ${MAX_TIMEOUT_MS}`,
    );
  }
}

function oauthErrorCode(body: string): unknown {
  try {
    return (JSON.parse(body) as { error?: unknown } | null)?.error;
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
