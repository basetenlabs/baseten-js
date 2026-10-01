import type {
  ApiClient as ManagementApiClient,
  Image as ApiImage,
  ImageTag as ApiImageTag,
} from "@basetenlabs/client/managementapi";
import { callControlPlane, paginate } from "../client";
import type { CallOptions } from "../common";
import { ImageBuildError, ImageUploadError, SandboxApiError } from "../errors";
import { optionalDate } from "../info";
import { isTransientResetError, sleep } from "../retry";
import type { ImageBuilder } from "./builder";
import { createZip, type ZipEntry, zipEntryPaths } from "./zip";

const DEFAULT_WAIT_TIMEOUT_MS = 900_000;
const DEFAULT_POLL_INTERVAL_MS = 3000;

// The largest page and offset the build log endpoint accepts, which together
// cap a range at the 11,000 most recent lines.
const LOGS_PAGE_SIZE = 1000;
const LOGS_MAX_OFFSET = 10_000;

// Statuses a poll for an image rides out, since the image may not be visible
// yet or the gateway may briefly fail.
const WAIT_RETRY_STATUSES = new Set([404, 502, 503, 504]);

/**
 * Processing status of an image. Only `BUILT` images are ready to use. Other
 * values may be added, so do not treat this list as exhaustive.
 */
export type ImageStatus = "UPLOADING" | "BUILDING" | "BUILT" | "FAILED" | (string & {});

/** An image repository as last reported by the control plane. */
export interface ImageInfo {
  /**
   * Repository name given when pushing. To create a sandbox from the image,
   * pass `<name>:latest` as its `image`, or `<name>:<tag>` for a specific
   * version.
   */
  name: string;

  status: ImageStatus;
  createdAt?: Date;
  updatedAt?: Date;

  /** Most recent time any version of the image was used by a sandbox. */
  lastDeployedAt?: Date;

  /** Total size of all versions. */
  sizeBytes?: number;

  /** Number of versions, each with its own tag. */
  tagCount?: number;
}

/** One version of an image. */
export interface ImageTagInfo {
  /** Tag name, assigned by the service. */
  name: string;
  createdAt?: Date;
  updatedAt?: Date;
  sizeBytes?: number;
}

/** Result of {@link ImageClient.cleanup}. */
export interface ImageCleanupResult {
  /** Number of image versions removed. */
  deleted: number;

  /** Human-readable description of the result. */
  message: string;
}

/** How long and how often to check while waiting for an image. */
export interface ImageWaitOptions {
  /**
   * Milliseconds to wait before giving up. Giving up does not stop the
   * image's processing. Defaults to 900s.
   */
  timeoutMs?: number;

  /** Milliseconds between checks. Defaults to 3s. */
  pollIntervalMs?: number;
}

/** Fields of {@link ImagePushRequest} for every source. */
export interface ImagePushRequestBase extends ImageWaitOptions {
  /** Repository name. Pushing to an existing name adds a new version to it. */
  name: string;

  /**
   * Whether to return only once the image is ready to use, throwing
   * {@link ImageBuildError} if it fails. Defaults to true.
   */
  wait?: boolean;
  callOptions?: CallOptions;
}

// Each variant sets the other sources to never, so TypeScript rejects a
// request with two. Those fields are hidden from the docs.
/**
 * Request for {@link ImageClient.push}, with exactly one source:
 *
 * - {@link ImagePushBuilderRequest}: an {@link ImageBuilder}'s Dockerfile and
 *   files
 * - {@link ImagePushRegistryRequest}: an image imported from a registry
 * - {@link ImagePushZipRequest}: a zip archive of a build context
 * - {@link ImagePushDirectoryRequest}: a local build context directory
 * - {@link ImagePushFilesRequest}: a build context in memory
 */
export type ImagePushRequest =
  | ImagePushBuilderRequest
  | ImagePushRegistryRequest
  | ImagePushZipRequest
  | ImagePushDirectoryRequest
  | ImagePushFilesRequest;

