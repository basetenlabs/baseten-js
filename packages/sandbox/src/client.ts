import { ManagementClient } from "@basetenlabs/client";
import type { ApiClient as ManagementApiClient } from "@basetenlabs/client/managementapi";
import { authenticatedFetch, type SandboxTokenProvider, TokenSource } from "./auth";
import type { CallOptions, SandboxRetryOptions } from "./common";
import { toSandboxApiError } from "./errors";
import { ImageClient } from "./images/images";
import {
  type SandboxEnvValue,
  type SandboxInfo,
  type SandboxLifecycle,
  type SandboxNetwork,
  type SandboxPort,
  sandboxEnvsToApi,
  sandboxInfoFromApi,
  sandboxLifecycleToApi,
  sandboxNetworkToApi,
  sandboxPortsToApi,
  type SandboxStatus,
} from "./info";
import { Sandbox, type SandboxOptions } from "./sandbox/sandbox";
import { Transport } from "./transport";

/** Options for {@link SandboxClient}. */
export interface SandboxClientOptions {
  /**
   * API key for authentication. Empty, together with {@link tokenProvider},
   * is the advanced opt-out of API key authentication.
   */
  apiKey: string;

  /**
   * Returns the bearer token for each request, instead of one derived from
   * the API key, which must then be empty.
   */
  tokenProvider?: SandboxTokenProvider;

  /**
   * Team to act in. Unset uses the caller's only team, and is an error for
   * callers in more than one team.
   */
  teamId?: string;

  /** Explicit base URL override for the management API, or undefined to use the default. */
  baseUrlOverride?: string;

  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;

  /** Additional headers to send on every request. */
  headers?: Record<string, string>;

  /**
   * Whether to send requests on Node through the optional undici package.
   *
   * With undici, requests use HTTP/2 with flow control windows sized for
   * large downloads. Without it, they use Node's own fetch: HTTP/1.1 before
   * Node 26, and from Node 26 on, HTTP/2 with small windows that slow large
   * downloads. Supported undici versions are 7.19.0 and newer 7.x, plus 8.x on
   * Node 26 and newer. Other versions count as not installed.
   *
   * When unset, undici is used if a supported version is installed and the
   * app has not set its own global dispatcher, such as a proxy. A plain undici
   * `Agent` set as the global dispatcher cannot be told apart from the one
   * undici installs itself, so an app that customizes one should pass `false`
   * or its own `fetch` to keep it in charge. The app's own fetch is left
   * unchanged. `true` requires undici and fails requests with an
   * error saying why it cannot be used. `false` never loads it. Has no effect
   * outside Node, or when `fetch` is supplied.
   */
  nodeUndici?: boolean;

  /** Retry budgets for transient failures. */
  retries?: SandboxRetryOptions;
}

/** Request for {@link SandboxClient.create}. */
export interface SandboxCreateRequest {
  /** Unique name of the sandbox. Assigned by the server when unset. */
  name?: string;

  /**
   * When true, return the existing live sandbox with this name, or recreate
   * it if it is failed, terminated, or being deleted. Requires `name`.
   * Existing configuration is preserved.
   */
  createIfNotExists?: boolean;

  /** Image reference including its tag. Defaults to `baseten/base-image:latest`. */
  image?: string;

  /** Memory in megabytes, which also sets the CPU allocation. Defaults to 4096. */
  memory?: number;

  /** Region to run in. Unset picks the closest one. */
  region?: string;

  /** Environment variables, by name. */
  envs?: Record<string, SandboxEnvValue>;

  labels?: Record<string, string>;

  /** Caller-owned identifier for external lookups. */
  externalId?: string;

  /** When the sandbox is deleted automatically. */
  lifecycle?: SandboxLifecycle;

  ports?: SandboxPort[];

  /** Network configuration, which cannot be changed after creation. */
  network?: SandboxNetwork;
  callOptions?: CallOptions;
}

