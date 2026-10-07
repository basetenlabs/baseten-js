import type {
  ApiClient as ManagementApiClient,
  SandboxImage as ApiImage,
  SandboxImageSummary as ApiImageSummary,
  SandboxImageTag as ApiImageTag,
  SandboxLibraryImage as ApiLibraryImage,
} from "@basetenlabs/client/managementapi";
import { callControlPlane, paginate } from "../client";
import type { CallOptions } from "../common";
import { ImageBuildError, ImageUploadError, SandboxApiError } from "../errors";
import { optionalDate, type SandboxPort, sandboxPortsFromApi } from "../info";
import { isTransientResetError, sleep } from "../retry";
import type { ImageBuilder } from "./builder";
import {
  DOCKERIGNORE_FILE_NAME,
  type ImageIgnoreFileFunc,
  type ImageIgnoreFileProcessor,
  resolveImageIgnoreFile,
} from "./ignore";
import { createZip, writeZip, type ZipEntry, zipEntryInfos } from "./zip";

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

/**
 * A built-in image available to every team, usable as a sandbox's image
 * without building or pushing it. From {@link ImageClient.listLibrary}.
 */
export interface ImageLibraryInfo {
  /** Stable identifier of the image. */
  name: string;

  /** Human-readable name. */
  displayName?: string;

  /** Short description. */
  description?: string;

  /** Detailed description. */
  longDescription?: string;

  /** Image reference including its tag, to pass as {@link SandboxCreateRequest.image}. */
  image: string;

  /** Recommended memory allocation in megabytes. */
  memory?: number;

  /** Ports the image exposes. */
  ports: SandboxPort[];
  categories: string[];
  tags: string[];

  /** Documentation URL. */
  url?: string;

  /** Icon URL. */
  icon?: string;

  /** Light-mode icon URL. */
  iconLight?: string;

  /** Dark-mode icon URL. */
  iconDark?: string;

  /** Whether the image requires an enterprise plan. */
  enterprise: boolean;

  /**
   * Kernel selection arguments suggested when creating a sandbox from this
   * image. Creating a sandbox cannot pass these yet.
   */
  creationExtraArgs?: Record<string, string>;

  /**
   * Volume attachments suggested when creating a sandbox from this image.
   * Creating a sandbox cannot pass these yet.
   */
  creationVolumes: ImageLibraryVolume[];
}

/** A volume attachment a built-in image suggests, in {@link ImageLibraryInfo}. */
export interface ImageLibraryVolume {
  /** Volume name, or an internal identifier for an ephemeral volume. */
  name: string;

  /** Absolute path the volume is mounted at. */
  mountPath: string;

  /** Volume type, persistent when empty or unset. */
  type?: string;

  /** Storage capacity in megabytes of an ephemeral volume. */
  sizeMb?: number;

  /** Whether the volume is mounted read-only. */
  readOnly: boolean;
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

  /**
   * Whether to zip into a temporary file, removed once uploaded, when the
   * builder has local files or directories. Without them, the build context
   * is always zipped in memory. Defaults to true. Needs Node's
   * `fs.openAsBlob`.
   */
  tempFile?: boolean;

  /** @hidden */
  registryImage?: never;
  /** @hidden */
  dockerConfig?: never;
  /** @hidden */
  zip?: never;
  /** @hidden */
  directory?: never;
  /** @hidden */
  ignoreFileProcessor?: never;
  /** @hidden */
  defaultIgnoreFile?: never;
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
  tempFile?: never;
  /** @hidden */
  zip?: never;
  /** @hidden */
  directory?: never;
  /** @hidden */
  ignoreFileProcessor?: never;
  /** @hidden */
  defaultIgnoreFile?: never;
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
  tempFile?: never;
  /** @hidden */
  registryImage?: never;
  /** @hidden */
  dockerConfig?: never;
  /** @hidden */
  directory?: never;
  /** @hidden */
  ignoreFileProcessor?: never;
  /** @hidden */
  defaultIgnoreFile?: never;
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
   * root, which is zipped. Files keep their permissions, a link to a file
   * within the directory stores a copy of the file, a link to a file outside
   * it fails the push, a link to a directory stores an empty directory, and a
   * broken link is left out.
   *
   * Paths are left out as a `.dockerignore` at the directory's root says,
   * read through {@link ignoreFileProcessor}, or else by
   * {@link defaultIgnoreFile}. The root `Dockerfile` and `.dockerignore` are
   * always kept, as Docker keeps them.
   */
  directory: string;

  /**
   * Parses the `.dockerignore` at the root of {@link directory}. Required if
   * there is one; otherwise the push fails before anything is sent. This
   * package has no `.dockerignore` parser of its own.
   */
  ignoreFileProcessor?: ImageIgnoreFileProcessor;