/** {@link ImagePushRequest} that builds an {@link ImageBuilder}'s Dockerfile and files. */
export interface ImagePushBuilderRequest extends ImagePushRequestBase {
  /** Builder whose Dockerfile and files make up the build context, which is zipped. */
  builder: ImageBuilder;

  /** @hidden */
  registryImage?: never;
  /** @hidden */
  dockerConfig?: never;
  /** @hidden */
  zip?: never;
  /** @hidden */
  directory?: never;
  /** @hidden */
  files?: never;
}

/** {@link ImagePushRequest} that imports an image from a registry. */
export interface ImagePushRegistryRequest extends ImagePushRequestBase {
  /** Registry image reference to import, including its registry host. */
  registryImage: string;

  /** Serialized registry credentials for a private image. */
  dockerConfig?: string;

  /** @hidden */
  builder?: never;
  /** @hidden */
  zip?: never;
  /** @hidden */
  directory?: never;
  /** @hidden */
  files?: never;
}

/** {@link ImagePushRequest} that builds a zip archive of a build context. */
export interface ImagePushZipRequest extends ImagePushRequestBase {
  /** Zip archive of the build context, with a `Dockerfile` at its root. */
  zip: Blob | Uint8Array;

  /** @hidden */
  builder?: never;
  /** @hidden */
  registryImage?: never;
  /** @hidden */
  dockerConfig?: never;
  /** @hidden */
  directory?: never;
  /** @hidden */
  files?: never;
}

/**
 * {@link ImagePushRequest} that builds a local build context directory. Needs
 * a runtime with Node's filesystem API.
 */
export interface ImagePushDirectoryRequest extends ImagePushRequestBase {
  /**
   * Local directory holding the build context, with a `Dockerfile` at its
   * root. Everything in it is zipped and uploaded. Files keep their
   * permissions, and a symbolic link to a file is stored as that file.
   */
  directory: string;

  /** @hidden */
  builder?: never;
  /** @hidden */
  registryImage?: never;
  /** @hidden */
  dockerConfig?: never;
  /** @hidden */
  zip?: never;
  /** @hidden */
  files?: never;
}

/** {@link ImagePushRequest} that builds a build context held in memory. */
export interface ImagePushFilesRequest extends ImagePushRequestBase {
  /**
   * Build context files by relative path, with forward slashes, which are
   * zipped. Must include `Dockerfile`. Files get mode 0644.
   */
  files: Record<string, string | Uint8Array | Blob>;

  /** @hidden */
  builder?: never;
  /** @hidden */
  registryImage?: never;
  /** @hidden */
  dockerConfig?: never;
  /** @hidden */
  zip?: never;
  /** @hidden */
  directory?: never;
}

/** Request for {@link ImageClient.getInfo}. */
export interface ImageGetInfoRequest {
  name: string;
  callOptions?: CallOptions;
}

/**
 * Sort order of an image listing. Other values may be added, so do not treat
 * this list as exhaustive.
 */
export type ImageSort =
  | "name:asc"
  | "name:desc"
  | "createdAt:asc"
  | "createdAt:desc"
  | (string & {});

/** Request for {@link ImageClient.list}. */
export interface ImageListRequest {
  /** Only images whose names start with this, case-sensitively. Sorts by name ascending. */
  namePrefix?: string;

  /** Defaults to `createdAt:desc`. */
  sort?: ImageSort;

  /** How many images to fetch per underlying request. */
  pageSize?: number;
  callOptions?: CallOptions;
}

/** Request for {@link ImageClient.delete}. */
export interface ImageDeleteRequest {
  name: string;
  callOptions?: CallOptions;
}

/**
 * Sort order of a tag listing. Other values may be added, so do not treat
 * this list as exhaustive.
 */
export type ImageTagSort = "name:asc" | "name:desc" | (string & {});

/** Request for {@link ImageClient.listTags}. */
export interface ImageListTagsRequest {
  /** Name of the image. */
  name: string;

