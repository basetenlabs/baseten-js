import { SandboxClient as SandboxApiClientOwner } from "@basetenlabs/client";
import type { ApiClient as SandboxApiClient } from "@basetenlabs/client/sandboxapi";
import { authenticatedFetch, type SandboxTokenProvider, TokenSource } from "../auth";
import type { SandboxRetryOptions } from "../common";
import { resolveRetryOptions } from "../retry";
import { Transport } from "../transport";
import { type SandboxContext, sandboxRequester } from "./context";
import { SandboxFileSystem } from "./fs";
import { SandboxProcess } from "./process";

/** Options for {@link Sandbox}. */
export interface SandboxOptions {
  /** Name of the sandbox. */
  name: string;

  /** Base URL of the sandbox's execution API, as reported in `SandboxInfo.url`. */
  url: string;

  /**
   * Returns the bearer token for each request. When unset, no Authorization
   * is sent.
   */
  tokenProvider?: SandboxTokenProvider;

  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;

  /** Additional headers to send on every request. */
  headers?: Record<string, string>;

  /** Same as {@link SandboxClientOptions.nodeUndici}. */
  nodeUndici?: boolean;

  /** Retry budgets for transient failures. */
  retries?: SandboxRetryOptions;
}

/**
 * One sandbox, reached directly at its own URL.
 *
 * Get one from {@link SandboxClient.create} or {@link SandboxClient.get}, or
 * construct one directly when the URL and a token are already known.
 */
export class Sandbox {
  readonly #options: SandboxOptions;
  readonly #context: SandboxContext;
  #fs?: SandboxFileSystem;
  #process?: SandboxProcess;

  /**
   * @param tokens Internal: the token source of the client this sandbox came
   *   from, so a token revoked here is dropped from the client's cache too.
   */
  constructor(options: SandboxOptions, tokens?: TokenSource) {
    this.#options = { ...options };
    const transport = new Transport({ fetch: options.fetch, nodeUndici: options.nodeUndici });
    tokens ??= new TokenSource({
      apiKey: "",
      tokenProvider: options.tokenProvider,
      fetch: transport.fetch,
    });
    const fetchWithAuth = authenticatedFetch(transport.fetch, tokens);
    const baseUrl = options.url.replace(/\/+$/, "");
    const headers = options.headers;
    // An empty token leaves Authorization to fetchWithAuth.
    const newApi = (fetchForCall: typeof fetch) =>
      new SandboxApiClientOwner({ token: "", baseUrl, fetch: fetchForCall, headers }).api;
    const unsignaledApi = newApi(fetchWithAuth);
    this.#context = {
      api(signal) {
        if (signal === undefined) return unsignaledApi;
        return newApi((input, init) => fetchWithAuth(input, { ...init, signal }));
      },
      request: sandboxRequester(baseUrl, fetchWithAuth, headers),
      retries: resolveRetryOptions(options.retries),
    };
  }

  /** The options this sandbox was constructed with. */
  get options(): SandboxOptions {
    return this.#options;
  }

  /** Name of the sandbox. */
  get name(): string {
    return this.#options.name;
  }

  /** Base URL of the sandbox's execution API. */
  get url(): string {
    return this.#options.url;
  }

  /**
   * The generated client for this sandbox's execution API, for operations
   * this SDK does not wrap.
   *
   * The generated API surface is not covered by stability guarantees and may
   * change between versions.
   */
  get rawApi(): SandboxApiClient {
    return this.#context.api(undefined);
  }

  /** Files and directories in the sandbox. */
  get fs(): SandboxFileSystem {
    return (this.#fs ??= new SandboxFileSystem(this.#context));
  }

  /** Processes in the sandbox. */
  get process(): SandboxProcess {
    return (this.#process ??= new SandboxProcess(this.#context));
  }

  /** Drive mounts in the sandbox. Not implemented yet. */
  get drives() {
    throw new Error("Sandbox.drives is not implemented yet");
  }

  /** Code editing helpers. Not implemented yet. */
  get codegen() {
    throw new Error("Sandbox.codegen is not implemented yet");
  }

  /** Sandbox system operations. Not implemented yet. */
  get system() {
    throw new Error("Sandbox.system is not implemented yet");
  }

  /** Network access to ports in the sandbox. Not implemented yet. */
  get network() {
    throw new Error("Sandbox.network is not implemented yet");
  }
}
