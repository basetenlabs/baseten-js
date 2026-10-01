import type {
  Directory,
  File as ApiFile,
  GetFilesystemResponse,
  MultipartPartInfo,
} from "@basetenlabs/client/sandboxapi";
import { type CallOptions, Limiter } from "../common";
import { SandboxFileSystemCopyError } from "../errors";
import {
  callSandbox,
  callSandboxIdempotent,
  callSandboxUpload,
  responseLines,
  type SandboxContext,
} from "./context";
import { SandboxProcess } from "./process";

const DEFAULT_COPY_TIMEOUT_MS = 180_000;
const COPY_POLL_INTERVAL_MS = 100;

const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;
const MULTIPART_PART_BYTES = 5 * 1024 * 1024;

// Most upload parts in flight at once per sandbox, across all of its uploads.
// Many at once on one HTTP/2 connection can trip the server's rapid reset
// limit, so this holds on every transport rather than guessing which is used.
const UPLOAD_PARTS_IN_FLIGHT = 2;

/** Request for {@link SandboxFileSystem.read}. */
export interface SandboxFileSystemReadRequest {
  /** Absolute path of the file. */
  path: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxFileSystem.readBytes}. */
export interface SandboxFileSystemReadBytesRequest {
  /** Absolute path of the file. */
  path: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxFileSystem.write}. */
export interface SandboxFileSystemWriteRequest {
  /** Absolute path of the file, created or replaced. */
  path: string;

  /** Text content to write. */
  content: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxFileSystem.writeBytes}. */
export interface SandboxFileSystemWriteBytesRequest {
  /** Absolute path of the file, created or replaced. */
  path: string;

  /** Content to write. */
  content: Uint8Array | Blob;

  /** Octal file mode, such as `"0755"`. The sandbox's default when unset. */
  permissions?: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxFileSystem.mkdir}. */
export interface SandboxFileSystemMkdirRequest {
  /** Absolute path of the directory. */
  path: string;

  /** Octal directory mode, such as `"0755"`. The sandbox's default when unset. */
  permissions?: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxFileSystem.list}. */
export interface SandboxFileSystemListRequest {
  /** Absolute path of the directory. */
  path: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxFileSystem.remove}. */
export interface SandboxFileSystemRemoveRequest {
  /** Absolute path of the file or directory. */
  path: string;

  /** Whether to remove a directory and everything in it. */
  recursive?: boolean;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxFileSystem.find}. */
export interface SandboxFileSystemFindRequest {
  /** Absolute path of the directory to search in. */
  path: string;

  /** Whether to find only files or only directories. Both when unset. */
  type?: SandboxFileSystemEntryType;

  /** File patterns to include, such as `"*.ts"`. */
  patterns?: string[];

  /** Maximum number of results. 0 means all. The sandbox defaults to 20. */
  maxResults?: number;

  /**
   * Directory names to skip. The sandbox defaults to common dependency and
   * build directories, such as `node_modules` and `.git`.
   */
  excludeDirs?: string[];

  /** Whether to skip hidden files and directories. The sandbox defaults to true. */
  excludeHidden?: boolean;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxFileSystem.grep}. */
export interface SandboxFileSystemGrepRequest {
  /** Absolute path of the directory to search in. */
  path: string;

  /** Text to search for. */
  query: string;

  /** Whether the search is case sensitive. The sandbox defaults to false. */
  caseSensitive?: boolean;

  /** Maximum number of results. The sandbox defaults to 100. */
  maxResults?: number;

  /** File pattern to include, such as `"*.ts"`. */
  filePattern?: string;

  /**
   * Directory names to skip. The sandbox defaults to common dependency and
   * build directories, such as `node_modules` and `.git`.
   */
  excludeDirs?: string[];
  callOptions?: CallOptions;
}

/** Request for {@link SandboxFileSystem.copy}. */
export interface SandboxFileSystemCopyRequest {
  /** Absolute path of the file or directory to copy. */
  source: string;

