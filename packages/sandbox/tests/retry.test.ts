import { readFileSync } from "node:fs";
import http2 from "node:http2";
import { createRequire } from "node:module";
import net, { type AddressInfo, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxApiError, SandboxClient, SandboxGatewayError } from "../src/index";
import {
  backoffDelayMs,
  isTransientResetError,
  resolveRetryOptions,
  retryIdempotent,
} from "../src/retry";
import { setRequireForTests, Transport } from "../src/transport";

const testRequire = createRequire(import.meta.url);

function reset(): Error {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

function gateway(): SandboxGatewayError {
  return new SandboxGatewayError(503, "unavailable");
}

// Calls fn, failing with each given error in turn, then returning "ok".
function failing(...errors: unknown[]): { fn: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    fn: async () => {
      const err = errors[calls++];
      if (err !== undefined) throw err;
      return "ok";
    },
    calls: () => calls,
  };
}

describe("isTransientResetError", () => {
  it("matches a transient code anywhere in the cause chain", () => {
    expect(isTransientResetError(reset())).toBe(true);
    const wrapped = new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    expect(isTransientResetError(wrapped)).toBe(true);
  });

  it("matches an HTTP/2 reset in the message", () => {
    expect(isTransientResetError(new Error("stream closed with NGHTTP2_INTERNAL_ERROR"))).toBe(
      true,
    );
    expect(isTransientResetError(new Error("received GOAWAY"))).toBe(true);
  });

  it("rejects failures that are not resets", () => {
    expect(isTransientResetError(new TypeError("fetch failed"))).toBe(false);
    expect(isTransientResetError(new Error("INTERNAL_ERROR"))).toBe(false);
    expect(isTransientResetError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isTransientResetError("ECONNRESET")).toBe(false);
  });

  it("rejects a server response even when it mentions a reset", () => {
    expect(isTransientResetError(new SandboxApiError(500, { error: "GOAWAY" }))).toBe(false);
  });
});

