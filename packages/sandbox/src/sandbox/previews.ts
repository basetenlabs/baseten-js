import type {
  ApiClient as ManagementApiClient,
  SandboxPreview as ApiSandboxPreview,
  SandboxPreviewToken as ApiSandboxPreviewToken,
} from "@basetenlabs/client/managementapi";
import { callControlPlane, paginate } from "../client";
import { type CallOptions, formatDuration, parseDuration } from "../common";
import { optionalDate } from "../info";

/**
 * Deployment status of a preview. Other values may be added, so do not treat
 * this list as exhaustive.
 */
export type SandboxPreviewStatus =
  | "DEPLOYING"
  | "DEPLOYED"
  | "FAILED"
  | "DELETING"
  | "TERMINATED"
  | (string & {});

/** A preview as last reported by the control plane. */
export interface SandboxPreviewInfo {
  /** Name of the preview, unique within the sandbox. */
  name: string;

  /** Sandbox port the preview exposes. */
  port: number;

  /**
   * HTTPS URL serving the port. Requests to a private preview need a token
   * from {@link SandboxPreviews.createToken}.
   */
  url: string;

  status: SandboxPreviewStatus;

  /** Whether the URL is reachable without a token. */
  public: boolean;

  /** Headers added to every response the preview serves. */
  responseHeaders: Record<string, string>;

  /**
   * Headers added to every request forwarded to the sandbox. Values come back
   * as `"****"` unless read with {@link SandboxPreviewGetInfoRequest.showSecrets}.
   */
  requestHeaders: Record<string, string>;

  /**
   * Lifetime in milliseconds set by the last create or update that had one,
   * counted from that request. `expiresAt` is when the preview is deleted.
   */
  ttlMs?: number;

  /** When the preview is deleted, when it expires. */
  expiresAt?: Date;

  /** Region serving the preview, the sandbox's region. */
  region?: string;

  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string;
  updatedBy?: string;
}

/** An access token for a private preview. */
export interface SandboxPreviewTokenInfo {
  /** Name of the token. */
  name: string;

  /**
   * Value granting access. Append it to the preview URL as
   * `?preview_token=<token>`; the first request sets a cookie so a browser
   * can keep navigating without it.
   */
  token: string;

  /** When the token stops working. */
  expiresAt: Date;

  /** Whether `expiresAt` has passed. */
  expired: boolean;
}

/** Request for {@link SandboxPreviews.create}. */
export interface SandboxPreviewCreateRequest {
  /** Sandbox port to expose. */
  port: number;

  /** Name of the preview, unique within the sandbox. The server generates one when unset. */
  name?: string;

  /** Returns the existing preview with this name, unchanged, instead of failing. */
  createIfNotExists?: boolean;

  /** Makes the URL reachable without a token. Defaults to false, a private preview. */
  public?: boolean;

  /** Headers added to every response the preview serves, such as CORS headers. */
  responseHeaders?: Record<string, string>;

  /**
   * Headers added to every request forwarded to the sandbox, such as an
   * Authorization header the application expects.
   */
  requestHeaders?: Record<string, string>;

  /** Deletes the preview this many milliseconds after the request. Cannot be combined with `expiresAt`. */
  ttlMs?: number;

  /** Deletes the preview at this time. Cannot be combined with `ttlMs`. */
  expiresAt?: Date;

  callOptions?: CallOptions;
}

/** Request for {@link SandboxPreviews.getInfo}. */
export interface SandboxPreviewGetInfoRequest {
  name: string;

  /**
   * Returns request header values unmasked. Requires the workspace admin
   * role; other callers still get masked values.
   */
  showSecrets?: boolean;

  callOptions?: CallOptions;
}

/** Request for {@link SandboxPreviews.list}. */
export interface SandboxPreviewListRequest {
  /** How many previews to fetch per underlying request. */
  pageSize?: number;
  callOptions?: CallOptions;
}

/**
 * Request for {@link SandboxPreviews.update}. Unset fields stay unchanged.
 * The name and port cannot be changed.
 */
export interface SandboxPreviewUpdateRequest {
  name: string;

  /** Sets whether the URL is reachable without a token. Unset leaves it unchanged. */
  public?: boolean;

  /**
   * Replaces the headers added to every response. Unset leaves them
   * unchanged. A set object replaces the whole set, so headers left out are
   * removed, and an empty object removes them all.
   */
  responseHeaders?: Record<string, string>;

