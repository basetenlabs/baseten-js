import { ResponseError as ManagementResponseError } from "@basetenlabs/client/managementapi";
import {
  ResponseError as SandboxResponseError,
  ResponseErrorResponse as SandboxResponseErrorResponse,
} from "@basetenlabs/client/sandboxapi";
import type { SandboxProcessInfo } from "./sandbox/process";

/** An error response from the sandbox control plane or from a sandbox. */
export class SandboxApiError extends Error {
  /** HTTP status of the response. */
  readonly status: number;

  /** Machine-readable error code, when the response has one. */
  readonly code?: string;

  /** Additional error details, when the response has them. */
  readonly details?: unknown;

  /** Response body, parsed as JSON when possible, otherwise the raw text. */
  readonly body: unknown;

  constructor(status: number, body: unknown, options?: ErrorOptions) {
    const fields =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const bodyMessage = typeof fields.message === "string" ? fields.message : undefined;
    const bodyError = typeof fields.error === "string" ? fields.error : undefined;
    // The control plane puts the code in error and the description in message.
    // A sandbox puts the description in error.
    const code =
      typeof fields.code === "string"
        ? fields.code
        : bodyMessage !== undefined
          ? bodyError
          : undefined;
    const description = bodyMessage ?? bodyError;
    let message = `sandbox API error (HTTP ${status})`;
    if (code !== undefined) message += ` ${code}`;
    if (description !== undefined) message += `: ${description}`;
    super(message, options);
    this.name = "SandboxApiError";
    this.status = status;
    this.code = code;
    this.details = fields.details;
    this.body = body;
  }
}

/**
 * A 502, 503, or 504 from the edge in front of a sandbox rather than from the
 * sandbox itself. Usually transient, for example while a sandbox wakes from
 * standby or when a request outlasts the edge's timeout.
 */
export class SandboxGatewayError extends SandboxApiError {
  constructor(status: number, body: unknown, options?: ErrorOptions) {
    super(status, body, options);
    this.name = "SandboxGatewayError";
  }
}

/**
 * A failed upload of an image's source archive. The upload goes to storage
 * rather than to the API, so its error body has no fixed shape.
 */
export class ImageUploadError extends Error {
  /** Name of the image whose source was being uploaded. */
  readonly imageName: string;

  /** HTTP status of the storage response. */
  readonly status: number;

  /** Raw text of the storage response body. */
  readonly body: string;

  constructor(imageName: string, status: number, body: string) {
    super(
      `uploading the source of image ${imageName} failed (HTTP ${status}); ` +
        "the image stays as it was left, so push it again or delete it",
    );
    this.name = "ImageUploadError";
    this.imageName = imageName;
    this.status = status;
    this.body = body;
  }
}

/**
 * An image that did not become ready to use: either its build failed, or it
 * was still processing when the wait ran out of time.
 */
export class ImageBuildError extends Error {
  /** Name of the image. */
  readonly imageName: string;

  /** Status last seen, `FAILED` when the build failed. */
  readonly status: string;

  /** Whether the wait ran out of time. Processing continues regardless. */
  readonly timedOut: boolean;

  constructor(imageName: string, status: string, timedOut: boolean, options?: ErrorOptions) {
    super(
      timedOut
        ? `image ${imageName} was still ${status} when the wait timed out; it may still finish`
        : `image ${imageName} failed to build (status ${status})`,
      options,
    );
    this.name = "ImageBuildError";
    this.imageName = imageName;
    this.status = status;
    this.timedOut = timedOut;
  }
}

/**
 * A process still running when a wait for it ran out of time. The process
 * keeps running regardless.
 */
export class SandboxProcessWaitTimeoutError extends Error {
  /** PID or name of the process waited on. */
  readonly identifier: string;

  constructor(identifier: string, options?: ErrorOptions) {
    super(
      `process ${identifier} had not finished when the wait timed out; it may still be running`,
      options,
    );
    this.name = "SandboxProcessWaitTimeoutError";
    this.identifier = identifier;
  }
}

/**
 * A copy that did not complete, because the `cp` it runs in the sandbox
 * failed or was stopped.
 */
export class SandboxFileSystemCopyError extends Error {
  /** Path copied from. */
  readonly source: string;

  /** Path copied to. */
  readonly destination: string;

  /** The `cp` process as it ended, whose `logs` hold its error output. */
  readonly process: SandboxProcessInfo;

  constructor(source: string, destination: string, process: SandboxProcessInfo) {
    const detail = process.stderr.trim() || `exit code ${process.exitCode}`;
    super(`copying ${source} to ${destination} ended ${process.status}: ${detail}`);
    this.name = "SandboxFileSystemCopyError";
    this.source = source;
    this.destination = destination;
    this.process = process;
  }
}

const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * Converts an error thrown by a generated client into a {@link SandboxApiError}.
 * Anything else, such as a network failure, is returned unchanged.
 */
export function toSandboxApiError(err: unknown, plane: "control" | "exec"): unknown {
  let status: number;
  let body: unknown;
  if (err instanceof ManagementResponseError || err instanceof SandboxResponseError) {
    status = err.statusCode;
    try {
      body = JSON.parse(err.body);
    } catch {
      body = err.body;
    }
  } else if (err instanceof SandboxResponseErrorResponse) {
    status = err.statusCode;
    body = err.error_response;
  } else {
    return err;
  }
  // Only a sandbox sits behind the edge, so the same statuses from the
  // control plane are ordinary errors.
  if (plane === "exec" && GATEWAY_STATUSES.has(status)) {
    return new SandboxGatewayError(status, body, { cause: err });
  }
  return new SandboxApiError(status, body, { cause: err });
}
