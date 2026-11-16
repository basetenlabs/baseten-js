import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithBearerToken, isTokenRefused, type Token, TokenCache } from "../../src/tokenauth";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const MINUTE_MS = 60_000;

// A cache whose mints issue "token-<n>" valid for lifetimeMs from the time of
// the mint, or as the given mint answers.
function testCache(
  lifetimeMs: number,
  refreshBeforeMs: number,
  mint?: (n: number) => Promise<Token | undefined> | undefined,
): { cache: TokenCache; mints: () => number } {
  let mints = 0;
  const cache = new TokenCache({
    mint: async () => {
      const n = ++mints;
      return (await mint?.(n)) ?? { value: `token-${n}`, expiresAtMs: Date.now() + lifetimeMs };
    },
    refreshBeforeMs,
    mintTimeoutMs: 1000,
    mintName: "test mint",
  });
  return { cache, mints: () => mints };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("TokenCache", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes before expiry", async () => {
    const { cache, mints } = testCache(60 * MINUTE_MS, 5 * MINUTE_MS);
    expect((await cache.token()).value).toBe("token-1");
    vi.setSystemTime(NOW + 55 * MINUTE_MS - 1000);
    expect((await cache.token()).value).toBe("token-1");
    vi.setSystemTime(NOW + 55 * MINUTE_MS);
    expect((await cache.token()).value).toBe("token-2");
    expect(mints()).toBe(2);
  });

  it("caps the refresh margin at half the token's lifetime", async () => {
    // Without the cap, a five-minute margin on a one-minute token would mint
    // on every call.
    const { cache, mints } = testCache(MINUTE_MS, 5 * MINUTE_MS);
    await cache.token();
    vi.setSystemTime(NOW + 29_000);
    await cache.token();
    expect(mints()).toBe(1);
    vi.setSystemTime(NOW + 30_000);
    await cache.token();
    expect(mints()).toBe(2);
  });

  it("returns a token it just minted even if already due", async () => {
    const { cache, mints } = testCache(-MINUTE_MS, MINUTE_MS);
    expect((await cache.token()).value).toBe("token-1");
    expect(mints()).toBe(1);
  });

  it("invalidates only the cached token", async () => {
    const { cache } = testCache(60 * MINUTE_MS, MINUTE_MS);
    await cache.token();
    cache.invalidate("token-0");
    expect((await cache.token()).value).toBe("token-1");
    cache.invalidate("token-1");
    expect((await cache.token()).value).toBe("token-2");
  });

  it("shares one mint across concurrent callers", async () => {
    const release = deferred();
    const { cache, mints } = testCache(60 * MINUTE_MS, MINUTE_MS, async (n) => {
      await release.promise;
      return { value: `token-${n}`, expiresAtMs: Date.now() + 60 * MINUTE_MS };
    });
    const pending = Promise.all([cache.token(), cache.token(), cache.token()]);
    release.resolve();
    expect((await pending).map((t) => t.value)).toEqual(["token-1", "token-1", "token-1"]);
    expect(mints()).toBe(1);
  });

  it("does not cache a failed mint, and gives its waiters one try of their own", async () => {
    const release = deferred();
    const { cache, mints } = testCache(60 * MINUTE_MS, MINUTE_MS, async (n) => {
      if (n === 1) {
        await release.promise;
        throw new Error("mint failed");
      }
      return undefined;
    });
    const first = cache.token();
    const waiter = cache.token();
    release.resolve();
    await expect(first).rejects.toThrow("mint failed");
    expect((await waiter).value).toBe("token-2");
    expect((await cache.token()).value).toBe("token-2");
    expect(mints()).toBe(2);
  });

  it("lets a caller stop waiting without failing the shared mint", async () => {
    const release = deferred();
    const { cache, mints } = testCache(60 * MINUTE_MS, MINUTE_MS, async (n) => {
      await release.promise;
      return { value: `token-${n}`, expiresAtMs: Date.now() + 60 * MINUTE_MS };
    });
    const controller = new AbortController();
    const aborted = cache.token(controller.signal);
    const waiting = cache.token();
    controller.abort(new Error("gave up"));
    await expect(aborted).rejects.toThrow("gave up");
    release.resolve();
    expect((await waiting).value).toBe("token-1");
    expect((await cache.token()).value).toBe("token-1");
    expect(mints()).toBe(1);
  });

  it("times out a mint that ignores its signal", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const { cache } = testCache(60 * MINUTE_MS, MINUTE_MS, (n) =>
      n === 1 ? new Promise<Token>(() => {}) : undefined,
    );
    const stalled = expect(cache.token()).rejects.toThrow("test mint timed out after 1s");
    await vi.advanceTimersByTimeAsync(1000);
    await stalled;
    expect((await cache.token()).value).toBe("token-2");
  });
});

