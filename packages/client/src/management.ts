import { ApiClient } from "./managementapi";
import { authenticatedTransport, type Credentials } from "./credentials";

/** Options for {@link ManagementClient}. */
export interface ManagementClientOptions {
  /**
   * API key for authentication. Exactly one of apiKey and
   * {@link credentials} is required. Empty is an advanced opt-out from
   * sending Authorization.
   */
  apiKey?: string;

  /**
   * Supplies short-lived access tokens instead of an API key, for example
   * {@link WorkloadIdentityCredentials}. A token is fetched for every
   * request, and sent as "Authorization: Bearer <token>" to the client's own
   * base URL only.
   */
  credentials?: Credentials;

  /** Explicit base URL override, or undefined to use the default. */
  baseUrlOverride?: string;

  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;

  /** Additional headers to send on every request. */
  headers?: Record<string, string>;
}

/** Client for the Baseten Management API. */
export class ManagementClient {
  private readonly _options: ManagementClientOptions;
  private readonly _api: ApiClient;

  /** Return the default base URL for the management API. */
  static defaultBaseUrl(): string {
    return "https://api.baseten.co";
  }

  constructor(options: ManagementClientOptions) {
    this._options = { ...options };
    const baseUrl = options.baseUrlOverride ?? ManagementClient.defaultBaseUrl();
    this._api = new ApiClient({ baseUrl, ...authenticatedTransport(options, baseUrl) });
  }

  /** The options this client was constructed with. */
  get options(): ManagementClientOptions {
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