  /**
   * Filters {@link directory} when it has no `.dockerignore`. Defaults to
   * {@link defaultImageIgnoreFile}. Pass `() => false` to push everything.
   */
  defaultIgnoreFile?: ImageIgnoreFileFunc;

  /**
   * Whether to zip into a temporary file, removed once uploaded, instead of
   * in memory. Defaults to true. Needs Node's `fs.openAsBlob`.
   */
  tempFile?: boolean;

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
  tempFile?: never;
  /** @hidden */
  registryImage?: never;
  /** @hidden */
  dockerConfig?: never;
  /** @hidden */
  zip?: never;
  /** @hidden */
  directory?: never;
  /** @hidden */
  ignoreFileProcessor?: never;
  /** @hidden */
  defaultIgnoreFile?: never;
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
  /** Only images whose names start with this, case-sensitively. */
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

/** Request for {@link ImageClient.listLibrary}. */
export interface ImageListLibraryRequest {
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
   * A build context read from local files, from `directory` or a builder's
   * local files and directories, is zipped into a temporary file, removed
   * once uploaded, unless `tempFile` is false; any other is zipped in memory.
   * It is uploaded in one attempt. If the upload fails, the image is left as
   * the service has it, so push again or delete it.
   */
  async push(request: ImagePushRequest): Promise<ImageInfo> {
    const signal = request.callOptions?.signal;
    // Zipped before anything is sent, so a bad source leaves nothing behind.
    const archive = await pushSourceArchive(request, signal);
    let response;
    try {
      response = await callControlPlane(() =>
        this.#context.api(signal).pushImage({
          params: { team_id: this.#context.teamId },
          request: {
            name: request.name,
            image: request.registryImage,
            docker_config: request.dockerConfig,
          },
        }),
      );
      if (archive !== undefined) {
        if (response.upload_url === undefined) {
          throw new Error(`pushing image ${request.name} returned no upload URL`);
        }
        await this.#upload(request.name, response.upload_url, archive.zip, signal);
      }
    } finally {
      await archive?.remove?.();
    }
    if (request.wait === false) return { name: response.name, status: response.status };
    return this.#waitBuilt(request.name, request, signal);
  }

  /**
   * Waits for an image to be ready to use, throwing {@link ImageBuildError}
   * if it fails or the wait times out. Checks the image's current status, so
   * right after pushing a new version of an image that was already built,
   * this may return before the new version is processed; push with `wait`
   * left on to avoid that.
   */
  async waitBuilt(request: ImageWaitBuiltRequest): Promise<ImageInfo> {
    return this.#waitBuilt(request.name, request, request.callOptions?.signal);
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

  /** Lists the built-in images available to every team. */
  async listLibrary(request: ImageListLibraryRequest = {}): Promise<ImageLibraryInfo[]> {
    const signal = request.callOptions?.signal;
    const result = await callControlPlane(() =>
      this.#context.api(signal).listSandboxLibraryImages(),
    );
    return result.items.map(imageLibraryInfoFromApi);
  }

  async #upload(name: string, url: string, zip: Blob, signal: AbortSignal | undefined) {
    // The URL is signed for storage, so none of the API's headers or
    // credentials go with it. A Blob, in memory or backed by a file, has a
    // known size, so fetch sends the Content-Length storage requires.
    const response = await this.#context.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/zip" },
      body: zip,
      signal,
    });
    const body = await response.text();
    if (!response.ok) throw new ImageUploadError(name, response.status, body);
  }

  // A push resets the image's status, so after one, BUILT or FAILED is that
  // push's outcome.
  async #waitBuilt(
    name: string,
    options: ImageWaitOptions,
    signal: AbortSignal | undefined,
  ): Promise<ImageInfo> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    const waitSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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
          if (image.status === "FAILED") throw new ImageBuildError(name, image.status, false);
          if (image.status === "BUILT") return imageInfoFromApi(image);
          // UPLOADING, BUILDING, or a status added later, all still processing.
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

/** A zipped build context, and how to remove its temporary file if it has one. */
interface PushArchive {
  zip: Blob;
  remove?: () => Promise<void>;
}