/** A newly created sandbox, with its record as of creation. */
export class SandboxCreateResult extends Sandbox {
  /** The sandbox as reported when creation returned. */
  readonly info: SandboxInfo;

  /** @internal Returned by {@link SandboxClient.create}. */
  constructor(options: SandboxOptions, tokens: TokenSource, info: SandboxInfo) {
    super(options, tokens);
    this.info = info;
  }
}

/** Request for {@link SandboxClient.getInfo}. */
export interface SandboxGetInfoRequest {
  name: string;

  /**
   * Reveal environment variable values for workspace administrators.
   * Defaults to false. Callers without the admin role receive masked values
   * even when true.
   */
  showSecrets?: boolean;
  callOptions?: CallOptions;
}

/**
 * Request for {@link SandboxClient.get}, by name, or from a record already
 * in hand, which needs no call.
 */
export type SandboxGetRequest =
  | { name: string; callOptions?: CallOptions }
  | { info: SandboxInfo; callOptions?: CallOptions };

/** Request for {@link SandboxClient.list}. */
export interface SandboxListRequest {
  /** Searches sandbox names and labels. */
  query?: string;

  /** Only sandboxes with one of these statuses. Cannot be combined with `externalId`. */
  statuses?: SandboxStatus[];

  /** Only the sandbox with this external identifier. Cannot be combined with `statuses`. */
  externalId?: string;

  /** How many sandboxes to fetch per underlying request. */
  pageSize?: number;
  callOptions?: CallOptions;
}

/**
 * Request for {@link SandboxClient.update}. Unset fields stay unchanged, and
 * set ones replace their previous values, including every entry of `envs`,
 * `labels`, `ports`, and `lifecycle.expirationPolicies`. Other `lifecycle`
 * fields change only when set. At least one field must be set. Memory and
 * network cannot be changed after creation.
 */
export interface SandboxUpdateRequest {
  name: string;

  /** False to disable the sandbox, so it accepts no connections. */
  enabled?: boolean;

  /** When the sandbox is deleted automatically. */
  lifecycle?: SandboxLifecycle;

  region?: string;

  /** Environment variables, by name. */
  envs?: Record<string, SandboxEnvValue>;

  /** Image reference including its tag. */
  image?: string;

  ports?: SandboxPort[];

  /** Caller-owned identifier for external lookups. */
  externalId?: string;

  labels?: Record<string, string>;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxClient.delete}. */
export interface SandboxDeleteRequest {
  name: string;
  callOptions?: CallOptions;
}

/**
 * Client for Baseten sandboxes: creating, finding, and deleting sandboxes,
 * and getting a {@link Sandbox} to work in one.
 *
 * On Node, HTTP/2 is strongly recommended. See
 * {@link SandboxClientOptions.nodeUndici} for how the client uses it.
 */
export class SandboxClient {
  readonly #options: SandboxClientOptions;
  #transport: Transport;
  #tokens: TokenSource;
  #fetchWithAuth!: typeof fetch;
  #unsignaledApi!: ManagementApiClient;
  #images: ImageClient | undefined;

  constructor(options: SandboxClientOptions) {
    this.#options = { ...options };
    this.#transport = new Transport({ fetch: options.fetch, nodeUndici: options.nodeUndici });
    this.#tokens = this.#newTokens();
    this.#authenticate();
  }

  /** The options this client was constructed with. */
  get options(): SandboxClientOptions {
    return this.#options;
  }

  /**
   * The generated management API client, authenticated for sandboxes, for
   * operations this SDK does not wrap.
   *
   * The generated API surface is not covered by stability guarantees and may
   * change between versions.
   */
  get rawApi(): ManagementApiClient {
    return this.#unsignaledApi;
  }