// Real failures on real connections, through each transport a sandbox's
// requests can go through on Node, since each reports the same failure
// differently.
describe.each([
  ["Node's fetch", false],
  ["undici", true],
] as const)("isTransientResetError on real connections through %s", (_, nodeUndici) => {
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    // The HTTP/2 servers use a self-signed certificate.
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    // undici 7 works on every supported Node, unlike undici 8.
    setRequireForTests((id) => testRequire(id.replace(/^undici/, "undici-7")));
  });

  afterEach(async () => {
    setRequireForTests(undefined);
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  // Listens on a free local port, closed with every connection when the test
  // ends, since the transports keep theirs open.
  async function listen(server: net.Server): Promise<number> {
    const sockets = new Set<Socket>();
    server.on("connection", (socket: Socket) => sockets.add(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    return (server.address() as AddressInfo).port;
  }

  // An HTTP/2 server handling each request stream with onStream.
  async function http2Server(onStream: (stream: http2.ServerHttp2Stream) => void): Promise<string> {
    const server = http2.createSecureServer({
      key: readFileSync(new URL("fixtures/localhost-key.pem", import.meta.url)),
      cert: readFileSync(new URL("fixtures/localhost-cert.pem", import.meta.url)),
    });
    server.on("stream", (stream: http2.ServerHttp2Stream) => {
      // Breaking the stream is the point, so its own error is expected.
      stream.on("error", () => {});
      onStream(stream);
    });
    return `https://localhost:${await listen(server)}`;
  }

  // A plain TCP server handing each connection to onRequest once a request
  // arrives on it.
  async function socketServer(onRequest: (socket: Socket) => void): Promise<string> {
    const server = net.createServer((socket) => socket.once("data", () => onRequest(socket)));
    return `http://127.0.0.1:${await listen(server)}`;
  }

  // Sends a request through a new transport and reads its body, returning
  // what it fails with.
  async function requestError(url: string, init?: RequestInit): Promise<unknown> {
    try {
      await (await new Transport({ nodeUndici }).fetch(url, init)).text();
    } catch (err) {
      return err;
    }
    throw new Error(`request to ${url} succeeded`);
  }

  // The error and its causes, for a failure message that shows what was seen.
  function describeError(err: unknown): string {
    const parts: string[] = [];
    for (let current = err; typeof current === "object" && current !== null;) {
      const node = current as {
        name?: unknown;
        code?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      parts.push(`${String(node.name)} ${String(node.code)} ${String(node.message)}`);
      current = node.cause;
    }
    return parts.join(" <- ");
  }

  async function expectTransient(url: string): Promise<void> {
    const err = await requestError(url);
    expect(isTransientResetError(err), describeError(err)).toBe(true);
  }

  // Node's own fetch speaks HTTP/2 only from Node 26 on.
  const http2Capable = nodeUndici || Number(process.versions.node.split(".")[0]) >= 26;

  // Each HTTP/2 case also checks the request reached the server over HTTP/2,
  // so a failure to connect at all cannot pass for it.
  it.runIf(http2Capable)("classifies an HTTP/2 stream reset as transient", async () => {
    let reached = false;
    const url = await http2Server((stream) => {
      reached = true;
      stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    });
    await expectTransient(url);
    expect(reached).toBe(true);
  });

  it.runIf(http2Capable)(
    "classifies an HTTP/2 connection dropped mid-request as transient",
    async () => {
      let reached = false;
      const url = await http2Server((stream) => {
        reached = true;
        stream.session?.destroy();
      });
      await expectTransient(url);
      expect(reached).toBe(true);
    },
  );

  it("classifies a connection closed before the response as transient", async () => {
    await expectTransient(await socketServer((socket) => socket.end()));
  });

  it("classifies a connection closed mid-body as transient", async () => {
    await expectTransient(
      await socketServer((socket) =>
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial"),
      ),
    );
  });

  it("classifies a connection reset as transient", async () => {
    await expectTransient(await socketServer((socket) => socket.resetAndDestroy()));
  });

  it("classifies a refused connection as transient", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    await expectTransient(`http://127.0.0.1:${port}`);
  });

  it("does not classify a canceled request as transient", async () => {
    const url = await socketServer(() => {});
    const err = await requestError(url, { signal: AbortSignal.abort() });
    expect(isTransientResetError(err), describeError(err)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("doubles up to the maximum, plus under one base of jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect([1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, 200, 2000))).toEqual([
      200, 400, 800, 1600, 2000,
    ]);
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    expect(backoffDelayMs(1, 200, 2000)).toBe(399);
  });
});

describe("resolveRetryOptions", () => {
  it("fills in the defaults and keeps given budgets, including zero", () => {
    expect(resolveRetryOptions()).toEqual({
      readMaxRetries: 5,
      gatewayMaxRetries: 2,
      uploadMaxRetries: 3,
    });
    expect(resolveRetryOptions({ readMaxRetries: 0 }).readMaxRetries).toBe(0);
  });
});

describe("retryIdempotent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Runs the call to completion, firing backoff timers as they come due.
  async function settle<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    return promise;
  }

  it("retries resets until one succeeds", async () => {
    const call = failing(reset(), reset());
    expect(await settle(retryIdempotent(call.fn, { maxRetries: 5, gatewayMaxRetries: 2 }))).toBe(
      "ok",
    );
    expect(call.calls()).toBe(3);
  });

  it("gives up after the reset budget", async () => {
    const call = failing(reset(), reset(), reset());
    await expect(
      settle(retryIdempotent(call.fn, { maxRetries: 2, gatewayMaxRetries: 2 })),
    ).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(call.calls()).toBe(3);
  });

  it("keeps gateway errors on their own budget", async () => {
    const call = failing(gateway(), reset(), gateway(), reset());
    expect(await settle(retryIdempotent(call.fn, { maxRetries: 2, gatewayMaxRetries: 2 }))).toBe(
      "ok",
    );
    const exhausted = failing(gateway(), reset(), gateway(), gateway());
    await expect(
      settle(retryIdempotent(exhausted.fn, { maxRetries: 5, gatewayMaxRetries: 2 })),
    ).rejects.toBeInstanceOf(SandboxGatewayError);
    expect(exhausted.calls()).toBe(4);
  });

  it("does not retry other errors", async () => {
    for (const err of [new SandboxApiError(500, {}), new Error("boom")]) {
      const call = failing(err);
      await expect(
        settle(retryIdempotent(call.fn, { maxRetries: 5, gatewayMaxRetries: 2 })),
      ).rejects.toBe(err);
      expect(call.calls()).toBe(1);
    }
  });

  it("stops waiting to retry once aborted", async () => {
    const controller = new AbortController();
    const call = failing(reset());
    const pending = retryIdempotent(call.fn, {
      maxRetries: 5,
      gatewayMaxRetries: 2,
      signal: controller.signal,
    });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("gave up"));
    await expect(pending).rejects.toThrow("gave up");
    expect(call.calls()).toBe(1);
  });
});