/** Checks that a push has exactly one source, and zips it unless it is a registry image. */
async function pushSourceArchive(
  request: ImagePushRequest,
  signal: AbortSignal | undefined,
): Promise<PushArchive | undefined> {
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
  if (
    (request.ignoreFileProcessor !== undefined || request.defaultIgnoreFile !== undefined) &&
    request.directory === undefined
  ) {
    throw new TypeError("ignoreFileProcessor and defaultIgnoreFile apply only to directory");
  }
  if (
    request.tempFile !== undefined &&
    request.directory === undefined &&
    request.builder === undefined
  ) {
    throw new TypeError("tempFile applies only to directory and builder");
  }
  const tempFile = request.tempFile ?? true;
  if (request.builder !== undefined) {
    const entries = await request.builder.zipEntries(signal);
    // Only local files are read while zipping, so only they can make a build
    // context too large for memory.
    const local = entries.some((entry) => entry.read !== undefined);
    return zipPushArchive(entries, tempFile && local, signal);
  }
  if (request.zip !== undefined) {
    const zip = request.zip instanceof Blob ? request.zip : new Blob([request.zip as BlobPart]);
    // A link named Dockerfile would only fail later, in the build.
    const entries = await zipEntryInfos(zip);
    if (!entries.some((entry) => entry.path === "Dockerfile" && entry.regularFile)) {
      throw new Error("the zip has no Dockerfile file at its root");
    }
    return { zip };
  }
  if (request.directory !== undefined) {
    const entries = await directoryZipEntries(
      request.directory,
      request.ignoreFileProcessor,
      request.defaultIgnoreFile,
      signal,
    );
    return zipPushArchive(entries, tempFile, signal);
  }
  if (request.files !== undefined) {
    return zipPushArchive(await filesZipEntries(request.files), false, signal);
  }
  return undefined;
}