  /** Images that sandboxes are created from. */
  get images(): ImageClient {
    this.#images ??= new ImageClient({
      api: (signal) => this.#api(signal),
      teamId: this.#options.teamId,
      // Read on each call, since withOptions may swap the transport.
      fetch: (input, init) => this.#transport.fetch(input, init),
    });
    return this.#images;
  }

  /**
   * Returns a client with the given options in place of this one's. It
   * shares this client's connections and cached token wherever the changed
   * options allow.
   */
  withOptions(options: Partial<SandboxClientOptions>): SandboxClient {
    const clone = new SandboxClient({ ...this.#options, ...options });
    clone.#shareFrom(this);
    return clone;
  }

  /** Creates a sandbox. */
  async create(request: SandboxCreateRequest = {}): Promise<SandboxCreateResult> {
    const signal = request.callOptions?.signal;
    const sandbox = await callControlPlane(() =>
      this.#api(signal).createSandbox({
        params: { team_id: this.#options.teamId },
        request: {
          name: request.name,
          create_if_not_exists: request.createIfNotExists,
          image: request.image,
          memory: request.memory,
          region: request.region,
          envs: request.envs === undefined ? undefined : sandboxEnvsToApi(request.envs),
          labels: request.labels,
          external_id: request.externalId,
          lifecycle:
            request.lifecycle === undefined ? undefined : sandboxLifecycleToApi(request.lifecycle),
          ports: request.ports === undefined ? undefined : sandboxPortsToApi(request.ports),
          network: request.network === undefined ? undefined : sandboxNetworkToApi(request.network),
        },
      }),
    );
    const info = sandboxInfoFromApi(sandbox);
    return new SandboxCreateResult(this.#sandboxOptions(info), this.#tokens, info);
  }

  /** Gets a sandbox's current record. */
  async getInfo(request: SandboxGetInfoRequest): Promise<SandboxInfo> {
    const signal = request.callOptions?.signal;
    const sandbox = await callControlPlane(() =>
      this.#api(signal).getSandbox({
        sandbox_name: request.name,
        params: { team_id: this.#options.teamId, show_secrets: request.showSecrets },
      }),
    );
    return sandboxInfoFromApi(sandbox);
  }

  /**
   * Gets a {@link Sandbox} to work in. Fetches the sandbox's record when
   * given a name, and makes no call when given the record.
   */
  async get(request: SandboxGetRequest): Promise<Sandbox> {
    const info =
      "info" in request
        ? request.info
        : await this.getInfo({ name: request.name, callOptions: request.callOptions });
    return new Sandbox(this.#sandboxOptions(info), this.#tokens);
  }

  /** Lists sandboxes, fetching further pages as iteration reaches them. */
  async *list(request: SandboxListRequest = {}): AsyncGenerator<SandboxInfo, void, undefined> {
    const signal = request.callOptions?.signal;
    const sandboxes = paginate("sandbox list", (cursor) =>
      this.#api(signal).listSandboxes({
        params: {
          team_id: this.#options.teamId,
          cursor,
          limit: request.pageSize,
          q: request.query,
          status: request.statuses,
          external_id: request.externalId,
        },
      }),
    );
    for await (const sandbox of sandboxes) yield sandboxInfoFromApi(sandbox);
  }

  /** Updates a sandbox's configuration, returning its record after the change. */
  async update(request: SandboxUpdateRequest): Promise<SandboxInfo> {
    const signal = request.callOptions?.signal;
    const sandbox = await callControlPlane(() =>
      this.#api(signal).updateSandbox({
        sandbox_name: request.name,
        params: { team_id: this.#options.teamId },
        request: {
          enabled: request.enabled,
          lifecycle:
            request.lifecycle === undefined ? undefined : sandboxLifecycleToApi(request.lifecycle),
          region: request.region,
          envs: request.envs === undefined ? undefined : sandboxEnvsToApi(request.envs),
          image: request.image,
          ports: request.ports === undefined ? undefined : sandboxPortsToApi(request.ports),
          external_id: request.externalId,
          labels: request.labels,
        },
      }),
    );
    return sandboxInfoFromApi(sandbox);
  }

  /**
   * Deletes a sandbox. Deletion continues after this returns, so the
   * returned record usually shows it as still deleting.
   */
  async delete(request: SandboxDeleteRequest): Promise<SandboxInfo> {
    const signal = request.callOptions?.signal;
    const sandbox = await callControlPlane(() =>
      this.#api(signal).deleteSandbox({
        sandbox_name: request.name,
        params: { team_id: this.#options.teamId },
      }),
    );
    return sandboxInfoFromApi(sandbox);
  }

  #api(signal: AbortSignal | undefined): ManagementApiClient {
    if (signal === undefined) return this.#unsignaledApi;
    const fetchWithAuth = this.#fetchWithAuth;
    return this.#newApi((input, init) => fetchWithAuth(input, { ...init, signal }));
  }

  #newApi(fetchForCall: typeof fetch): ManagementApiClient {
    // An empty API key leaves Authorization to the given fetch.
    return new ManagementClient({
      apiKey: "",
      baseUrlOverride: this.#options.baseUrlOverride,
      fetch: fetchForCall,
      headers: this.#options.headers,
    }).api;
  }

  #newTokens(): TokenSource {
    return new TokenSource({
      apiKey: this.#options.apiKey,
      tokenProvider: this.#options.tokenProvider,
      managementBaseUrlOverride: this.#options.baseUrlOverride,
      fetch: this.#transport.fetch,
      headers: this.#options.headers,
    });
  }

  #authenticate(): void {
    this.#fetchWithAuth = authenticatedFetch(this.#transport.fetch, this.#tokens);
    this.#unsignaledApi = this.#newApi(this.#fetchWithAuth);
  }

  // Adopts another client's connections and cached token where this client's
  // options would produce the same ones.
  #shareFrom(other: SandboxClient): void {
    const mine = this.#options;
    const theirs = other.#options;
    if (mine.fetch === theirs.fetch && mine.nodeUndici === theirs.nodeUndici) {
      this.#transport = other.#transport;
    }
    // The token is minted through the transport and with the headers, so a
    // clone changing either mints its own.
    if (
      mine.apiKey === theirs.apiKey &&
      mine.tokenProvider === theirs.tokenProvider &&
      mine.baseUrlOverride === theirs.baseUrlOverride &&
      mine.headers === theirs.headers &&
      this.#transport === other.#transport
    ) {
      this.#tokens = other.#tokens;
    } else {
      this.#tokens = this.#newTokens();
    }
    this.#authenticate();
  }

  #sandboxOptions(info: SandboxInfo): SandboxOptions {
    if (info.url === undefined) {
      throw new Error(`sandbox ${info.name} has no URL yet`);
    }
    const tokens = this.#tokens;
    const hasAuth = this.#options.apiKey !== "" || this.#options.tokenProvider !== undefined;
    return {
      name: info.name,
      url: info.url,
      // A token source with auth always returns a token. A revoked token is
      // dropped from the client's cache before the next is fetched.
      tokenProvider: hasAuth
        ? async ({ revokedToken }) => {
            if (revokedToken !== undefined) await tokens.invalidate(revokedToken);
            return (await tokens.token(undefined, revokedToken))!;
          }
        : undefined,
      fetch: this.#transport.fetch,
      headers: this.#options.headers,
      retries: this.#options.retries,
    };
  }
}

/** @internal Runs a call to the control plane, converting its errors. */
export async function callControlPlane<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw toSandboxApiError(err, "control");
  }
}

/**
 * @internal Yields every item of a cursor-paginated control plane listing,
 * fetching each page as iteration reaches it. `what` names the listing in
 * errors.
 */
export async function* paginate<T>(
  what: string,
  fetchPage: (
    cursor: string | undefined,
  ) => Promise<{ items: T[]; pagination: { has_more: boolean; cursor?: string } }>,
): AsyncGenerator<T, void, undefined> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await callControlPlane(() => fetchPage(cursor));
    yield* page.items;
    cursor = page.pagination.has_more ? page.pagination.cursor : undefined;
    // A server repeating a cursor would otherwise page forever.
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) throw new Error(`${what} returned a repeated cursor`);
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
}
