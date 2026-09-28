import type { ProcessRequest, ProcessResponse } from "@basetenlabs/client/sandboxapi";
import type { CallOptions } from "../common";
import { SandboxApiError, SandboxProcessWaitTimeoutError } from "../errors";
import { isTransientResetError, sleep } from "../retry";
import { callSandbox, callSandboxIdempotent, responseLines, type SandboxContext } from "./context";

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 1000;

const TERMINAL_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);

// Statuses a wait rides out, since the sandbox or its edge may briefly fail.
const WAIT_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// Messages of the TypeError that fetch throws, per runtime, when no response
// arrived at all.
const FETCH_NETWORK_ERROR_MESSAGE =
  /^(fetch failed|Failed to fetch|NetworkError when attempting to fetch resource\.)$/;

/**
 * Status of a process in a sandbox. Other values may be added, so do not
 * treat this list as exhaustive.
 */
export type SandboxProcessStatus =
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "stopped"
  | (string & {});

/** A process in a sandbox. */
export interface SandboxProcessInfo {
  /** Process identifier, usable wherever a process name is. */
  pid: string;
  name: string;
  command: string;
  status: SandboxProcessStatus;
  exitCode: number;
  stdout: string;
  stderr: string;

  /** Standard output and standard error, interleaved. */
  logs: string;
  workingDir: string;
  startedAt: Date;
  completedAt?: Date;

  /** Whether scale-to-zero is disabled for this process. */
  keepAlive?: boolean;

  /** Maximum number of restarts on failure. Negative means unlimited. */
  maxRestarts?: number;

  /** Number of times the process has been restarted. */
  restartCount?: number;

  /** Whether the process is restarted when it fails. */
  restartOnFailure?: boolean;

  /** Whether the process was started with a writable stdin pipe. */
  stdin?: boolean;
}

/** Output of a process, as returned by {@link SandboxProcess.logs}. */
export interface SandboxProcessLogs {
  stdout: string;
  stderr: string;

  /** Standard output and standard error, interleaved. */
  logs: string;
}

/** One line of a process's output. */
export interface SandboxProcessLogLine {
  /** Which output the line came from, when the sandbox reports it. */
  stream?: "stdout" | "stderr";

  /** The line, without its line ending. */
  text: string;
}

/** An event from {@link SandboxProcess.execStream}. */
export type SandboxProcessExecEvent =
  | {
      /**
       * Output as the process wrote it, which may hold several lines, part of
       * one, or text with no newline at all, such as a prompt.
       */
      type: "output";
      stream: "stdout" | "stderr";
      text: string;
    }
  | {
      /** The process exited. Always the last event. */
      type: "exit";
      process: SandboxProcessInfo;
    };

/** Request for {@link SandboxProcess.execStream}. */
export interface SandboxProcessExecStreamRequest {
  /** Shell command to run. */
  command: string;

  /** Directory to run the command in. */
  workingDir?: string;

  /** Environment variables for the process, on top of the sandbox's own. */
  env?: Record<string, string>;

  /** Name to refer to the process by, instead of its pid. */
  name?: string;

  /**
   * Milliseconds after which the process is killed, rounded up to whole
   * seconds. 0 means never. When {@link keepAlive} is true, defaults to
   * 600s.
   */
  timeoutMs?: number;

  /** Disable scale-to-zero while the process runs. */
  keepAlive?: boolean;

  /** Whether to restart the process when it fails. */
  restartOnFailure?: boolean;

  /**
   * Maximum number of restarts on failure. A negative value, such as -1,
   * means unlimited.
   */
  maxRestarts?: number;

  /**
   * Open a writable stdin pipe, fed by {@link SandboxProcess.writeStdin} and
   * closed by {@link SandboxProcess.closeStdin}. The pipe does not survive a
   * restart of the sandbox's execution API: the process then reads end of
   * file.
   */
  stdin?: boolean;

  /** Ports the process must be listening on before the call returns. */
  waitForPorts?: number[];
  callOptions?: CallOptions;
}

/** Request for {@link SandboxProcess.exec}. */
export interface SandboxProcessExecRequest extends SandboxProcessExecStreamRequest {
  /** Whether to return only once the process has exited. Defaults to false. */
  waitForCompletion?: boolean;
}

/** Request for {@link SandboxProcess.get}. */
export interface SandboxProcessGetRequest {
  /** PID or name of the process. */
  identifier: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxProcess.list}. */
export interface SandboxProcessListRequest {
  callOptions?: CallOptions;
}

/** Request for {@link SandboxProcess.stop}. */
export interface SandboxProcessStopRequest {
  /** PID or name of the process. */
  identifier: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxProcess.kill}. */
