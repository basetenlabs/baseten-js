import { ApiClient } from "./sandboxapi";
import { applyUserAgentHeader } from "./userAgent";

/** Options for {@link SandboxClient}. */
export interface SandboxClientOptions {
  /** Bearer token for authentication. */
  token: string;

  /**
   * Base URL of the sandbox, without a trailing slash. Each sandbox is reached
   * at its own host, so there is no default.
   */
  baseUrl: string;

  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;

  /** Additional headers to send on every request. */
  headers?: Record<string, string>;
}

/** Client for the Baseten Sandbox API. */
export class SandboxClient {
  private readonly _options: SandboxClientOptions;
  private readonly _api: ApiClient;

  constructor(options: SandboxClientOptions) {
    this._options = { ...options };
    const headers: Record<string, string> = { ...options.headers };
    // Empty token is an advanced opt-out from sending Authorization.
    if (options.token !== "") {
      headers["Authorization"] = `Bearer ${options.token}`;
    }
    applyUserAgentHeader(headers);
    this._api = new ApiClient({ baseUrl: options.baseUrl, headers, fetch: options.fetch });
  }

  /** The options this client was constructed with. */
  get options(): SandboxClientOptions {
    return this._options;
  }

  /**
   * The generated API client.
   *
   * The generated API surface is not covered by stability guarantees and
   * may change between versions.
   */
  get api(): ApiClient {
    return this._api;
  }
}
