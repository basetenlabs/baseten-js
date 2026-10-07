import { SandboxClient as SandboxApiClientOwner } from "@basetenlabs/client";
import type { ApiClient as SandboxApiClient } from "@basetenlabs/client/sandboxapi";
import type { SandboxRetryOptions } from "../common";
import { resolveRetryOptions } from "../retry";
import { type SandboxContext, sandboxRequester } from "./context";
import { SandboxFileSystem } from "./fs";
import { SandboxProcess } from "./process";

/** @internal What a {@link SandboxClient} builds a {@link Sandbox} from. */
export interface SandboxOptions {
  /** Empty for a sandbox from {@link SandboxClient.sandboxFromUrl}. */
  name: string;
  url: string;

  /** The client's fetch, which authenticates each request. */
  fetchWithAuth: typeof fetch;
  headers: Record<string, string> | undefined;
  retries: SandboxRetryOptions | undefined;
}

/**
 * One sandbox, reached directly at its own URL.
 *
 * Get one from {@link SandboxClient.create}, {@link SandboxClient.get}, or
 * {@link SandboxClient.sandboxFromUrl}.
 */
export class Sandbox {
  readonly #name: string;
  readonly #url: string;
  readonly #context: SandboxContext;
  #fs?: SandboxFileSystem;
  #process?: SandboxProcess;

  /** @internal Built by {@link SandboxClient}. */
  constructor(options: SandboxOptions) {
    this.#name = options.name;
    this.#url = options.url;
    const { fetchWithAuth, headers } = options;
    const baseUrl = options.url.replace(/\/+$/, "");
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

  /**
   * Name of the sandbox. Empty for a sandbox from
   * {@link SandboxClient.sandboxFromUrl}.
   */
  get name(): string {
    return this.#name;
  }

  /** Base URL of the sandbox's execution API. */
  get url(): string {
    return this.#url;
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
