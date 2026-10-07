import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenSource, authenticatedFetch } from "../src/auth";

const NOW = Date.parse("2026-01-01T00:00:00Z");

interface MintServer {
  fetch: typeof fetch;
  mints: () => number;
  requests: Request[];
}

// Serves /v1/token, minting "token-1", "token-2", ... each expiring after
// lifetimeMs. A response can be held back or failed per call.
function mintServer(
  options: {
    lifetimeMs?: number;
    respond?: (
      mint: number,
      request: Request,
    ) => Promise<Response | undefined> | Response | undefined;
  } = {},
): MintServer {
  const requests: Request[] = [];
  let mints = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const mint = ++mints;
    const override = await options.respond?.(mint, request);
    if (override !== undefined) return override;
    return Response.json({
      token: `token-${mint}`,
      expires_at: new Date(Date.now() + (options.lifetimeMs ?? 300_000)).toISOString(),
      teams: [],
    });
  };
  return { fetch: fetchImpl as typeof fetch, mints: () => mints, requests };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("TokenSource", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints with the API key and reuses the token", async () => {
    const server = mintServer();
    const tokens = new TokenSource({ apiKey: "test-key", fetch: server.fetch });
    expect(await tokens.token()).toBe("token-1");
    expect(await tokens.token()).toBe("token-1");
    expect(server.mints()).toBe(1);
    const [request] = server.requests;
    expect(request!.method).toBe("POST");
    expect(new URL(request!.url).pathname).toBe("/v1/token");
    expect(request!.headers.get("authorization")).toBe("Api-Key test-key");
    expect(await request!.json()).toEqual({ scopes: ["sandboxes"] });
  });

  it("refreshes within a minute of expiry", async () => {
    const server = mintServer({ lifetimeMs: 120_000 });
    const tokens = new TokenSource({ apiKey: "test-key", fetch: server.fetch });
    expect(await tokens.token()).toBe("token-1");
    vi.setSystemTime(NOW + 59_000);
    expect(await tokens.token()).toBe("token-1");
    vi.setSystemTime(NOW + 60_000);
    expect(await tokens.token()).toBe("token-2");
    expect(server.mints()).toBe(2);
  });

  it("shares one mint across concurrent callers", async () => {
    const release = deferred();
    const server = mintServer({ respond: () => release.promise.then(() => undefined) });
    const tokens = new TokenSource({ apiKey: "test-key", fetch: server.fetch });
    const pending = Promise.all([tokens.token(), tokens.token(), tokens.token()]);
    release.resolve();
    expect(await pending).toEqual(["token-1", "token-1", "token-1"]);
    expect(server.mints()).toBe(1);
  });

  it("mints again after a failed mint", async () => {
    const server = mintServer({
      respond: (mint) => (mint === 1 ? new Response("nope", { status: 500 }) : undefined),
    });
    const tokens = new TokenSource({ apiKey: "test-key", fetch: server.fetch });
    await expect(tokens.token()).rejects.toThrow();
    expect(await tokens.token()).toBe("token-2");
  });

  it("times out a stalled mint and mints again", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const server = mintServer({
      respond: (mint, request) =>
        mint === 1
          ? new Promise((_, reject) => {
              request.signal.addEventListener("abort", () => reject(request.signal.reason));
            })
          : undefined,
    });
    const tokens = new TokenSource({ apiKey: "test-key", fetch: server.fetch });
    const stalled = expect(tokens.token()).rejects.toThrow(
      "sandbox token exchange timed out after 30s",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await stalled;
    expect(await tokens.token()).toBe("token-2");
  });

  it("lets a caller stop waiting without failing the shared mint", async () => {
    const release = deferred();
    const server = mintServer({ respond: () => release.promise.then(() => undefined) });
    const tokens = new TokenSource({ apiKey: "test-key", fetch: server.fetch });
    const controller = new AbortController();
    const aborted = tokens.token(controller.signal);
    const waiting = tokens.token();
    controller.abort(new Error("gave up"));
    await expect(aborted).rejects.toThrow("gave up");
    release.resolve();
    expect(await waiting).toBe("token-1");
    // The abort did not drop the cached token either.
    expect(await tokens.token()).toBe("token-1");
    expect(server.mints()).toBe(1);
  });

  it("calls the token provider on every request", async () => {
    const server = mintServer();
    let calls = 0;
    const tokens = new TokenSource({
      apiKey: "",
      tokenProvider: async () => `provided-${++calls}`,
      fetch: server.fetch,
    });
    expect(await tokens.token()).toBe("provided-1");
    expect(await tokens.token()).toBe("provided-2");
    expect(server.mints()).toBe(0);
  });

  it("lets a caller stop waiting on a token provider", async () => {
    const tokens = new TokenSource({
      apiKey: "",
      tokenProvider: () => new Promise<string>(() => {}),
      fetch: mintServer().fetch,
    });
    const controller = new AbortController();
    const waiting = tokens.token(controller.signal);
    controller.abort(new Error("gave up"));
    await expect(waiting).rejects.toThrow("gave up");
  });

  it("rejects an API key alongside a token provider", () => {
    expect(
      () =>
        new TokenSource({
          apiKey: "test-key",
          tokenProvider: async () => "provided",
          fetch: mintServer().fetch,
        }),
    ).toThrow("apiKey must be empty when tokenProvider is set");
  });

  it("returns no token for an empty API key without a provider", async () => {
    const server = mintServer();
    const tokens = new TokenSource({ apiKey: "", fetch: server.fetch });
    expect(await tokens.token()).toBeUndefined();
    expect(server.mints()).toBe(0);
  });
});