  /** Only tags whose names start with this, case-sensitively. Sorts by name ascending. */
  namePrefix?: string;
  sort?: ImageTagSort;

  /** How many tags to fetch per underlying request. */
  pageSize?: number;
  callOptions?: CallOptions;
}

/** Request for {@link ImageClient.deleteTag}. */
export interface ImageDeleteTagRequest {
  /** Name of the image. */
  name: string;

  /** Tag to delete. */
  tag: string;
  callOptions?: CallOptions;
}

/** Request for {@link ImageClient.cleanup}. */
export interface ImageCleanupRequest {
  callOptions?: CallOptions;
}

/** Request for {@link ImageClient.waitBuilt}. */
export interface ImageWaitBuiltRequest extends ImageWaitOptions {
  name: string;
  callOptions?: CallOptions;
}

/** Request for {@link ImageClient.logs}. */
export interface ImageLogsRequest {
  /** Name of the image. */
  name: string;

  /** Start of the range, inclusive. Defaults to 24 hours before {@link endTime}. */
  startTime?: Date;

  /** End of the range. Defaults to now. The range must not exceed 7 days. */
  endTime?: Date;
  callOptions?: CallOptions;
}

/** One line of an image's build log, from {@link ImageClient.logs}. */
export interface ImageLogLine {
  timestamp: Date;

  /** Numeric OpenTelemetry severity level. */
  severity: number;
  text: string;
}

/** @internal What an {@link ImageClient} uses from the client that made it. */
export interface ImageClientContext {
  /** The generated management client, sending the given signal on every request. */
  api(signal: AbortSignal | undefined): ManagementApiClient;
  teamId: string | undefined;

  /** Sends a request without authentication, as storage uploads need. */
  fetch: typeof fetch;
}

/**
 * Images that sandboxes are created from: pushing them from a build context
 * or a registry, and finding and deleting them. Obtained from
 * {@link SandboxClient.images}.
 */
export class ImageClient {
  readonly #context: ImageClientContext;

  /** @internal Obtained from {@link SandboxClient.images}. */
  constructor(context: ImageClientContext) {
    this.#context = context;
  }

