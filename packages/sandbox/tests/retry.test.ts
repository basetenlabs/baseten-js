import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sandbox, SandboxApiError, SandboxClient, SandboxGatewayError } from "../src/index";
import {
  backoffDelayMs,
  isTransientResetError,
  resolveRetryOptions,
  retryIdempotent,
} from "../src/retry";

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
    const sandbox = new Sandbox({
      name: "sb-1",
      url: "https://sbx-sb-1.b10.run",
      fetch: flaky.fetch,
    });
    const read = sandbox.fs.read({ path: "/tmp/x" });
    await vi.runAllTimersAsync();
    expect(await read).toBe("hello");
    expect(flaky.calls()).toBe(3);
  });

  it("honors a zero read budget", async () => {
    const flaky = flakyFetch(1, { path: "/tmp/x", content: "hello" });
    const sandbox = new Sandbox({
      name: "sb-1",
      url: "https://sbx-sb-1.b10.run",
      fetch: flaky.fetch,
      retries: { readMaxRetries: 0 },
    });
    await expect(sandbox.fs.read({ path: "/tmp/x" })).rejects.toThrow("fetch failed");
    expect(flaky.calls()).toBe(1);
  });

  it("retries a file write on the upload budget", async () => {
    const flaky = flakyFetch(3, { message: "ok" });
    const sandbox = new Sandbox({
      name: "sb-1",
      url: "https://sbx-sb-1.b10.run",
      fetch: flaky.fetch,
    });
    const write = sandbox.fs.write({ path: "/tmp/x", content: "hello" });
    await vi.runAllTimersAsync();
    await write;
    expect(flaky.calls()).toBe(4);
  });

  it("honors a zero upload budget", async () => {
    const flaky = flakyFetch(1, { message: "ok" });
    const sandbox = new Sandbox({
      name: "sb-1",
      url: "https://sbx-sb-1.b10.run",
      fetch: flaky.fetch,
      retries: { uploadMaxRetries: 0 },
    });
    await expect(sandbox.fs.write({ path: "/tmp/x", content: "hello" })).rejects.toThrow(
      "fetch failed",
    );
    expect(flaky.calls()).toBe(1);
  });

  it("never retries a file removal", async () => {
    const flaky = flakyFetch(1, { message: "ok" });
    const sandbox = new Sandbox({
      name: "sb-1",
      url: "https://sbx-sb-1.b10.run",
      fetch: flaky.fetch,
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