  /** Absolute path to copy to. */
  destination: string;

  /**
   * Milliseconds to wait for the copy before giving up, which does not stop
   * it. Defaults to 180s.
   */
  timeoutMs?: number;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxFileSystem.writeTree}. */
export interface SandboxFileSystemWriteTreeRequest {
  /** Absolute path of the directory to write under. */
  path: string;

  /** Text content of each file, by path relative to {@link path}. */
  files: Record<string, string>;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxFileSystem.watch}. */
export interface SandboxFileSystemWatchRequest {
  /** Absolute path of the directory to watch. */
  path: string;

  /** Patterns of paths to ignore. */
  ignore?: string[];
  callOptions?: CallOptions;
}

/**
 * Kind of a filesystem entry. Other values may be added, so do not treat
 * this list as exhaustive.
 */
export type SandboxFileSystemEntryType = "file" | "directory" | (string & {});

/** A directory's contents, one level deep, from {@link SandboxFileSystem.list}. */
export interface SandboxFileSystemDirectory {
  name: string;
  path: string;
  files: SandboxFileSystemFileInfo[];
  subdirectories: SandboxFileSystemSubdirectoryInfo[];
}

/** A file in a {@link SandboxFileSystemDirectory}. */
export interface SandboxFileSystemFileInfo {
  name: string;
  path: string;
  sizeBytes: number;

  /** File mode, as the sandbox reports it. */
  permissions: string;
  owner: string;
  group: string;
  lastModified: Date;
}

/** A subdirectory in a {@link SandboxFileSystemDirectory}. */
export interface SandboxFileSystemSubdirectoryInfo {
  name: string;
  path: string;
}

/** Result of {@link SandboxFileSystem.find}. */
export interface SandboxFileSystemFindResult {
  matches: SandboxFileSystemFindMatch[];

  /** Number of entries found, which may exceed the matches returned. */
  total: number;
}

/** An entry found by {@link SandboxFileSystem.find}. */
export interface SandboxFileSystemFindMatch {
  /** Path relative to the searched path. */
  path: string;
  type: SandboxFileSystemEntryType;
}

/** Result of {@link SandboxFileSystem.grep}. */
export interface SandboxFileSystemGrepResult {
  matches: SandboxFileSystemGrepMatch[];

  /** Number of matching lines, which may exceed the matches returned. */
  total: number;
}

/** A matching line found by {@link SandboxFileSystem.grep}. */
export interface SandboxFileSystemGrepMatch {
  /** Path relative to the searched path. */
  path: string;

  /** Line number, starting at 1. */
  line: number;
  column: number;

  /** The matching line. */
  text: string;

  /** Lines around the match, when the sandbox includes them. */
  context?: string;
}

/**
 * Kind of change in a {@link SandboxFileSystemWatchEvent}. Other values may
 * be added, so do not treat this list as exhaustive.
 */
export type SandboxFileSystemWatchOp =
  | "CREATE"
  | "WRITE"
  | "REMOVE"
  | "RENAME"
  | "CHMOD"
  | (string & {});

/** A change seen by {@link SandboxFileSystem.watch}. */
export interface SandboxFileSystemWatchEvent {
  op: SandboxFileSystemWatchOp;

  /** Full path of the changed entry. */
  path: string;
}

/** Files and directories in a sandbox. */
export class SandboxFileSystem {
  readonly #context: SandboxContext;
  // One per sandbox, since a sandbox builds its file system once.
  readonly #partLimiter = new Limiter(UPLOAD_PARTS_IN_FLIGHT);
  #process?: SandboxProcess;

  /** @internal Obtained from {@link Sandbox.fs}. */
  constructor(context: SandboxContext) {
    this.#context = context;
  }

