import { ApiClient } from "./sandboxapi";
import type { ProcessRequest } from "./sandboxapi";
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

/** One line of process output, tagged with the stream it came from. */
export interface ProcessLogLine {
  stream: "stdout" | "stderr" | "unknown";
  line: string;
}

/**
 * Client for the Baseten Sandbox API.
 *
 * Most of the API lives on {@link SandboxClient.api}, the generated client,
 * where each operation returns its deserialized JSON response.
 *
 * The handful of endpoints that do not return JSON are wrapped by the methods
 * on this class instead, because the generated form of each hands back an
 * unread `Response`.
 */
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
    this._api = new ApiClient({
      baseUrl: options.baseUrl,
      headers,
      fetch: options.fetch,
    });
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

  /**
   * Streams a process's output, yielding one entry per line as it arrives.
   *
   * The underlying response stays open until the process exits or the
   * iteration stops, so this must not be collected eagerly on a long-running
   * process. Pass a signal to stop early.
   */
  async *streamProcessLogs(
    identifier: string,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<ProcessLogLine> {
    const response = await this._api.getProcessLogsStream({ identifier });
    for await (const line of readLines(response, options?.signal)) {
      if (line.startsWith("stdout:")) {
        yield { stream: "stdout", line: line.slice("stdout:".length) };
      } else if (line.startsWith("stderr:")) {
        yield { stream: "stderr", line: line.slice("stderr:".length) };
      } else {
        yield { stream: "unknown", line };
      }
    }
  }

  /**
   * Streams the paths of modified files under a directory, one per event.
   *
   * The underlying response stays open until the iteration stops, so pass a
   * signal to stop early.
   */
  async *watchFilesystem(
    path: string,
    options?: { ignore?: string[]; signal?: AbortSignal },
  ): AsyncGenerator<string> {
    const response = await this._api.getWatchFilesystem({
      path,
      query: options?.ignore ? { ignore: options.ignore.join(",") } : undefined,
    });
    yield* readLines(response, options?.signal);
  }

  /** Reads a file's raw bytes. */
  async readFileBytes(path: string): Promise<Uint8Array> {
    const response = await this._api.getFilesystemRaw({
      path,
      accept: "application/octet-stream",
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Runs a command and streams its output as Server-Sent Events.
   *
   * Returns the response unread, with the process result arriving as the final
   * event. Use {@link ApiClient.postProcess} for the non-streaming form.
   */
  async execStreaming(request: ProcessRequest): Promise<Response> {
    return this._api.postProcessRaw({ accept: "text/event-stream", request });
  }
}

/**
 * Yields newline-delimited text from a response body as it arrives.
 *
 * Both streaming sandbox endpoints emit one record per line, so the trailing
 * partial line is held back until its newline shows up.
 */
async function* readLines(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!response.body) {
    throw new Error("response has no body to stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  if (signal?.aborted) return;
  // These streams are quiet most of the time, so abort has to cancel the
  // reader: testing the flag between reads would never fire while a read is
  // parked waiting for a chunk that may never come. Cancelling resolves the
  // pending read as done, which ends the loop.
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line !== "") yield line;
      }
    }
    // A stream cancelled mid-line has no complete record to report, so the
    // trailing partial line is only flushed when the stream ended on its own.
    if (!signal?.aborted) {
      buffer += decoder.decode();
      if (buffer !== "") yield buffer;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
  }
}
