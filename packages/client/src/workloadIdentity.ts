import type { AccessToken, AccessTokenOptions, AccessTokenSource } from "./credentials";
import { ManagementClient } from "./management";
import { TokenCache, type Token } from "./tokenauth";
import { applyUserAgentHeader } from "./userAgent";

// The token exchange takes an RFC 8693 request naming the trust rule as its audience.
const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";

const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;
const DEFAULT_EXCHANGE_TIMEOUT_MS = 10_000;

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
   * files are rotated in place. Node only. Exactly one of
   * {@link identityToken} and identityTokenFile is required.
   */
  identityTokenFile?: string;

  /** Management API base URL the exchange is sent to. Defaults to https://api.baseten.co. */
  baseUrl?: string;

  /** Custom fetch implementation for the exchange. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;

  /**
   * How long before expiry the access token is replaced. Defaults to five
   * minutes. Either way it is capped at half the token's lifetime.
   */
  refreshBeforeExpiryMs?: number;

  /** Bounds one exchange, which every caller waiting for a token shares. Defaults to 10 seconds. */
  exchangeTimeoutMs?: number;
}

/**
 * Thrown when Baseten refuses a workload identity token exchange. The server
 * gives no reason: the trust rule may not exist, may not match the identity
 * token's issuer or claims, or the identity token may be expired or have the
 * wrong audience.
 */
export class InvalidGrantError extends Error {
  readonly trustRuleId: string;

  constructor(trustRuleId: string) {
    super(
      `workload identity token exchange refused for trust rule ${trustRuleId}: invalid_grant ` +
        "(the trust rule may not exist or may not match the identity token's issuer, audience, or claims, " +
        "or the identity token may have expired)",
    );
    this.name = "InvalidGrantError";
    this.trustRuleId = trustRuleId;
  }
}

/**
 * Exchanges an identity provider's JWT for a Baseten access token under a
 * trust rule (OIDC workload identity federation). The exchange happens on
 * first use; the access token is cached in memory and replaced shortly before
 * it expires. Concurrent callers share one exchange.
 */
export class WorkloadIdentityCredentials implements AccessTokenSource {
  readonly #trustRuleId: string;
  readonly #identityToken: IdentityTokenGetter;
  readonly #exchangeUrl: string;
  readonly #fetch: typeof fetch;
  readonly #cache: TokenCache;

  /** Validates options. Does not contact Baseten; the first exchange happens on first use. */
  constructor(options: WorkloadIdentityCredentialsOptions) {
    if ((options.identityToken === undefined) === (options.identityTokenFile === undefined)) {
      throw new Error("exactly one of identityToken and identityTokenFile is required");
    }
    if (!options.trustRuleId) throw new Error("trustRuleId is required");
    const refreshBeforeMs = options.refreshBeforeExpiryMs ?? DEFAULT_REFRESH_BEFORE_EXPIRY_MS;
    if (!(refreshBeforeMs >= 0)) {
      throw new Error("refreshBeforeExpiryMs must not be negative");
    }
    const exchangeTimeoutMs = options.exchangeTimeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
    if (!(exchangeTimeoutMs > 0)) throw new Error("exchangeTimeoutMs must be positive");
    this.#trustRuleId = options.trustRuleId;
    this.#identityToken =
      options.identityToken ?? identityTokenFromFile(options.identityTokenFile!);
    const baseUrl = (options.baseUrl ?? ManagementClient.defaultBaseUrl()).replace(/\/+$/, "");
    this.#exchangeUrl = `${baseUrl}/v1/auth/token`;
    const customFetch = options.fetch;
    // Resolved per call so a fetch replaced after construction is still used.
    this.#fetch = customFetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#cache = new TokenCache({
      mint: (signal) => this.#exchange(signal),
      refreshBeforeMs,
      mintTimeoutMs: exchangeTimeoutMs,
      mintName: "workload identity token exchange",
    });
  }

  /**
   * Returns a current access token, exchanging the identity token for a new
   * one when none is cached or the cached one is due for refresh.
   */
  async accessToken(options?: AccessTokenOptions): Promise<AccessToken> {
    const token = await this.#cache.token(options?.signal);
    return { token: token.value, expiresAt: new Date(token.expiresAtMs) };
  }

  /** Drops token if it is still the cached one, so the next call exchanges again. */
  invalidateAccessToken(token: string): void {
    this.#cache.invalidate(token);
  }

  async #exchange(signal: AbortSignal): Promise<Token> {
    let assertion: string;
    try {
      assertion = (await this.#identityToken({ signal })).trim();
    } catch (err) {
      throw new Error(`getting identity token: ${errorMessage(err)}`, { cause: err });
    }
    if (assertion === "") throw new Error("getting identity token: the identity token is empty");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    applyUserAgentHeader(headers);
    // Taken before sending, so the computed expiry errs early.
    const issuedAtMs = Date.now();
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(this.#exchangeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
          subject_token: assertion,
          subject_token_type: JWT_TOKEN_TYPE,
          audience: this.#trustRuleId,
        }),
        signal,
      });
      text = await response.text();
    } catch (err) {
      throw new Error(`workload identity token exchange: ${errorMessage(err)}`, { cause: err });
    }
    let decoded: {
      access_token?: unknown;
      token_type?: unknown;
      expires_in?: unknown;
      error?: unknown;
    };
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new Error(
        `workload identity token exchange: HTTP ${response.status} with a non-JSON response: ${truncateForError(text)}`,
      );
    }
    if (response.status !== 200) {
      if (decoded?.error === "invalid_grant") throw new InvalidGrantError(this.#trustRuleId);
      throw new Error(
        `workload identity token exchange: HTTP ${response.status}: ${truncateForError(text)}`,
      );
    }
    const { access_token, token_type, expires_in } = decoded ?? {};
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

function truncateForError(body: string): string {
  const maxLength = 512;
  const trimmed = body.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