  /**
   * Pushes an image, from a registry or from a build context that is built
   * into one. Waits for the image to be ready to use unless `wait` is false.
   * To create a sandbox from it, pass `<name>:latest` as the sandbox's
   * `image`.
   *
   * A build context is uploaded in one attempt. If the upload fails, the
   * image is left as the service has it, so push again or delete it.
   */
  async push(request: ImagePushRequest): Promise<ImageInfo> {
    const signal = request.callOptions?.signal;
    // Zipped before anything is sent, so a bad source leaves nothing behind.
    const zip = await pushSourceZip(request);
    const response = await callControlPlane(() =>
      this.#context.api(signal).pushImage({
        params: { team_id: this.#context.teamId },
        request: {
          name: request.name,
          image: request.registryImage,
          docker_config: request.dockerConfig,
        },
      }),
    );
    if (zip !== undefined) {
      if (response.upload_url === undefined) {
        throw new Error(`pushing image ${request.name} returned no upload URL`);
      }
      await this.#upload(request.name, response.upload_url, zip, signal);
    }
    if (request.wait === false) return { name: response.name, status: response.status };
    return this.#waitBuilt(request.name, request, signal, true);
  }

  /**
   * Waits for an image to be ready to use, throwing {@link ImageBuildError}
   * if it fails or the wait times out. Checks the image's current status, so
   * right after pushing a new version of an image that was already built,
   * this may return before the new version is processed; push with `wait`
   * left on to avoid that.
   */
  async waitBuilt(request: ImageWaitBuiltRequest): Promise<ImageInfo> {
    return this.#waitBuilt(request.name, request, request.callOptions?.signal, false);
  }

  /**
   * Gets the build log of an image's latest build, including a failed one,
   * oldest line first. Logs may take a short time to appear. Returns at most
   * the 11,000 most recent lines in the range; narrow the range to see
   * earlier ones.
   */
  async logs(request: ImageLogsRequest): Promise<ImageLogLine[]> {
    const signal = request.callOptions?.signal;
    // Pinned on the first page, so the default range does not move while
    // paging through it.
    const endTime = (request.endTime ?? new Date()).toISOString();
    const lines: ImageLogLine[] = [];
    for (let offset = 0; offset <= LOGS_MAX_OFFSET; offset += LOGS_PAGE_SIZE) {
      const page = await callControlPlane(() =>
        this.#context.api(signal).getImageBuildLogs({
          image_name: request.name,
          params: {
            team_id: this.#context.teamId,
            start_time: request.startTime?.toISOString(),
            end_time: endTime,
            limit: LOGS_PAGE_SIZE,
            offset,
          },
        }),
      );
      for (const log of page.logs) {
        lines.push({
          timestamp: new Date(log.timestamp),
          severity: log.severity,
          text: log.message,
        });
      }
      if (page.logs.length < LOGS_PAGE_SIZE || offset + LOGS_PAGE_SIZE >= page.total_count) break;
    }
    // Pages come newest first.
    return lines.reverse();
  }

  /** Gets an image's current record. */
  async getInfo(request: ImageGetInfoRequest): Promise<ImageInfo> {
    const signal = request.callOptions?.signal;
    const image = await callControlPlane(() =>
      this.#context.api(signal).getImage({
        image_name: request.name,
        params: { team_id: this.#context.teamId },
      }),
    );
    return imageInfoFromApi(image);
  }

  /** Lists images, fetching further pages as iteration reaches them. */
  async *list(request: ImageListRequest = {}): AsyncGenerator<ImageInfo, void, undefined> {
    const signal = request.callOptions?.signal;
    const images = paginate("image list", (cursor) =>
      this.#context.api(signal).listImages({
        params: {
          team_id: this.#context.teamId,
          cursor,
          limit: request.pageSize,
          sort: request.sort,
          q: request.namePrefix,
        },
      }),
    );
    for await (const image of images) yield imageInfoFromApi(image);
  }

  /**
   * Deletes an image and all its versions. Fails while a sandbox uses any
   * version.
   */
  async delete(request: ImageDeleteRequest): Promise<ImageInfo> {
    const signal = request.callOptions?.signal;
    const image = await callControlPlane(() =>
      this.#context.api(signal).deleteImage({
        image_name: request.name,
        params: { team_id: this.#context.teamId },
      }),
    );
    return imageInfoFromApi(image);
  }

  /** Lists an image's versions, fetching further pages as iteration reaches them. */
  async *listTags(request: ImageListTagsRequest): AsyncGenerator<ImageTagInfo, void, undefined> {
    const signal = request.callOptions?.signal;
    const tags = paginate("image tag list", (cursor) =>
      this.#context.api(signal).listImageTags({
        image_name: request.name,
        params: {
          team_id: this.#context.teamId,
          cursor,
          limit: request.pageSize,
          sort: request.sort,
          q: request.namePrefix,
        },
      }),
    );
    for await (const tag of tags) yield imageTagInfoFromApi(tag);
  }

  /**
   * Deletes one version of an image. Fails while a sandbox uses it. Returns
   * the image as it is afterwards.
   */
  async deleteTag(request: ImageDeleteTagRequest): Promise<ImageInfo> {
    const signal = request.callOptions?.signal;
    const image = await callControlPlane(() =>
      this.#context.api(signal).deleteImageTag({
        image_name: request.name,
        tag_name: request.tag,
        params: { team_id: this.#context.teamId },
      }),
    );
    return imageInfoFromApi(image);
  }

  /** Removes image versions that no sandbox uses. */
  async cleanup(request: ImageCleanupRequest = {}): Promise<ImageCleanupResult> {
    const signal = request.callOptions?.signal;
    const result = await callControlPlane(() =>
      this.#context.api(signal).cleanupImages({ params: { team_id: this.#context.teamId } }),
    );
    return { deleted: result.deleted, message: result.message };
  }

  async #upload(name: string, url: string, zip: Blob, signal: AbortSignal | undefined) {
    // The URL is signed for storage, so none of the API's headers or
    // credentials go with it.
    const response = await this.#context.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/zip" },
      body: zip,
      signal,
    });
    const body = await response.text();
    if (!response.ok) throw new ImageUploadError(name, response.status, body);
  }

  // With requireProgress, BUILT and FAILED count only once the image has been
  // seen processing, since the status is per repository and can still show
  // the previous version's outcome right after a push.
  async #waitBuilt(
    name: string,
    options: ImageWaitOptions,
    signal: AbortSignal | undefined,
    requireProgress: boolean,
  ): Promise<ImageInfo> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    const waitSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let progressed = !requireProgress;
    let lastStatus = "unknown";
    try {
      for (;;) {
        try {
          const image = await callControlPlane(() =>
            this.#context.api(waitSignal).getImage({
              image_name: name,
              params: { team_id: this.#context.teamId },
            }),
          );
          lastStatus = image.status;
          if (image.status === "BUILT" || image.status === "FAILED") {
            if (progressed) {
              if (image.status === "FAILED") throw new ImageBuildError(name, image.status, false);
              return imageInfoFromApi(image);
            }
          } else {
            // UPLOADING, BUILDING, or a status added later, all still processing.
            progressed = true;
          }
        } catch (err) {
          if (err instanceof ImageBuildError || waitSignal.aborted || !isRetryableWaitError(err)) {
            throw err;
          }
        }
        await sleep(intervalMs, waitSignal);
      }
    } catch (err) {
      if (err instanceof ImageBuildError || !timeout.aborted || signal?.aborted) throw err;
      throw new ImageBuildError(name, lastStatus, true, { cause: err });
    }
  }
}

