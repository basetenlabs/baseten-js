import { readFileSync } from "node:fs";
import http2 from "node:http2";
import { createRequire } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Transport, setRequireForTests } from "../src/transport";

const UNDICI_GLOBAL_DISPATCHER_1 = Symbol.for("undici.globalDispatcher.1");
const UNDICI_GLOBAL_DISPATCHER_2 = Symbol.for("undici.globalDispatcher.2");
const globals = globalThis as Record<symbol, unknown>;
const testRequire = createRequire(import.meta.url);

type UndiciCopy = "undici-7" | "undici-8";

// Makes the transport's "undici" resolve to the given installed copy.
function useUndici(copy: UndiciCopy): void {
  setRequireForTests((id) => testRequire(id.replace(/^undici/, copy)));
}

// Makes the transport's requires return these modules, and fail for others.
function useModules(modules: Record<string, () => unknown>): void {
  setRequireForTests((id) => {
    const module = modules[id];
    if (module === undefined) throw new Error(`Cannot find module '${id}'`);
    return module();
  });
}

// Replaces the global fetch, recording the init of each request.
function stubGlobalFetch(): RequestInit[] {
  const inits: RequestInit[] = [];
  vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    inits.push(init ?? {});
    return new Response("ok");
  });
  return inits;
}

function dispatcherOf(init: RequestInit): unknown {
  return (init as { dispatcher?: unknown }).dispatcher;
}

let before1: unknown;
let before2: unknown;

beforeEach(() => {
  before1 = globals[UNDICI_GLOBAL_DISPATCHER_1];
  before2 = globals[UNDICI_GLOBAL_DISPATCHER_2];
});

afterEach(() => {
  setRequireForTests(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  globals[UNDICI_GLOBAL_DISPATCHER_1] = before1;
  globals[UNDICI_GLOBAL_DISPATCHER_2] = before2;
});

describe("Transport", () => {
  it("uses the caller's fetch as given", async () => {
    const inits = stubGlobalFetch();
    useUndici("undici-8");
    const calls: RequestInit[] = [];
    const callerFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("ok");
    }) as typeof fetch;
    await new Transport({ fetch: callerFetch, nodeUndici: true }).fetch("https://example.com", {
      method: "POST",
    });
    expect(calls).toEqual([{ method: "POST" }]);
    expect(inits).toHaveLength(0);
  });

  it("uses the global fetch as it is at request time when HTTP/2 is off", async () => {
    useUndici("undici-8");
    const transport = new Transport({ nodeUndici: false });
    const inits = stubGlobalFetch();
    await transport.fetch("https://example.com");
    expect(inits).toHaveLength(1);
    expect(dispatcherOf(inits[0]!)).toBeUndefined();
  });

  it("ignores nodeUndici outside Node", async () => {
    // Deno reports a Node version too, so this passes for Deno.
    Object.defineProperty(process.versions, "deno", { value: "2.0.0", configurable: true });
    try {
      useUndici("undici-8");
      const inits = stubGlobalFetch();
      await new Transport({ nodeUndici: true }).fetch("https://example.com");
      expect(inits).toHaveLength(1);
      expect(dispatcherOf(inits[0]!)).toBeUndefined();
    } finally {
      delete (process.versions as Record<string, string>).deno;
    }
  });

  it("falls back to the global fetch when undici is not installed", async () => {
    useModules({});
    const inits = stubGlobalFetch();
    await new Transport({}).fetch("https://example.com");
    expect(inits).toHaveLength(1);
    expect(dispatcherOf(inits[0]!)).toBeUndefined();
    await expect(new Transport({ nodeUndici: true }).fetch("https://example.com")).rejects.toThrow(
      "nodeUndici is true, but undici cannot be used: the undici package is not installed",
    );
  });

  it("falls back to the global fetch when undici fails to load", async () => {
    useModules({ "undici/package.json": () => ({ version: "7.19.0" }) });
    const inits = stubGlobalFetch();
    await new Transport({}).fetch("https://example.com");
    expect(dispatcherOf(inits[0]!)).toBeUndefined();
    await expect(new Transport({ nodeUndici: true }).fetch("https://example.com")).rejects.toThrow(
      "nodeUndici is true, but undici cannot be used: the undici package failed to load",
    );
  });

  it("refuses an unsupported undici without loading it", async () => {
    const load = vi.fn(() => ({}));
    useModules({ "undici/package.json": () => ({ version: "6.21.0" }), undici: load });
    const inits = stubGlobalFetch();
    await new Transport({}).fetch("https://example.com");
    expect(dispatcherOf(inits[0]!)).toBeUndefined();
    await expect(new Transport({ nodeUndici: true }).fetch("https://example.com")).rejects.toThrow(
      "nodeUndici is true, but undici cannot be used: undici 6.21.0 is installed, but >=7.19.0 <9 is required",
    );
    expect(load).not.toHaveBeenCalled();
  });
});