  /** Reads a text file. */
  async read(request: SandboxFileSystemReadRequest): Promise<string> {
    const result = await callSandboxIdempotent(this.#context, request.callOptions?.signal, (api) =>
      api.getFilesystem({ path: request.path }),
    );
    if (typeof result === "string") return result;
    if ("content" in result) return result.content;
    throw new Error(`${request.path} is a directory, not a file`);
  }

  /** Reads a file as bytes. */
  async readBytes(request: SandboxFileSystemReadBytesRequest): Promise<Uint8Array> {
    return callSandboxIdempotent(this.#context, request.callOptions?.signal, async (api) => {
      const response = await api.getFilesystemRaw({
        path: request.path,
        accept: "application/octet-stream",
      });
      // A directory comes back as its JSON listing whatever was asked for.
      if (response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel();
        throw new Error(`${request.path} is a directory, not a file`);
      }
      return new Uint8Array(await response.arrayBuffer());
    });
  }

  /**
   * Writes a text file, creating it or replacing its content. Content over
   * 5MB is uploaded in 5MB parts through the multipart upload endpoints, at
   * most 2 parts at a time per sandbox.
   */
  async write(request: SandboxFileSystemWriteRequest): Promise<void> {
    const signal = request.callOptions?.signal;
    // A UTF-16 unit is at most 3 bytes of UTF-8, so only a long string can be
    // over the threshold, and shorter ones skip encoding just to measure.
    if (request.content.length * 3 > MULTIPART_THRESHOLD_BYTES) {
      const content = new Blob([request.content]);
      if (content.size > MULTIPART_THRESHOLD_BYTES) {
        return this.#writeMultipart(request.path, content, undefined, signal);
      }
    }
    // Retried, since a repeat writes the same content.
    await callSandboxUpload(this.#context, signal, () =>
      this.#context
        .api(signal)
        .putFilesystem({ path: request.path, request: { content: request.content } }),
    );
  }

  /**
   * Writes a file from bytes, creating it or replacing its content. Content
   * over 5MB is uploaded in 5MB parts through the multipart upload endpoints,
   * at most 2 parts at a time per sandbox.
   */
  async writeBytes(request: SandboxFileSystemWriteBytesRequest): Promise<void> {
    const signal = request.callOptions?.signal;
    const content =
      request.content instanceof Blob ? request.content : new Blob([request.content as BlobPart]);
    if (content.size > MULTIPART_THRESHOLD_BYTES) {
      return this.#writeMultipart(request.path, content, request.permissions, signal);
    }
    const filename = request.path.split("/").pop() || "file";
    // The generated client has no multipart form for this endpoint, since the
    // spec documents only a JSON body there. Retried, since a repeat writes
    // the same content, with the form rebuilt for each attempt.
    await callSandboxUpload(this.#context, signal, async () => {
      const form = new FormData();
      form.append("file", content, filename);
      if (request.permissions !== undefined) form.append("permissions", request.permissions);
      form.append("path", request.path);
      const response = await this.#context.request(
        `/filesystem/${encodeURIComponent(request.path)}`,
        { method: "PUT", body: form, signal },
      );
      await response.body?.cancel();
    });
  }

  /** Creates a directory. */
  async mkdir(request: SandboxFileSystemMkdirRequest): Promise<void> {
    const signal = request.callOptions?.signal;
    // Retried, since a repeat creates the same directory.
    await callSandboxUpload(this.#context, signal, () =>
      this.#context.api(signal).putFilesystem({
        path: request.path,
        request: { isDirectory: true, permissions: request.permissions },
      }),
    );
  }

  /** Lists a directory's files and subdirectories, one level deep. */
  async list(request: SandboxFileSystemListRequest): Promise<SandboxFileSystemDirectory> {
    const result: GetFilesystemResponse = await callSandboxIdempotent(
      this.#context,
      request.callOptions?.signal,
      (api) => api.getFilesystem({ path: request.path }),
    );
    if (typeof result === "string" || !("files" in result)) {
      throw new Error(`${request.path} is a file, not a directory`);
    }
    return directoryFromApi(result);
  }

  /** Removes a file or directory. */
  async remove(request: SandboxFileSystemRemoveRequest): Promise<void> {
    // Not retried, since a repeat of a removal whose response was lost would
    // fail for a path that is already gone.
    await callSandbox(() =>
      this.#context.api(request.callOptions?.signal).deleteFilesystem({
        path: request.path,
        params: { recursive: request.recursive },
      }),
    );
  }

  /** Finds files and directories by name under a directory. */
  async find(request: SandboxFileSystemFindRequest): Promise<SandboxFileSystemFindResult> {
    const result = await callSandboxIdempotent(this.#context, request.callOptions?.signal, (api) =>
      api.getFilesystemFind({
        path: request.path,
        params: {
          type: request.type,
          patterns: request.patterns?.join(","),
          maxResults: request.maxResults,
          excludeDirs: request.excludeDirs?.join(","),
          excludeHidden: request.excludeHidden,
        },
      }),
    );
    return {
      // The server sends null rather than an empty list when nothing matches.
      matches: (result.matches ?? []).map((match) => ({ path: match.path, type: match.type })),
      total: result.total,
    };
  }

  /** Searches the contents of files under a directory for text. */
  async grep(request: SandboxFileSystemGrepRequest): Promise<SandboxFileSystemGrepResult> {
    const result = await callSandboxIdempotent(this.#context, request.callOptions?.signal, (api) =>
      api.getFilesystemContentSearch({
        path: request.path,
        params: {
          query: request.query,
          caseSensitive: request.caseSensitive,
          maxResults: request.maxResults,
          filePattern: request.filePattern,
          excludeDirs: request.excludeDirs?.join(","),
        },
      }),
    );
    return {
      // The server sends null rather than an empty list when nothing matches.
      matches: (result.matches ?? []).map((match) => ({
        path: match.path,
        line: match.line,
        column: match.column,
        text: match.text,
        context: match.context,
      })),
      total: result.total,
    };
  }

  /**
   * Copies a file or directory. Runs `cp -r` in the sandbox through
   * {@link SandboxProcess.exec}, then {@link SandboxProcess.wait}s for it, so
   * `cp`'s rules apply, such as copying into a destination that is an
   * existing directory.
   *
   * Throws {@link SandboxFileSystemCopyError} if the copy fails, and
   * {@link SandboxProcessWaitTimeoutError} if it outlasts the timeout, which
   * does not stop it.
   */
  async copy(request: SandboxFileSystemCopyRequest): Promise<void> {
    const process = (this.#process ??= new SandboxProcess(this.#context));
    const started = await process.exec({
      command: `cp -r ${shellQuote(request.source)} ${shellQuote(request.destination)}`,
      callOptions: request.callOptions,
    });
    const finished = await process.wait({
      identifier: started.pid,
      timeoutMs: request.timeoutMs ?? DEFAULT_COPY_TIMEOUT_MS,
      pollIntervalMs: COPY_POLL_INTERVAL_MS,
      callOptions: request.callOptions,
    });
    if (finished.status !== "completed" || finished.exitCode !== 0) {
      throw new SandboxFileSystemCopyError(request.source, request.destination, finished);
    }
  }

  /**
   * Writes several text files under a directory in one call, creating or
   * replacing each.
   */
  async writeTree(request: SandboxFileSystemWriteTreeRequest): Promise<void> {
    const signal = request.callOptions?.signal;
    // Retried, since a repeat writes the same content.
    await callSandboxUpload(this.#context, signal, () =>
      this.#context
        .api(signal)
        .putFilesystemTree({ path: request.path, request: { files: request.files } }),
    );
  }

  /**
   * Yields changes in a directory as they happen, until iteration ends or
   * the signal aborts. Changes in its subdirectories are not included.
   */
  async *watch(
    request: SandboxFileSystemWatchRequest,
  ): AsyncGenerator<SandboxFileSystemWatchEvent, void, undefined> {
    const response = await callSandbox(() =>
      this.#context.api(request.callOptions?.signal).getWatchFilesystem({
        path: request.path,
        params: { ignore: request.ignore?.join(",") },
      }),
    );
    for await (const line of responseLines(response)) {
      if (line.trim() === "" || line.startsWith("[keepalive]")) continue;
      const event = JSON.parse(line) as { op: string; path: string; name: string };
      yield { op: event.op, path: joinPath(event.path, event.name) };
    }
  }

  /** Uploads content in parts through the multipart upload endpoints. */
  async #writeMultipart(
    path: string,
    content: Blob,
    permissions: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    // Not retried, since a repeat would start a second upload.
    const { uploadId } = await callSandbox(() =>
      this.#context.api(signal).postFilesystemMultipartInitiate({ path, request: { permissions } }),
    );
    if (!uploadId) throw new Error(`Multipart upload of ${path} returned no upload ID`);
    try {
      const parts = await this.#sendParts(uploadId, content, signal);
      // Not retried, since a repeat of a completion whose response was lost
      // would fail for an upload that is already complete.
      await callSandbox(() =>
        this.#context.api(signal).postFilesystemMultipartComplete({ uploadId, request: { parts } }),
      );
    } catch (err) {
      // Sent without the signal, which may be what ended the upload. Its own
      // failure is dropped in favor of the error that ended the upload.
      await callSandbox(() =>
        this.#context.api(undefined).deleteFilesystemMultipartAbort({ uploadId }),
      ).catch(() => {});
      throw err;
    }
  }

  /** Uploads every part of content, in order. The first part to fail stops the rest. */
  async #sendParts(
    uploadId: string,
    content: Blob,
    signal: AbortSignal | undefined,
  ): Promise<MultipartPartInfo[]> {
    const partCount = Math.ceil(content.size / MULTIPART_PART_BYTES);
    const parts: MultipartPartInfo[] = [];
    const stop = new AbortController();
    const partSignal = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
    let failure: { error: unknown } | undefined;
    let next = 0;
    const work = async () => {
      try {
        while (next < partCount) {
          const index = next++;
          const partNumber = index + 1;
          const part = content.slice(
            index * MULTIPART_PART_BYTES,
            partNumber * MULTIPART_PART_BYTES,
          );
          // Retried, since a repeat sends the same part. The slot is taken
          // per attempt, so a part waiting to retry does not hold one.
          const result = await callSandboxUpload(this.#context, partSignal, () =>
            this.#partLimiter.run(partSignal, () => {
              const form = new FormData();
              form.append("file", part);
              return this.#context
                .api(partSignal)
                .putFilesystemMultipartPart({ uploadId, params: { partNumber }, request: form });
            }),
          );
          parts[index] = { partNumber, etag: result.etag };
        }
      } catch (err) {
        if (failure === undefined) {
          failure = { error: err };
          stop.abort(err);
        }
      }
    };
    // More workers than slots would only wait for one.
    await Promise.all(Array.from({ length: Math.min(UPLOAD_PARTS_IN_FLIGHT, partCount) }, work));
    if (failure !== undefined) throw failure.error;
    return parts;
  }
}

function directoryFromApi(directory: Directory): SandboxFileSystemDirectory {
  return {
    name: directory.name,
    path: directory.path,
    files: directory.files.map(fileInfoFromApi),
    subdirectories: directory.subdirectories.map((subdirectory) => ({
      name: subdirectory.name,
      path: subdirectory.path,
    })),
  };
}

function fileInfoFromApi(file: ApiFile): SandboxFileSystemFileInfo {
  return {
    name: file.name,
    path: file.path,
    sizeBytes: file.size,
    permissions: file.permissions,
    owner: file.owner,
    group: file.group,
    lastModified: new Date(file.lastModified),
  };
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/** Quotes a string as one literal POSIX shell argument. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