function isRetryableWaitError(err: unknown): boolean {
  if (err instanceof SandboxApiError) return WAIT_RETRY_STATUSES.has(err.status);
  return isTransientResetError(err);
}

/** Checks that a push has exactly one source, and zips it unless it is a registry image. */
async function pushSourceZip(request: ImagePushRequest): Promise<Blob | undefined> {
  const sources = (["builder", "registryImage", "zip", "directory", "files"] as const).filter(
    (key) => request[key] !== undefined,
  );
  if (sources.length !== 1) {
    throw new TypeError(
      `an image push needs exactly one of builder, registryImage, zip, directory, or files, got ${sources.length === 0 ? "none" : sources.join(", ")}`,
    );
  }
  if (request.dockerConfig !== undefined && request.registryImage === undefined) {
    throw new TypeError("dockerConfig applies only to registryImage");
  }
  if (request.builder !== undefined) return createZip(await request.builder.zipEntries());
  if (request.zip !== undefined) {
    const zip = request.zip instanceof Blob ? request.zip : new Blob([request.zip as BlobPart]);
    if (!(await zipEntryPaths(zip)).includes("Dockerfile")) {
      throw new Error("the zip has no Dockerfile at its root");
    }
    return zip;
  }
  if (request.directory !== undefined)
    return createZip(await directoryZipEntries(request.directory));
  if (request.files !== undefined) return createZip(await filesZipEntries(request.files));
  return undefined;
}

async function filesZipEntries(
  files: Record<string, string | Uint8Array | Blob>,
): Promise<ZipEntry[]> {
  if (files.Dockerfile === undefined) throw new Error("files has no Dockerfile");
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  for (const [path, content] of Object.entries(files).sort(([a], [b]) => compareNames(a, b))) {
    const segments = path.split("/");
    if (path.includes("\\") || segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new Error(
        `files path ${JSON.stringify(path)} must be relative, with forward slashes and no empty, . or .. segments`,
      );
    }
    const data =
      typeof content === "string"
        ? encoder.encode(content)
        : content instanceof Blob
          ? new Uint8Array(await content.arrayBuffer())
          : content;
    entries.push({ path, data, mode: 0o644 });
  }
  return entries;
}