describe("isTokenRefused", () => {
  it.each([
    ["a revoked sandbox token", 401, { "x-blaxel-error-code": "TOKEN_REVOKED" }, true],
    [
      "an invalid_token challenge",
      401,
      { "www-authenticate": 'Bearer realm="baseten", error="invalid_token"' },
      true,
    ],
    ["a plain 401", 401, {}, false],
    ["another challenge", 401, { "www-authenticate": 'Bearer realm="baseten"' }, false],
    ["a 403", 403, { "www-authenticate": 'Bearer error="invalid_token"' }, false],
  ])("reports %s", (_name, status, headers, want) => {
    expect(isTokenRefused(new Response(null, { status, headers }))).toBe(want);
  });
});

describe("fetchWithBearerToken", () => {
  function refused(): Response {
    return new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Bearer error="invalid_token"' },
    });
  }

  // Answers with the next of the given responses, then 204s, recording each
  // request's Authorization.
  function server(...responses: Response[]): { fetch: typeof fetch; sent: string[] } {
    const sent: string[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      sent.push(new Request(input, init).headers.get("authorization") ?? "");
      return responses.shift() ?? new Response(null, { status: 204 });
    };
    return { fetch: fetchImpl as typeof fetch, sent };
  }

  function tokens(): { get: (s?: AbortSignal, r?: string) => Promise<string>; refused: unknown[] } {
    const seen: unknown[] = [];
    let n = 0;
    return {
      get: async (_signal, refusedToken) => {
        seen.push(refusedToken);
        return `token-${++n}`;
      },
      refused: seen,
    };
  }

  it("sends again with a new token, naming the refused one", async () => {
    const s = server(refused());
    const t = tokens();
    const response = await fetchWithBearerToken(
      s.fetch,
      "https://example.com/x",
      { method: "POST", body: "{}", headers: { "X-Custom": "v" } },
      t.get,
      1000,
    );
    expect(response.status).toBe(204);
    expect(s.sent).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(t.refused).toEqual([undefined, "token-1"]);
  });

  it("waits before the second resend, then returns the refusal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const s = server(refused(), refused(), refused(), refused());
      const pending = fetchWithBearerToken(
        s.fetch,
        "https://example.com/x",
        undefined,
        tokens().get,
        1000,
      );
      await vi.advanceTimersByTimeAsync(999);
      expect(s.sent).toEqual(["Bearer token-1", "Bearer token-2"]);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).status).toBe(401);
      expect(s.sent).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send a stream body again", async () => {
    const s = server(refused());
    const response = await fetchWithBearerToken(
      s.fetch,
      "https://example.com/x",
      { method: "POST", body: new Blob(["x"]).stream(), duplex: "half" } as RequestInit,
      tokens().get,
      1000,
    );
    expect(response.status).toBe(401);
    expect(s.sent).toEqual(["Bearer token-1"]);
  });

  it("keeps a Request's own headers", async () => {
    const s = server();
    const request = new Request("https://example.com/x", { headers: { "X-Custom": "v" } });
    let seen: Headers | undefined;
    await fetchWithBearerToken(
      async (input, init) => {
        seen = new Request(input, init).headers;
        return s.fetch(input, init);
      },
      request,
      undefined,
      tokens().get,
      1000,
    );
    expect(seen?.get("x-custom")).toBe("v");
    expect(seen?.get("authorization")).toBe("Bearer token-1");
  });
});