export interface SandboxProcessKillRequest {
  /** PID or name of the process. */
  identifier: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxProcess.logs}. */
export interface SandboxProcessLogsRequest {
  /** PID or name of the process. */
  identifier: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxProcess.streamLogs}. */
export interface SandboxProcessStreamLogsRequest {
  /** PID or name of the process. */
  identifier: string;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxProcess.wait}. */
export interface SandboxProcessWaitRequest {
  /** PID or name of the process. */
  identifier: string;

  /**
   * Milliseconds to wait before giving up, which does not stop the process.
   * `Infinity` waits indefinitely. Defaults to 60s.
   */
  timeoutMs?: number;

  /** Milliseconds between checks. Defaults to 1s. */
  pollIntervalMs?: number;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxProcess.writeStdin}. */
export interface SandboxProcessWriteStdinRequest {
  /** PID or name of the process. */
  identifier: string;

  /**
   * Bytes to write, sent as is. A string is written as UTF-8. Include any
   * trailing newline the process expects.
   */
  data: string | Uint8Array;
  callOptions?: CallOptions;
}

/** Request for {@link SandboxProcess.closeStdin}. */
export interface SandboxProcessCloseStdinRequest {
  /** PID or name of the process. */
  identifier: string;
  callOptions?: CallOptions;
}

/** Processes in a sandbox. */
export class SandboxProcess {
  readonly #context: SandboxContext;

  /** @internal Obtained from {@link Sandbox.process}. */
  constructor(context: SandboxContext) {
    this.#context = context;
  }

  /** Starts a command. */
  async exec(request: SandboxProcessExecRequest): Promise<SandboxProcessInfo> {
    // Not retried, since a command may have side effects even when its
    // response is lost.
    const response = await callSandbox(() =>
      this.#context.api(request.callOptions?.signal).postProcess({
        request: { ...processRequestToApi(request), waitForCompletion: request.waitForCompletion },
      }),
    );
    return processInfoFromApi(response);
  }

  /**
   * Runs a command, yielding its output as it arrives and then its exit.
   * Ending iteration early, or aborting, stops only the stream, not the
   * process.
   */
  async *execStream(
    request: SandboxProcessExecStreamRequest,
  ): AsyncGenerator<SandboxProcessExecEvent, void, undefined> {
    // The sandbox streams only when asked for text/event-stream, though what
    // it sends is newline-delimited JSON.
    const response = await callSandbox(() =>
      this.#context.api(request.callOptions?.signal).postProcessRaw({
        accept: "text/event-stream",
        request: { ...processRequestToApi(request), waitForCompletion: true },
      }),
    );
    for await (const line of responseLines(response)) {
      if (line === "") continue;
      const event = JSON.parse(line) as { type?: unknown; data?: unknown };
      if (event.type === "stdout" || event.type === "stderr") {
        yield { type: "output", stream: event.type, text: String(event.data ?? "") };
      } else if (event.type === "result") {
        yield {
          type: "exit",
          process: processInfoFromApi(JSON.parse(String(event.data)) as ProcessResponse),
        };
        return;
      }
    }
    throw new Error("the process stream ended before reporting the process's exit");
  }

  /** Gets a process. */
  async get(request: SandboxProcessGetRequest): Promise<SandboxProcessInfo> {
    const response = await callSandboxIdempotent(
      this.#context,
      request.callOptions?.signal,
      (api) => api.getProcessIdentifier({ identifier: request.identifier }),
    );
    return processInfoFromApi(response);
  }

  /** Lists the sandbox's processes, running and finished. */
  async list(request: SandboxProcessListRequest = {}): Promise<SandboxProcessInfo[]> {
    const response = await callSandboxIdempotent(
      this.#context,
      request.callOptions?.signal,
      (api) => api.getProcess(),
    );
    return response.map(processInfoFromApi);
  }

  /** Asks a process to stop, letting it shut down cleanly. */
  async stop(request: SandboxProcessStopRequest): Promise<void> {
    await callSandbox(() =>
      this.#context
        .api(request.callOptions?.signal)
        .deleteProcess({ identifier: request.identifier }),
    );
  }

  /** Kills a process immediately. */
  async kill(request: SandboxProcessKillRequest): Promise<void> {
    await callSandbox(() =>
      this.#context
        .api(request.callOptions?.signal)
        .deleteProcessKill({ identifier: request.identifier }),
    );
  }

  /** Gets a process's output so far. */
  async logs(request: SandboxProcessLogsRequest): Promise<SandboxProcessLogs> {
    const response = await callSandboxIdempotent(
      this.#context,
      request.callOptions?.signal,
      (api) => api.getProcessLogs({ identifier: request.identifier }),
    );
    return { stdout: response.stdout, stderr: response.stderr, logs: response.logs };
  }

  /**
   * Yields a process's output line by line as it arrives, ending when the
   * process exits. Works for any process, including one started elsewhere.
   * Ending iteration early, or aborting, stops only the stream.
   */
  async *streamLogs(
    request: SandboxProcessStreamLogsRequest,
  ): AsyncGenerator<SandboxProcessLogLine, void, undefined> {
    const response = await callSandbox(() =>
      this.#context
        .api(request.callOptions?.signal)
        .getProcessLogsStream({ identifier: request.identifier }),
    );
    for await (const line of responseLines(response)) {
      if (line.startsWith("[keepalive]")) continue;
      if (line.startsWith("stdout:")) {
        yield { stream: "stdout", text: line.slice("stdout:".length) };
      } else if (line.startsWith("stderr:")) {
        yield { stream: "stderr", text: line.slice("stderr:".length) };
      } else {
        yield { text: line };
      }
    }
  }

  /**
   * Waits for a process to finish, returning it whether it succeeded or not.
   * Throws {@link SandboxProcessWaitTimeoutError} on timeout, which does not
   * stop the process.
   */
  async wait(request: SandboxProcessWaitRequest): Promise<SandboxProcessInfo> {
    const signal = request.callOptions?.signal;
    const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const timeout = timeoutMs === Infinity ? undefined : AbortSignal.timeout(timeoutMs);
    const signals = [signal, timeout].filter((s) => s !== undefined);
    const waitSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const intervalMs = request.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
    let lastError: unknown;
    try {
      for (;;) {
        try {
          const response = await callSandbox(() =>
            this.#context.api(waitSignal).getProcessIdentifier({ identifier: request.identifier }),
          );
          if (TERMINAL_STATUSES.has(response.status)) return processInfoFromApi(response);
          // Unlike elsewhere, an unknown status throws rather than being
          // waited on, keeping existing behavior.
          if (response.status !== "running") {
            throw new Error(
              `process ${request.identifier} has unknown status ${String(response.status)}`,
            );
          }
          lastError = undefined;
        } catch (err) {
          if (waitSignal?.aborted || !isRetryableWaitError(err)) throw err;
          lastError = err;
        }
        await sleep(intervalMs, waitSignal);
      }
    } catch (err) {
      if (!timeout?.aborted || signal?.aborted) throw err;
      throw new SandboxProcessWaitTimeoutError(request.identifier, { cause: lastError });
    }
  }

  /** Writes to the standard input of a process started with `stdin: true`. */
  async writeStdin(request: SandboxProcessWriteStdinRequest): Promise<void> {
    // Not retried, since a repeat could write the bytes twice.
    await callSandbox(() =>
      this.#context
        .api(request.callOptions?.signal)
        .postProcessStdin({ identifier: request.identifier, request: request.data as BodyInit }),
    );
  }

  /** Closes a process's standard input, so it reads end of file. */
  async closeStdin(request: SandboxProcessCloseStdinRequest): Promise<void> {
    await callSandboxIdempotent(this.#context, request.callOptions?.signal, (api) =>
      api.deleteProcessStdin({ identifier: request.identifier }),
    );
  }
}