// Only what is used here, since Node's types may not be installed.
/** @internal */
export interface NodeFsPromises {
  readdir(path: string, options: { withFileTypes: true }): Promise<NodeDirent[]>;
  stat(path: string): Promise<{ mode: number; isFile(): boolean; isDirectory(): boolean }>;
  readFile(path: string): Promise<Uint8Array>;
}

interface NodeDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** @internal */
export interface NodePath {
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
  basename(path: string): string;
}

/** @internal Node's filesystem and path modules, or undefined on a runtime without them. */
export function nodeFileSystem(): { fs: NodeFsPromises; path: NodePath } | undefined {
  // Reached through getBuiltinModule so that nothing imports node:fs, which
  // would break bundling for other runtimes.
  const getBuiltinModule =
    typeof process === "undefined" ? undefined : process.getBuiltinModule?.bind(process);
  const fs = getBuiltinModule?.("node:fs/promises") as NodeFsPromises | undefined;
  const path = getBuiltinModule?.("node:path") as NodePath | undefined;
  return fs === undefined || path === undefined ? undefined : { fs, path };
}

/**
 * @internal Adds everything under a local directory to entries, each path
 * prefixed. Files keep their modes, a link to a file stores the file, a link
 * to a directory stores an empty directory, and a broken link is left out.
 */
export async function addDirectoryZipEntries(
  node: { fs: NodeFsPromises; path: NodePath },
  dir: string,
  prefix: string,
  entries: ZipEntry[],
): Promise<void> {
  const { fs, path } = node;
  const children = await fs.readdir(dir, { withFileTypes: true });
  children.sort((a, b) => compareNames(a.name, b.name));
  for (const child of children) {
    const fullPath = path.join(dir, child.name);
    const archivePath = prefix + child.name;
    if (child.isDirectory()) {
      entries.push({ path: archivePath, mode: (await fs.stat(fullPath)).mode });
      await addDirectoryZipEntries(node, fullPath, `${archivePath}/`, entries);
    } else if (child.isFile()) {
      const { mode } = await fs.stat(fullPath);
      entries.push({ path: archivePath, data: await fs.readFile(fullPath), mode });
    } else if (child.isSymbolicLink()) {
      const target = await fs.stat(fullPath).catch(() => undefined);
      if (target?.isFile()) {
        entries.push({ path: archivePath, data: await fs.readFile(fullPath), mode: target.mode });
      } else if (target?.isDirectory()) {
        entries.push({ path: archivePath, mode: target.mode });
      }
    }
    // Anything else, such as a socket, has no content to archive.
  }
}

async function directoryZipEntries(root: string): Promise<ZipEntry[]> {
  const node = nodeFileSystem();
  if (node === undefined) {
    throw new Error(
      "a directory source needs a runtime with Node's filesystem API; pass files or zip instead",
    );
  }
  // Checked before reading anything, so a mistaken directory, such as a home
  // directory, fails fast instead of being read in full.
  const dockerfile = await node.fs.stat(node.path.join(root, "Dockerfile")).catch(() => undefined);
  if (dockerfile === undefined || !dockerfile.isFile()) {
    throw new Error(`directory ${root} has no Dockerfile at its root`);
  }
  const entries: ZipEntry[] = [];
  await addDirectoryZipEntries(node, root, "", entries);
  return entries;
}

// By code unit rather than locale, so the same files always zip the same way.
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function imageInfoFromApi(image: ApiImage): ImageInfo {
  return {
    name: image.name,
    status: image.status,
    createdAt: optionalDate(image.created_at),
    updatedAt: optionalDate(image.updated_at),
    lastDeployedAt: optionalDate(image.last_deployed_at),
    sizeBytes: image.size,
    tagCount: image.tag_count,
  };
}

function imageTagInfoFromApi(tag: ApiImageTag): ImageTagInfo {
  return {
    name: tag.name,
    createdAt: optionalDate(tag.created_at),
    updatedAt: optionalDate(tag.updated_at),
    sizeBytes: tag.size,
  };
}
