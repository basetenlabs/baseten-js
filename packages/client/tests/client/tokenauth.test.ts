import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Token, TokenCache } from "../../src/tokenauth";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const MINUTE_MS = 60_000;

// A cache whose mints issue "token-<n>" valid for lifetimeMs from the time of
// the mint, or as the given mint answers.
function testCache(
  lifetimeMs: number,
  refreshLeewayMs: number,
  mint?: (n: number) => Promise<Token | undefined> | undefined,
): { cache: TokenCache; mints: () => number } {
  let mints = 0;
  const cache = new TokenCache({
    mint: async () => {
      const n = ++mints;
      return (await mint?.(n)) ?? { value: `token-${n}`, expiresAtMs: Date.now() + lifetimeMs };
    },
    refreshLeewayMs,
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

  it("bounds the mints of callers waiting on a mint that keeps failing", async () => {
    const release = deferred();
    const { cache, mints } = testCache(60 * MINUTE_MS, MINUTE_MS, async () => {
      await release.promise;
      throw new Error("mint failed");
    });
    const pending = Array.from({ length: 5 }, () => cache.token());
    release.resolve();
    for (const result of await Promise.allSettled(pending)) {
      expect(result.status).toBe("rejected");
    }
    // The first mint, then one more that every waiter joins.
    expect(mints()).toBe(2);
  });

  describe("when a refresh fails", () => {
    // Mints succeed until failing is set.
    function failingCache(): { cache: TokenCache; fail: (failing: boolean) => void } {
      let failing = false;
      const { cache } = testCache(60 * MINUTE_MS, 5 * MINUTE_MS, async () => {
        if (failing) throw new Error("mint failed");
        return undefined;
      });
      return { cache, fail: (f) => (failing = f) };
    }

    it("falls back to the replaced token while it is unexpired", async () => {
      const { cache, fail } = failingCache();
      expect((await cache.token()).value).toBe("token-1");
      fail(true);
      vi.setSystemTime(NOW + 56 * MINUTE_MS);
      expect((await cache.token()).value).toBe("token-1");
      fail(false);
      expect((await cache.token()).value).toBe("token-3");
    });

    it("does not fall back to the replaced token once it expired", async () => {
      const { cache, fail } = failingCache();
      await cache.token();
      fail(true);
      vi.setSystemTime(NOW + 56 * MINUTE_MS);
      expect((await cache.token()).value).toBe("token-1");
      vi.setSystemTime(NOW + 60 * MINUTE_MS);
      await expect(cache.token()).rejects.toThrow("mint failed");
    });

    it("does not fall back to an invalidated token", async () => {
      const { cache, fail } = failingCache();
      await cache.token();
      fail(true);
      vi.setSystemTime(NOW + 56 * MINUTE_MS);
      expect((await cache.token()).value).toBe("token-1");
      cache.invalidate("token-1");
      await expect(cache.token()).rejects.toThrow("mint failed");
    });
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