  /**
   * Replaces the headers added to every forwarded request. Unset leaves them
   * unchanged. A set object replaces the whole set, so headers left out are
   * removed, and an empty object removes them all. Sending back a `"****"`
   * value from {@link SandboxPreviewInfo.requestHeaders} is rejected, so to
   * change one header, get the others with
   * {@link SandboxPreviewGetInfoRequest.showSecrets} and send them all.
   */
  requestHeaders?: Record<string, string>;

  /**
   * Deletes the preview this many milliseconds after the request, replacing
   * any previous expiration. Unset leaves the expiration unchanged. Cannot be
   * combined with `expiresAt`.
   */
  ttlMs?: number;

  /**
   * Deletes the preview at this time, replacing any previous expiration.
   * Unset leaves the expiration unchanged. Cannot be combined with `ttlMs`.
   */
  expiresAt?: Date;

  callOptions?: CallOptions;
}

/** Request for {@link SandboxPreviews.delete}. */
export interface SandboxPreviewDeleteRequest {
  name: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxPreviews.createToken}. */
export interface SandboxPreviewCreateTokenRequest {
  /** Name of the private preview. */
  previewName: string;

  /** When the token stops working. */
  expiresAt: Date;

  /**
   * Returns an existing unexpired token of the preview that stays valid at
   * least until `expiresAt`, instead of creating one.
   */
  createIfNotExists?: boolean;

  callOptions?: CallOptions;
}

/** Request for {@link SandboxPreviews.listTokens}. */
export interface SandboxPreviewListTokensRequest {
  /** Name of the private preview. */
  previewName: string;

  /** How many tokens to fetch per underlying request. */
  pageSize?: number;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxPreviews.deleteToken}. */
export interface SandboxPreviewDeleteTokenRequest {
  /** Name of the private preview. */
  previewName: string;

  /** Name of the token. */
  tokenName: string;
  callOptions?: CallOptions;
}

/** @internal What {@link SandboxPreviews} uses from the client that made its sandbox. */
export interface SandboxPreviewsContext {
  /** Name of the sandbox, empty for one from {@link SandboxClient.sandboxFromUrl}. */
  sandboxName: string;

  /** The generated management client, sending the given signal on every request. */
  api(signal: AbortSignal | undefined): ManagementApiClient;
  teamId: string | undefined;
}

/**
 * A sandbox's previews, which expose its ports on HTTPS URLs. Obtained from
 * {@link Sandbox.previews}. Previews need the sandbox's name, so every call
 * fails on a sandbox from {@link SandboxClient.sandboxFromUrl}.
 */
export class SandboxPreviews {
  readonly #context: SandboxPreviewsContext;

  /** @internal Obtained from {@link Sandbox.previews}. */
  constructor(context: SandboxPreviewsContext) {
    this.#context = context;
  }