describe.each(["undici-7", "undici-8"] as const)("Transport with %s", (undici) => {
  // undici 8 only works with a Node that bundles undici 8 or newer.
  const nodeUndici = process.versions.undici!;
  const usable = undici === "undici-7" || Number(nodeUndici.split(".")[0]) >= 8;
  const sockets = new Set<Socket>();
  let server: http2.Http2SecureServer;
  let origin: string;

  // Echoes the HTTP version and body of each request.
  beforeAll(async () => {
    server = http2.createSecureServer(
      {
        key: readFileSync(new URL("fixtures/localhost-key.pem", import.meta.url)),
        cert: readFileSync(new URL("fixtures/localhost-cert.pem", import.meta.url)),
        allowHTTP1: true,
      },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          res.end(
            JSON.stringify({
              httpVersion: req.httpVersion,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        });
      },
    );
    server.on("secureConnection", (socket: Socket) => sockets.add(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://localhost:${(server.address() as AddressInfo).port}`;
  });

  // Our Agents keep their connections open, so they are cut for close to end.
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    useUndici(undici);
  });

  // Runs first in each copy's block: Node caches undici, so its install of a
  // global dispatcher only happens on its first load.
  it.runIf(usable)("leaves the global dispatchers as they were", async () => {
    stubGlobalFetch();
    await new Transport({ nodeUndici: true }).fetch("https://example.com");
    expect(globals[UNDICI_GLOBAL_DISPATCHER_1]).toBe(before1);
    expect(globals[UNDICI_GLOBAL_DISPATCHER_2]).toBe(before2);
  });

  it.skipIf(usable)("is refused on a Node that bundles an older undici", async () => {
    const inits = stubGlobalFetch();
    await new Transport({}).fetch("https://example.com");
    expect(dispatcherOf(inits[0]!)).toBeUndefined();
    await expect(new Transport({ nodeUndici: true }).fetch("https://example.com")).rejects.toThrow(
      `it needs Node's bundled undici to be 8 or newer, and it is ${nodeUndici}`,
    );
  });

  it.runIf(usable)("sends over HTTP/2 with the body intact", async () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const response = await new Transport({ nodeUndici: true }).fetch(origin, {
      method: "POST",
      body: "hello",
    });
    expect(await response.json()).toEqual({ httpVersion: "2.0", body: "hello" });
  });

  it.runIf(usable)("uses one Agent per transport, reused by every request", async () => {
    const { Agent } = testRequire(undici) as { Agent: new () => object };
    const inits = stubGlobalFetch();
    const transport = new Transport({});
    await transport.fetch("https://example.com");
    await transport.fetch("https://example.com");
    const dispatcher = dispatcherOf(inits[0]!);
    expect(dispatcher).toBeInstanceOf(Agent);
    expect(dispatcherOf(inits[1]!)).toBe(dispatcher);
    await new Transport({}).fetch("https://example.com");
    expect(dispatcherOf(inits[2]!)).not.toBe(dispatcher);
  });

  it.runIf(usable)("treats Node's default Agent as unconfigured", async () => {
    // Node's default comes from its bundled undici, a different Agent class.
    class Agent {}
    globals[UNDICI_GLOBAL_DISPATCHER_1] = new Agent();
    const inits = stubGlobalFetch();
    await new Transport({}).fetch("https://example.com");
    expect(dispatcherOf(inits[0]!)).toBeDefined();
  });

  it.runIf(usable).each([
    ["an older undici", UNDICI_GLOBAL_DISPATCHER_1],
    ["undici 8", UNDICI_GLOBAL_DISPATCHER_2],
  ])("leaves an app's own global dispatcher from %s in charge", async (_, symbol) => {
    class ProxyAgent {}
    class Agent {}
    globals[UNDICI_GLOBAL_DISPATCHER_1] = new Agent();
    globals[symbol] = new ProxyAgent();
    const inits = stubGlobalFetch();
    await new Transport({}).fetch("https://example.com");
    expect(dispatcherOf(inits[0]!)).toBeUndefined();
    await expect(new Transport({ nodeUndici: true }).fetch("https://example.com")).rejects.toThrow(
      "nodeUndici is true, but undici cannot be used: the app has set its own global dispatcher (ProxyAgent)",
    );
  });
});