describe("retries in the SDK", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Fails the first failures requests with a reset, then answers with body.
  function flakyFetch(
    failures: number,
    body: unknown,
  ): { fetch: typeof fetch; calls: () => number } {
    let calls = 0;
    const fetchImpl = async () => {
      if (calls++ < failures) throw new TypeError("fetch failed", { cause: reset() });
      return Response.json(body);
    };
    return { fetch: fetchImpl as typeof fetch, calls: () => calls };
  }

  it("retries a file read on the read budget", async () => {
    const flaky = flakyFetch(2, { path: "/tmp/x", content: "hello" });
    const sandbox = new SandboxClient({ apiKey: "", fetch: flaky.fetch }).sandboxFromUrl({
      url: "https://sbx-sb-1.b10.run",
    });
    const read = sandbox.fs.read({ path: "/tmp/x" });
    await vi.runAllTimersAsync();
    expect(await read).toBe("hello");
    expect(flaky.calls()).toBe(3);
  });

  it("honors a zero read budget", async () => {
    const flaky = flakyFetch(1, { path: "/tmp/x", content: "hello" });
    const sandbox = new SandboxClient({
      apiKey: "",
      fetch: flaky.fetch,
      retries: { readMaxRetries: 0 },
    }).sandboxFromUrl({ url: "https://sbx-sb-1.b10.run" });
    await expect(sandbox.fs.read({ path: "/tmp/x" })).rejects.toThrow("fetch failed");
    expect(flaky.calls()).toBe(1);
  });

  it("retries a file write on the upload budget", async () => {
    const flaky = flakyFetch(3, { message: "ok" });
    const sandbox = new SandboxClient({ apiKey: "", fetch: flaky.fetch }).sandboxFromUrl({
      url: "https://sbx-sb-1.b10.run",
    });
    const write = sandbox.fs.write({ path: "/tmp/x", content: "hello" });
    await vi.runAllTimersAsync();
    await write;
    expect(flaky.calls()).toBe(4);
  });

  it("honors a zero upload budget", async () => {
    const flaky = flakyFetch(1, { message: "ok" });
    const sandbox = new SandboxClient({
      apiKey: "",
      fetch: flaky.fetch,
      retries: { uploadMaxRetries: 0 },
    }).sandboxFromUrl({ url: "https://sbx-sb-1.b10.run" });
    await expect(sandbox.fs.write({ path: "/tmp/x", content: "hello" })).rejects.toThrow(
      "fetch failed",
    );
    expect(flaky.calls()).toBe(1);
  });

  it("never retries a file removal", async () => {
    const flaky = flakyFetch(1, { message: "ok" });
    const sandbox = new SandboxClient({ apiKey: "", fetch: flaky.fetch }).sandboxFromUrl({
      url: "https://sbx-sb-1.b10.run",
    });
    await expect(sandbox.fs.remove({ path: "/tmp/x" })).rejects.toThrow("fetch failed");
    expect(flaky.calls()).toBe(1);
  });

  it("never retries the control plane", async () => {
    const flaky = flakyFetch(1, {});
    const client = new SandboxClient({
      apiKey: "",
      tokenProvider: async () => "provided",
      fetch: flaky.fetch,
    });
    await expect(client.getInfo({ name: "sb-1" })).rejects.toThrow("fetch failed");
    expect(flaky.calls()).toBe(1);
  });
});