  /** Creates a preview exposing a sandbox port. */
  async create(request: SandboxPreviewCreateRequest): Promise<SandboxPreviewInfo> {
    const sandboxName = this.#sandboxName();
    const preview = await callControlPlane(() =>
      this.#context.api(request.callOptions?.signal).createSandboxPreview({
        sandbox_name: sandboxName,
        params: { team_id: this.#context.teamId },
        request: {
          port: request.port,
          name: request.name,
          create_if_not_exists: request.createIfNotExists,
          public: request.public,
          response_headers: request.responseHeaders,
          request_headers: request.requestHeaders,
          ttl: request.ttlMs === undefined ? undefined : formatDuration(request.ttlMs),
          expires_at: request.expiresAt?.toISOString(),
        },
      }),
    );
    return previewInfoFromApi(preview);
  }

  /** Gets a preview's current record. */
  async getInfo(request: SandboxPreviewGetInfoRequest): Promise<SandboxPreviewInfo> {
    const sandboxName = this.#sandboxName();
    const preview = await callControlPlane(() =>
      this.#context.api(request.callOptions?.signal).getSandboxPreview({
        sandbox_name: sandboxName,
        preview_name: request.name,
        params: { team_id: this.#context.teamId, show_secrets: request.showSecrets },
      }),
    );
    return previewInfoFromApi(preview);
  }

  /** Lists the sandbox's previews, fetching further pages as iteration reaches them. */
  async *list(
    request: SandboxPreviewListRequest = {},
  ): AsyncGenerator<SandboxPreviewInfo, void, undefined> {
    const sandboxName = this.#sandboxName();
    const previews = paginate("preview list", (cursor) =>
      this.#context.api(request.callOptions?.signal).listSandboxPreviews({
        sandbox_name: sandboxName,
        params: { team_id: this.#context.teamId, cursor, limit: request.pageSize },
      }),
    );
    for await (const preview of previews) yield previewInfoFromApi(preview);
  }

  /** Updates a preview, returning its record after the change. The URL does not change. */
  async update(request: SandboxPreviewUpdateRequest): Promise<SandboxPreviewInfo> {
    const sandboxName = this.#sandboxName();
    const preview = await callControlPlane(() =>
      this.#context.api(request.callOptions?.signal).updateSandboxPreview({
        sandbox_name: sandboxName,
        preview_name: request.name,
        params: { team_id: this.#context.teamId },
        request: {
          public: request.public,
          response_headers: request.responseHeaders,
          request_headers: request.requestHeaders,
          ttl: request.ttlMs === undefined ? undefined : formatDuration(request.ttlMs),
          expires_at: request.expiresAt?.toISOString(),
        },
      }),
    );
    return previewInfoFromApi(preview);
  }

  /**
   * Deletes a preview and its tokens, returning its record. The URL stops
   * serving at once, but the record may show the preview as deleting while
   * the server finishes; this does not wait for that.
   */
  async delete(request: SandboxPreviewDeleteRequest): Promise<SandboxPreviewInfo> {
    const sandboxName = this.#sandboxName();
    const preview = await callControlPlane(() =>
      this.#context.api(request.callOptions?.signal).deleteSandboxPreview({
        sandbox_name: sandboxName,
        preview_name: request.name,
        params: { team_id: this.#context.teamId },
      }),
    );
    return previewInfoFromApi(preview);
  }

  /** Creates a token granting access to a private preview. */
  async createToken(request: SandboxPreviewCreateTokenRequest): Promise<SandboxPreviewTokenInfo> {
    const sandboxName = this.#sandboxName();
    const token = await callControlPlane(() =>
      this.#context.api(request.callOptions?.signal).createSandboxPreviewToken({
        sandbox_name: sandboxName,
        preview_name: request.previewName,
        params: { team_id: this.#context.teamId },
        request: {
          expires_at: request.expiresAt.toISOString(),
          create_if_not_exists: request.createIfNotExists,
        },
      }),
    );
    return previewTokenInfoFromApi(token);
  }

  /**
   * Lists a private preview's tokens, including expired ones until the server
   * removes them, fetching further pages as iteration reaches them. A public
   * preview has no tokens, and the server rejects the call.
   */
  async *listTokens(
    request: SandboxPreviewListTokensRequest,
  ): AsyncGenerator<SandboxPreviewTokenInfo, void, undefined> {
    const sandboxName = this.#sandboxName();
    const tokens = paginate("preview token list", (cursor) =>
      this.#context.api(request.callOptions?.signal).listSandboxPreviewTokens({
        sandbox_name: sandboxName,
        preview_name: request.previewName,
        params: { team_id: this.#context.teamId, cursor, limit: request.pageSize },
      }),
    );
    for await (const token of tokens) yield previewTokenInfoFromApi(token);
  }

  /** Revokes a preview token. Requests using it are rejected at once. */
  async deleteToken(request: SandboxPreviewDeleteTokenRequest): Promise<void> {
    const sandboxName = this.#sandboxName();
    await callControlPlane(() =>
      this.#context.api(request.callOptions?.signal).deleteSandboxPreviewToken({
        sandbox_name: sandboxName,
        preview_name: request.previewName,
        token_name: request.tokenName,
        params: { team_id: this.#context.teamId },
      }),
    );
  }

  #sandboxName(): string {
    if (this.#context.sandboxName === "") {
      throw new Error(
        "previews need the sandbox's name, which a sandbox from sandboxFromUrl does not have; use SandboxClient.get",
      );
    }
    return this.#context.sandboxName;
  }
}

function previewInfoFromApi(preview: ApiSandboxPreview): SandboxPreviewInfo {
  return {
    name: preview.name,
    port: preview.port,
    url: preview.url,
    status: preview.status,
    public: preview.public ?? false,
    responseHeaders: { ...preview.response_headers },
    requestHeaders: { ...preview.request_headers },
    ttlMs:
      preview.ttl === undefined || preview.ttl === ""
        ? undefined
        : parseDuration(preview.ttl, "preview TTL"),
    expiresAt: optionalDate(preview.expires_at),
    region: preview.region,
    createdAt: optionalDate(preview.created_at),
    updatedAt: optionalDate(preview.updated_at),
    createdBy: preview.created_by,
    updatedBy: preview.updated_by,
  };
}

function previewTokenInfoFromApi(token: ApiSandboxPreviewToken): SandboxPreviewTokenInfo {
  return {
    name: token.name,
    token: token.token,
    expiresAt: new Date(token.expires_at),
    expired: token.expired,
  };
}
