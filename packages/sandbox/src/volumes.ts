import type {
  ApiClient as ManagementApiClient,
  SandboxVolume as ApiVolume,
  SandboxVolumeStatus as ApiVolumeStatus,
} from "@basetenlabs/client/managementapi";
import { callControlPlane, paginate } from "./client";
import type { CallOptions } from "./common";
import { optionalDate } from "./info";

/**
 * Status of a volume. Other values may be added, so do not treat this list as
 * exhaustive.
 */
export type VolumeStatus = "DEPLOYING" | "DEPLOYED" | "FAILED" | "DELETING" | (string & {});

/** A volume as last reported by the control plane. */
export interface VolumeInfo {
  /** Unique name of the volume. */
  name: string;

  /** Capacity, as a size such as `"10Gi"` or a number of megabytes. */
  size: string | number;

  /** Region of the volume. Only sandboxes in the same region can mount it. */
  region: string;
  status: VolumeStatus;

  /** Name of the sandbox the volume is mounted in, unset when not mounted. */
  attachedTo?: string;

  /**
   * Key-value pairs for organizing and filtering. Unset when not returned,
   * since {@link VolumeClient.list} omits them.
   */
  labels?: Record<string, string>;
  createdAt?: Date;
  updatedAt?: Date;

  /** Who created the volume. */
  createdBy?: string;

  /** Who last updated the volume. */
  updatedBy?: string;
}

/** Request for {@link VolumeClient.create}. */
export interface VolumeCreateRequest {
  /** Unique name of the volume. The server assigns one when unset. */
  name?: string;

  /**
   * Capacity, as a size such as `"10Gi"` or `"512Mi"`, or a number of
   * megabytes. It can grow later but never shrink.
   */
  size: string | number;

  /**
   * Region of the volume. Defaults to the default sandbox region. Only
   * sandboxes in the same region can mount it.
   */
  region?: string;

  /** Key-value pairs for organizing and filtering. */
  labels?: Record<string, string>;
  callOptions?: CallOptions;
}

/** Request for {@link VolumeClient.getInfo}. */
export interface VolumeGetInfoRequest {
  name: string;
  callOptions?: CallOptions;
}

/** Request for {@link VolumeClient.list}. */
export interface VolumeListRequest {
  /** Searches volume names. */
  query?: string;

  /** Only volumes with one of these statuses. */
  statuses?: VolumeStatus[];

  /** How many volumes to fetch per underlying request. */
  pageSize?: number;
  callOptions?: CallOptions;
}

/** Request for {@link VolumeClient.update}. Unset fields stay unchanged. */
export interface VolumeUpdateRequest {
  name: string;

  /**
   * New capacity, as a size such as `"20Gi"` or a number of megabytes, no
   * less than the current capacity.
   */
  size?: string | number;

  /** Labels replacing all current ones, including when empty. */
  labels?: Record<string, string>;
  callOptions?: CallOptions;
}

/** Request for {@link VolumeClient.delete}. */
export interface VolumeDeleteRequest {
  name: string;
  callOptions?: CallOptions;
}

/** @internal What a {@link VolumeClient} uses from the client that made it. */
export interface VolumeClientContext {
  /** The generated management client, sending the given signal on every request. */
  api(signal: AbortSignal | undefined): ManagementApiClient;
  teamId: string | undefined;
}

/**
 * Persistent volumes, which keep their data beyond the sandboxes they are
 * mounted in. Mount one when creating a sandbox with its `volumes` option.
 * Obtained from {@link SandboxClient.volumes}.
 */
export class VolumeClient {
  readonly #context: VolumeClientContext;

  /** @internal Obtained from {@link SandboxClient.volumes}. */
  constructor(context: VolumeClientContext) {
    this.#context = context;
  }

  /**
   * Creates a volume. The volume becomes ready asynchronously, so its status
   * may still be deploying.
   */
  async create(request: VolumeCreateRequest): Promise<VolumeInfo> {
    const signal = request.callOptions?.signal;
    const volume = await callControlPlane(() =>
      this.#context.api(signal).createSandboxVolume({
        params: { team_id: this.#context.teamId },
        request: {
          name: request.name,
          size: request.size,
          region: request.region,
          labels: request.labels,
        },
      }),
    );
    return volumeInfoFromApi(volume);
  }

  /** Gets a volume's current record. */
  async getInfo(request: VolumeGetInfoRequest): Promise<VolumeInfo> {
    const signal = request.callOptions?.signal;
    const volume = await callControlPlane(() =>
      this.#context.api(signal).getSandboxVolume({
        volume_name: request.name,
        params: { team_id: this.#context.teamId },
      }),
    );
    return volumeInfoFromApi(volume);
  }

  /**
   * Lists volumes, newest first, fetching further pages as iteration reaches
   * them. Records omit labels.
   */
  async *list(request: VolumeListRequest = {}): AsyncGenerator<VolumeInfo, void, undefined> {
    const signal = request.callOptions?.signal;
    const volumes = paginate("volume list", (cursor) =>
      this.#context.api(signal).listSandboxVolumes({
        params: {
          team_id: this.#context.teamId,
          cursor,
          limit: request.pageSize,
          q: request.query,
          // The generated type lists only the known statuses; others pass through.
          status: request.statuses as ApiVolumeStatus[] | undefined,
        },
      }),
    );
    for await (const volume of volumes) yield volumeInfoFromApi(volume);
  }

  /** Updates a volume, returning its new record. */
  async update(request: VolumeUpdateRequest): Promise<VolumeInfo> {
    const signal = request.callOptions?.signal;
    const volume = await callControlPlane(() =>
      this.#context.api(signal).updateSandboxVolume({
        volume_name: request.name,
        params: { team_id: this.#context.teamId },
        request: { size: request.size, labels: request.labels },
      }),
    );
    return volumeInfoFromApi(volume);
  }

  /**
   * Deletes a volume and its data. Fails while a sandbox mounts it. Deletion
   * continues after this returns, so the record usually shows the volume as
   * deleting.
   */
  async delete(request: VolumeDeleteRequest): Promise<VolumeInfo> {
    const signal = request.callOptions?.signal;
    const volume = await callControlPlane(() =>
      this.#context.api(signal).deleteSandboxVolume({
        volume_name: request.name,
        params: { team_id: this.#context.teamId },
      }),
    );
    return volumeInfoFromApi(volume);
  }
}

function volumeInfoFromApi(volume: ApiVolume): VolumeInfo {
  return {
    name: volume.name,
    size: volume.size,
    region: volume.region,
    status: volume.status,
    attachedTo: volume.attached_to,
    labels: volume.labels,
    createdAt: optionalDate(volume.created_at),
    updatedAt: optionalDate(volume.updated_at),
    createdBy: volume.created_by,
    updatedBy: volume.updated_by,
  };
}
