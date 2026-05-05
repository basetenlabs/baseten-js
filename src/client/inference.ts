import { ApiClient } from "./inferenceapi";
import { applyUserAgentHeader } from "./userAgent";

/** Options for {@link InferenceClient}. */
export interface InferenceClientOptions {
  /** API key for authentication. */
  apiKey: string;

  /** Model ID. Mutually exclusive with chainId. */
  modelId?: string;

  /** Chain ID. Mutually exclusive with modelId. */
  chainId?: string;

  /** Environment name for regional routing (e.g. "production"). Affects the base URL hostname. */
  environment?: string;

  /**
   * Explicit base URL override. When set, modelId, chainId, and
   * environment are ignored.
   */
  baseUrlOverride?: string;

  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;

  /** Additional headers to send on every request. */
  headers?: Record<string, string>;
}

/** Client for the Baseten Inference API. */
export class InferenceClient {
  private readonly _options: InferenceClientOptions;
  private readonly _api: ApiClient;

  /**
   * Compute the default inference base URL.
   *
   * Exactly one of modelId or chainId must be provided.
   */
  static defaultBaseUrl(options: {
    modelId?: string;
    chainId?: string;
    environment?: string;
  }): string {
    const { modelId, chainId, environment } = options;
    if ((modelId == null) === (chainId == null)) {
      throw new Error("exactly one of modelId or chainId must be provided");
    }
    const prefix = modelId != null ? `model-${modelId}` : `chain-${chainId}`;
    if (environment != null) {
      return `https://${prefix}-${environment}.api.baseten.co`;
    }
    return `https://${prefix}.api.baseten.co`;
  }

  constructor(options: InferenceClientOptions) {
    this._options = { ...options };
    const baseUrl =
      options.baseUrlOverride ??
      InferenceClient.defaultBaseUrl({
        modelId: options.modelId,
        chainId: options.chainId,
        environment: options.environment,
      });
    const headers: Record<string, string> = { ...options.headers };
    // Empty apiKey is an advanced opt-out from sending Authorization.
    if (options.apiKey !== "") {
      headers["Authorization"] = `Api-Key ${options.apiKey}`;
    }
    applyUserAgentHeader(headers);
    this._api = new ApiClient({ baseUrl, headers, fetch: options.fetch });
  }

  /** The options this client was constructed with. */
  get options(): InferenceClientOptions {
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