function isRetryableWaitError(err: unknown): boolean {
  if (err instanceof SandboxApiError) return WAIT_RETRY_STATUSES.has(err.status);
  return (
    isTransientResetError(err) ||
    (err instanceof TypeError && FETCH_NETWORK_ERROR_MESSAGE.test(err.message))
  );
}

function processRequestToApi(request: SandboxProcessExecStreamRequest): ProcessRequest {
  return {
    command: request.command,
    workingDir: request.workingDir,
    env: request.env,
    name: request.name,
    timeout: request.timeoutMs === undefined ? undefined : Math.ceil(request.timeoutMs / 1000),
    keepAlive: request.keepAlive,
    restartOnFailure: request.restartOnFailure,
    maxRestarts: request.maxRestarts,
    stdin: request.stdin,
    waitForPorts: request.waitForPorts,
  };
}

function processInfoFromApi(process: ProcessResponse): SandboxProcessInfo {
  return {
    pid: process.pid,
    name: process.name,
    command: process.command,
    status: process.status,
    exitCode: process.exitCode,
    stdout: process.stdout,
    stderr: process.stderr,
    logs: process.logs,
    workingDir: process.workingDir,
    startedAt: new Date(process.startedAt),
    // A running process has null here, though the spec requires a string, so
    // both null and "" count as unset.
    completedAt: process.completedAt ? new Date(process.completedAt) : undefined,
    keepAlive: process.keepAlive,
    maxRestarts: process.maxRestarts,
    restartCount: process.restartCount,
    restartOnFailure: process.restartOnFailure,
    stdin: process.stdin,
  };
}