/** Zips entries into a temporary file when tempFile is set, or else in memory. */
async function zipPushArchive(
  entries: ZipEntry[],
  tempFile: boolean,
  signal: AbortSignal | undefined,
): Promise<PushArchive> {
  if (!tempFile) return { zip: await createZip(entries, signal) };
  const node = nodeFileSystem();
  const openAsBlob = node?.openAsBlob;
  if (node === undefined || openAsBlob === undefined) {
    throw new Error(
      "zipping to a temporary file needs Node's fs.openAsBlob; set tempFile to false to zip in memory",
    );
  }
  // A directory of its own, since Node can only create a uniquely named
  // directory, not a file, in one call.
  const dir = await node.fs.mkdtemp(node.path.join(node.tmpdir(), "baseten-image-"));
  const remove = () => node.fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  try {
    const path = node.path.join(dir, "image.zip");
    const handle = await node.fs.open(path, "wx");
    try {
      await writeZip(
        entries,
        async (chunk) => {
          for (let written = 0; written < chunk.length;) {
            written += (await handle.write(chunk, written)).bytesWritten;
          }
        },
        signal,
      );
    } finally {
      await handle.close();
    }
    // Read from the file as it is uploaded.
    return { zip: await openAsBlob(path), remove };
  } catch (err) {
    await remove();
    throw err;
  }
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
  realpath(path: string): Promise<string>;
  mkdtemp(prefix: string): Promise<string>;
  open(path: string, flags: string): Promise<NodeFileHandle>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

interface NodeFileHandle {
  write(data: Uint8Array, offset: number): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
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
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

/** @internal What is used of Node's filesystem, path, and os modules. */
export interface NodeFileSystem {
  fs: NodeFsPromises;
  path: NodePath;
  tmpdir(): string;

  /** Missing on runtimes that implement only part of Node's fs module. */
  openAsBlob?: (path: string) => Promise<Blob>;
}

/** @internal Node's filesystem modules, or undefined on a runtime without them. */
export function nodeFileSystem(): NodeFileSystem | undefined {
  // Reached through getBuiltinModule so that nothing imports node:fs, which
  // would break bundling for other runtimes.
  const getBuiltinModule =
    typeof process === "undefined" ? undefined : process.getBuiltinModule?.bind(process);
  const fs = getBuiltinModule?.("node:fs/promises") as NodeFsPromises | undefined;
  const path = getBuiltinModule?.("node:path") as NodePath | undefined;
  const os = getBuiltinModule?.("node:os") as { tmpdir(): string } | undefined;
  // openAsBlob is only on node:fs, not node:fs/promises.
  const fsRoot = getBuiltinModule?.("node:fs") as
    | { openAsBlob?: (path: string) => Promise<Blob> }
    | undefined;
  if (fs === undefined || path === undefined || os === undefined) return undefined;
  return { fs, path, tmpdir: () => os.tmpdir(), openAsBlob: fsRoot?.openAsBlob?.bind(fsRoot) };
}

/** @internal How {@link addDirectoryZipEntries} walks a directory. */
export interface DirectoryWalkOptions {
  /** Leaves out what it returns true for; keeps everything if unset. */
  ignore?: ImageIgnoreFileFunc;
  signal?: AbortSignal;
}

/**
 * @internal Adds everything under a local directory that is not ignored to
 * entries, each path prefixed, with files read while zipping. Files keep their
 * modes, a link to a file within the directory stores a copy of the file, a
 * link to a file outside it is an error, a link to a directory stores an
 * empty directory, and a broken link is left out. The root `Dockerfile` and
 * `.dockerignore` are never ignored, as Docker keeps them in a build context.
 */
export async function addDirectoryZipEntries(
  node: { fs: NodeFsPromises; path: NodePath },
  dir: string,
  prefix: string,
  entries: ZipEntry[],
  options: DirectoryWalkOptions = {},
): Promise<void> {
  // Resolved, so a link's resolved target can be checked against it.
  const root = await node.fs.realpath(dir);
  await addTreeZipEntries(node, root, dir, "", prefix, entries, options);
}

// relDir is dir's path relative to the walked directory, "" for the walked
// directory itself, or else ending in a slash.
async function addTreeZipEntries(
  node: { fs: NodeFsPromises; path: NodePath },
  root: string,
  dir: string,
  relDir: string,
  prefix: string,
  entries: ZipEntry[],
  options: DirectoryWalkOptions,
): Promise<void> {
  const { fs, path } = node;
  const children = await fs.readdir(dir, { withFileTypes: true });
  children.sort((a, b) => compareNames(a.name, b.name));
  for (const child of children) {
    options.signal?.throwIfAborted();
    const fullPath = path.join(dir, child.name);
    const relPath = relDir + child.name;
    const alwaysKept =
      relDir === "" && (child.name === "Dockerfile" || child.name === DOCKERIGNORE_FILE_NAME);
    if (
      options.ignore !== undefined &&
      !alwaysKept &&
      (await options.ignore({ relPath, isDirectory: child.isDirectory() }))
    ) {
      continue;
    }
    const archivePath = prefix + relPath;
    if (child.isDirectory()) {
      entries.push({ path: archivePath, mode: (await fs.stat(fullPath)).mode });
      await addTreeZipEntries(node, root, fullPath, `${relPath}/`, prefix, entries, options);
    } else if (child.isFile()) {
      const { mode } = await fs.stat(fullPath);
      entries.push({ path: archivePath, read: () => fs.readFile(fullPath), mode });
    } else if (child.isSymbolicLink()) {
      const target = await fs.stat(fullPath).catch(() => undefined);
      if (target?.isFile()) {
        // Stored as a copy of the file, but only for a file within the
        // directory, so a link cannot pull in a file from elsewhere on the
        // machine.
        const targetPath = await fs.realpath(fullPath);
        const relative = path.relative(root, targetPath);
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          throw new Error(
            `${fullPath} is a link to ${targetPath}, outside ${root}; only links to files within it can be pushed`,
          );
        }
        entries.push({ path: archivePath, read: () => fs.readFile(fullPath), mode: target.mode });
      } else if (target?.isDirectory()) {
        // Stored as an empty directory, not followed, so a link cannot pull
        // in the rest of the machine.
        entries.push({ path: archivePath, mode: target.mode });
      }
    }
    // Anything else, such as a socket, has no content to archive.
  }
}

async function directoryZipEntries(
  root: string,
  ignoreFileProcessor: ImageIgnoreFileProcessor | undefined,
  defaultIgnoreFile: ImageIgnoreFileFunc | undefined,
  signal: AbortSignal | undefined,
): Promise<ZipEntry[]> {
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
  const ignore = await resolveImageIgnoreFile(node, root, ignoreFileProcessor, defaultIgnoreFile);
  const entries: ZipEntry[] = [];
  await addDirectoryZipEntries(node, root, "", entries, { ignore, signal });
  return entries;
}

// By code unit rather than locale, so the same files always zip the same way.
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function imageInfoFromApi(image: ApiImage | ApiImageSummary): ImageInfo {
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

// hidden and coming_soon are left out, since listings always have them false.
function imageLibraryInfoFromApi(image: ApiLibraryImage): ImageLibraryInfo {
  return {
    name: image.name,
    displayName: image.display_name,
    description: image.description,
    longDescription: image.long_description,
    image: image.image,
    memory: image.memory,
    ports: sandboxPortsFromApi(image.ports),
    categories: image.categories ?? [],
    tags: image.tags ?? [],
    url: image.url,
    icon: image.icon,
    iconLight: image.icon_light,
    iconDark: image.icon_dark,
    enterprise: image.enterprise ?? false,
    creationExtraArgs: image.creation_options?.extra_args,
    creationVolumes: (image.creation_options?.volumes ?? []).map((volume) => ({
      name: volume.name,
      mountPath: volume.mount_path,
      type: volume.type,
      sizeMb: volume.size_mb,
      readOnly: volume.read_only ?? false,
    })),
  };
}
