import { ApiClient } from "./managementapi";

/** Options for {@link ManagementClient}. */
export interface ManagementClientOptions {
  /** API key for authentication. */
  apiKey: string;

  /** Explicit base URL override, or undefined to use the default. */
  baseUrlOverride?: string;

  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
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
    const headers: Record<string, string> = {
      Authorization: `Api-Key ${options.apiKey}`,
    };
    this._api = new ApiClient({ baseUrl, headers, fetch: options.fetch });
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
