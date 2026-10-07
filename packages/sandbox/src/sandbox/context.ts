import {
  type ApiClient as SandboxApiClient,
  ResponseError as SandboxResponseError,
} from "@basetenlabs/client/sandboxapi";
import type { SandboxRetryOptions } from "../common";
import { toSandboxApiError } from "../errors";
import { retryIdempotent } from "../retry";

/** What the subsystems of one sandbox share, kept off the public classes. */
export interface SandboxContext {
  /** The generated client for the sandbox, sending the given signal on every request. */
  api(signal: AbortSignal | undefined): SandboxApiClient;

  /**
   * Sends a request the generated client cannot, to a path under the
   * sandbox's URL, authenticated and with the sandbox's headers. Throws the
   * same errors as the generated client for a response that is not 2xx.
   */
  request(path: string, init: RequestInit): Promise<Response>;
  retries: Required<SandboxRetryOptions>;
}

/** Builds {@link SandboxContext.request} from the fetch and headers of a sandbox. */
export function sandboxRequester(
  baseUrl: string,
  fetchWithAuth: typeof fetch,
  headers: Record<string, string> | undefined,
): SandboxContext["request"] {
  return async (path, init) => {
    const merged = new Headers(headers);
    for (const [key, value] of new Headers(init.headers)) merged.set(key, value);
    const response = await fetchWithAuth(`${baseUrl}${path}`, { ...init, headers: merged });
    if (!response.ok) throw new SandboxResponseError(response.status, await response.text());
    return response;
  };
}

/**
 * Splits a response body into lines, without line endings, including a last
 * line with none. Cancels the body when iteration ends early.
 */
export async function* responseLines(response: Response): AsyncGenerator<string, void, undefined> {
  if (response.body === null) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let done = false;
  try {
    let buffer = "";
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      buffer += result.value;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop()!;
      yield* lines;
    }
    done = true;
    if (buffer !== "") yield buffer;
  } finally {
    // Frees the connection, or on HTTP/2 the stream, instead of leaving the
    // rest of the body unread.
    if (!done) await reader.cancel().catch(() => {});
  }
}

/** Runs a call to a sandbox, converting its errors. */
export async function callSandbox<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw toSandboxApiError(err, "exec");
  }
}

/**
 * Runs an idempotent call to a sandbox, converting its errors and retrying
 * dropped connections and gateway errors on the read budgets.
 */
export function callSandboxIdempotent<T>(
  context: SandboxContext,
  signal: AbortSignal | undefined,
  call: (api: SandboxApiClient) => Promise<T>,
): Promise<T> {
  return retryIdempotent(() => callSandbox(() => call(context.api(signal))), {
    maxRetries: context.retries.readMaxRetries,
    gatewayMaxRetries: context.retries.gatewayMaxRetries,
    signal,
  });
}

/**
 * Runs an idempotent upload to a sandbox, such as a write of the same content
 * to the same path, converting its errors and retrying dropped connections
 * and gateway errors on the upload budgets. The call is made again on each
 * attempt, so it must build a fresh body every time.
 */
export function callSandboxUpload<T>(
  context: SandboxContext,
  signal: AbortSignal | undefined,
  call: () => Promise<T>,
): Promise<T> {
  return retryIdempotent(() => callSandbox(call), {
    maxRetries: context.retries.uploadMaxRetries,
    gatewayMaxRetries: context.retries.gatewayMaxRetries,
    signal,
  });
}