describe("authenticatedFetch", () => {
  function capturingFetch(): { fetch: typeof fetch; headers: () => Headers } {
    let captured: Headers | undefined;
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    };
    return {
      fetch: fetchImpl as typeof fetch,
      headers: () => {
        if (captured === undefined) throw new Error("no request captured");
        return captured;
      },
    };
  }

  it("sends the token as a bearer and keeps other headers", async () => {
    const base = capturingFetch();
    const tokens = new TokenSource({
      apiKey: "",
      tokenProvider: async () => "provided",
      fetch: base.fetch,
    });
    await authenticatedFetch(base.fetch, tokens)("https://example.com/x", {
      headers: { "X-Custom": "v" },
    });
    expect(base.headers().get("authorization")).toBe("Bearer provided");
    expect(base.headers().get("x-custom")).toBe("v");
  });

  function revoked(): Response {
    return Response.json(
      { code: 401, error: "The access token has been revoked" },
      { status: 401, headers: { "x-blaxel-error-code": "TOKEN_REVOKED" } },
    );
  }

  // Mints tokens at /v1/token, and answers other requests with the next of
  // the given responses, then with 204s. Records each request's token.
  function revokingServer(...responses: Response[]): {
    fetch: typeof fetch;
    tokensSent: string[];
  } {
    const tokensSent: string[] = [];
    let mints = 0;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/v1/token") {
        mints++;
        return Response.json({
          token: `token-${mints}`,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          teams: [],
        });
      }
      tokensSent.push(request.headers.get("authorization") ?? "");
      return responses.shift() ?? new Response(null, { status: 204 });
    };
    return { fetch: fetchImpl as typeof fetch, tokensSent };
  }

  it("sends a request again with a new token after revocation", async () => {
    const server = revokingServer(revoked());
    const tokens = new TokenSource({ apiKey: "test-key", fetch: server.fetch });
    const response = await authenticatedFetch(server.fetch, tokens)("https://example.com/x", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    expect(response.status).toBe(204);
    expect(server.tokensSent).toEqual(["Bearer token-1", "Bearer token-2"]);
    // The new token is the one cached from then on.
    expect(await tokens.token()).toBe("token-2");
  });

  it("tells a caching provider which token was revoked", async () => {
    const server = revokingServer(revoked());
    const contexts: { revokedToken?: string }[] = [];
    let cached: string | undefined;
    let mints = 0;
    const tokens = new TokenSource({
      apiKey: "",
      tokenProvider: async (context) => {
        contexts.push(context);
        if (context.revokedToken === cached) cached = undefined;
        return (cached ??= `provided-${++mints}`);
      },
      fetch: server.fetch,
    });
    const response = await authenticatedFetch(server.fetch, tokens)("https://example.com/x");
    expect(response.status).toBe(204);
    expect(server.tokensSent).toEqual(["Bearer provided-1", "Bearer provided-2"]);
    expect(contexts).toEqual([{ revokedToken: undefined }, { revokedToken: "provided-1" }]);
  });

  it("waits a second before the second resend, then returns the revocation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const server = revokingServer(revoked(), revoked(), revoked(), revoked());
      const tokens = new TokenSource({ apiKey: "test-key", fetch: server.fetch });
      const pending = authenticatedFetch(server.fetch, tokens)("https://example.com/x");
      await vi.advanceTimersByTimeAsync(999);
      expect(server.tokensSent).toEqual(["Bearer token-1", "Bearer token-2"]);
      await vi.advanceTimersByTimeAsync(1);
      const response = await pending;
      expect(response.status).toBe(401);
      expect(server.tokensSent).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry other 401s", async () => {
    const server = revokingServer(
      Response.json({ code: 401, error: "Unauthorized" }, { status: 401 }),
      Response.json(
        { error: { code: "AUTHENTICATION_FAILED" } },
        { status: 401, headers: { "x-blaxel-error-code": "AUTHENTICATION_FAILED" } },
      ),
    );
    const tokens = new TokenSource({ apiKey: "test-key", fetch: server.fetch });
    const fetchWithAuth = authenticatedFetch(server.fetch, tokens);
    expect((await fetchWithAuth("https://example.com/x")).status).toBe(401);
    expect((await fetchWithAuth("https://example.com/x")).status).toBe(401);
    expect(server.tokensSent).toEqual(["Bearer token-1", "Bearer token-1"]);
  });

  it("does not send a stream body again", async () => {
    const server = revokingServer(revoked());
    const tokens = new TokenSource({ apiKey: "test-key", fetch: server.fetch });
    const response = await authenticatedFetch(server.fetch, tokens)("https://example.com/x", {
      method: "POST",
      body: new Blob(["stdin"]).stream(),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(401);
    expect(server.tokensSent).toEqual(["Bearer token-1"]);
  });

  it("sends no Authorization without a token", async () => {
    const base = capturingFetch();
    const tokens = new TokenSource({ apiKey: "", fetch: base.fetch });
    await authenticatedFetch(base.fetch, tokens)("https://example.com/x");
    expect(base.headers().has("authorization")).toBe(false);
  });
});
