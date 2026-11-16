import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AccessTokenSource, bearerAuthFetch } from "../../src/credentials";
import { InferenceClient } from "../../src/inference";
import { ManagementClient } from "../../src/management";
import {
  InvalidGrantError,
  WorkloadIdentityCredentials,
  type WorkloadIdentityCredentialsOptions,
} from "../../src/workloadIdentity";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const BASE_URL = "https://api.example.com";
const ORGANIZATION = {
  org_id: "o",
  created_at: "2026-01-01T00:00:00Z",
  allow_personal_api_keys: true,
  allow_service_account_api_keys: true,
};

// A stand-in for Baseten: POST /v1/auth/token issues "access-<n>" for the nth
// exchange and records each assertion; other paths record the Authorization
// they were sent and answer with the given handler, or an organization.
function fakeBaseten(
  options: {
    expiresIn?: number;
    exchange?: (n: number) => Response | Promise<Response | undefined> | undefined;
    api?: (authorization: string) => Response | undefined;
  } = {},
): { fetch: typeof fetch; exchanges: () => number; assertions: string[]; seenAuth: string[] } {
  const assertions: string[] = [];
  const seenAuth: string[] = [];
  let exchanges = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const authorization = request.headers.get("authorization") ?? "";
    if (new URL(request.url).pathname === "/v1/auth/token") {
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(authorization).toBe("");
      const body = (await request.json()) as Record<string, string>;
      expect(body).toEqual({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: body.subject_token,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        audience: "rule-1",
      });
      assertions.push(body.subject_token!);
      const n = ++exchanges;
      const override = await options.exchange?.(n);
      if (override !== undefined) return override;
      return Response.json({
        access_token: `access-${n}`,
        token_type: "Bearer",
        expires_in: options.expiresIn ?? 3600,
      });
    }
    seenAuth.push(authorization);
    return options.api?.(authorization) ?? Response.json(ORGANIZATION);
  };
  return { fetch: fetchImpl as typeof fetch, exchanges: () => exchanges, assertions, seenAuth };
}

function credentials(
  server: { fetch: typeof fetch },
  options: Partial<WorkloadIdentityCredentialsOptions> = {},
): WorkloadIdentityCredentials {
  return new WorkloadIdentityCredentials({
    trustRuleId: "rule-1",
    baseUrl: BASE_URL,
    fetch: server.fetch,
    ...(options.identityTokenFile === undefined && { identityToken: () => "idp-jwt" }),
    ...options,
  });
}

describe("WorkloadIdentityCredentials", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exchanges the identity token and caches the access token", async () => {
    const server = fakeBaseten();
    const creds = credentials(server);
    const token = await creds.accessToken();
    expect(token).toEqual({ token: "access-1", expiresAt: new Date(NOW + 3600_000) });
    expect((await creds.accessToken()).token).toBe("access-1");
    expect(server.exchanges()).toBe(1);
    expect(server.assertions).toEqual(["idp-jwt"]);
  });

  it("refreshes five minutes before expiry by default", async () => {
    const server = fakeBaseten();
    const creds = credentials(server);
    await creds.accessToken();
    vi.setSystemTime(NOW + 55 * 60_000 - 1);
    expect((await creds.accessToken()).token).toBe("access-1");
    vi.setSystemTime(NOW + 55 * 60_000);
    expect((await creds.accessToken()).token).toBe("access-2");
  });

  it("caps the refresh margin at half the token's lifetime", async () => {
    const server = fakeBaseten({ expiresIn: 60 });
    const creds = credentials(server, { refreshBeforeExpiryMs: 10 * 60_000 });
    await creds.accessToken();
    vi.setSystemTime(NOW + 29_000);
    expect((await creds.accessToken()).token).toBe("access-1");
    vi.setSystemTime(NOW + 30_000);
    expect((await creds.accessToken()).token).toBe("access-2");
  });

  it("re-reads the identity token file on every exchange", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wif-"));
    try {
      const file = join(dir, "token");
      writeFileSync(file, "jwt-1\n");
      const server = fakeBaseten();
      const creds = credentials(server, { identityTokenFile: file });
      await creds.accessToken();
      writeFileSync(file, "jwt-2");
      creds.invalidateAccessToken("access-1");
      expect((await creds.accessToken()).token).toBe("access-2");
      expect(server.assertions).toEqual(["jwt-1", "jwt-2"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("reports an unreadable or empty identity token file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wif-"));
    try {
      const server = fakeBaseten();
      await expect(
        credentials(server, { identityTokenFile: join(dir, "missing") }).accessToken(),
      ).rejects.toThrow("reading identity token file");
      const empty = join(dir, "empty");
      writeFileSync(empty, " \n");
      await expect(credentials(server, { identityTokenFile: empty }).accessToken()).rejects.toThrow(
        "the file is empty",
      );
      expect(server.exchanges()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("explains an invalid_grant refusal", async () => {
    const server = fakeBaseten({
      exchange: () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    const err = await credentials(server)
      .accessToken()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidGrantError);
    expect((err as InvalidGrantError).trustRuleId).toBe("rule-1");
    expect((err as Error).message).toContain("trust rule rule-1");
  });

  it("reports a non-JSON response", async () => {
    const server = fakeBaseten({
      exchange: () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    await expect(credentials(server).accessToken()).rejects.toThrow(
      "HTTP 502 with a non-JSON response: <html>bad gateway</html>",
    );
  });

  it("reports another error status", async () => {
    const server = fakeBaseten({
      exchange: () => Response.json({ error: "server_error" }, { status: 500 }),
    });
    await expect(credentials(server).accessToken()).rejects.toThrow(
      'HTTP 500: {"error":"server_error"}',
    );
  });

  it.each([
    ["no access_token", { token_type: "Bearer", expires_in: 60 }, "no access_token"],
    ["a non-bearer type", { access_token: "a", token_type: "mac", expires_in: 60 }, "token_type"],
    ["no expiry", { access_token: "a", token_type: "Bearer", expires_in: 0 }, "expires_in"],
  ])("rejects a success with %s", async (_name, body, message) => {
    const server = fakeBaseten({ exchange: () => Response.json(body) });
    await expect(credentials(server).accessToken()).rejects.toThrow(message);
  });

  it("shares one exchange across concurrent callers", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const server = fakeBaseten({ exchange: () => released.then(() => undefined) });
    const creds = credentials(server);
    const pending = Promise.all([creds.accessToken(), creds.accessToken(), creds.accessToken()]);
    release();
    expect((await pending).map((t) => t.token)).toEqual(["access-1", "access-1", "access-1"]);
    expect(server.exchanges()).toBe(1);
  });

  it("lets a waiter stop waiting", async () => {
    const server = fakeBaseten({ exchange: () => new Promise<Response>(() => {}) });
    const creds = credentials(server);
    const controller = new AbortController();
    const waiting = creds.accessToken({ signal: controller.signal });
    controller.abort(new Error("gave up"));
    await expect(waiting).rejects.toThrow("gave up");
  });

  it("times out a stalled exchange", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const server = fakeBaseten({ exchange: () => new Promise<Response>(() => {}) });
    const stalled = expect(credentials(server).accessToken()).rejects.toThrow(
      "workload identity token exchange timed out after 10s",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await stalled;
  });

  it.each<[string, Partial<WorkloadIdentityCredentialsOptions>, string]>([
    ["no identity token", { identityToken: undefined }, "exactly one of"],
    [
      "both identity tokens",
      { identityTokenFile: "/f", identityToken: () => "j" },
      "exactly one of",
    ],
    ["no trust rule", { trustRuleId: "" }, "trustRuleId is required"],
    ["a negative margin", { refreshBeforeExpiryMs: -1 }, "must not be negative"],
  ])("rejects %s", (_name, options, message) => {
    expect(
      () =>
        new WorkloadIdentityCredentials({
          trustRuleId: "rule-1",
          identityToken: () => "jwt",
          ...options,
        }),
    ).toThrow(message);
  });
});

describe("clients with credentials", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("send a fresh bearer token on every request", async () => {
    const server = fakeBaseten({ expiresIn: 600 });
    const creds = credentials(server);
    const management = new ManagementClient({
      credentials: creds,
      baseUrlOverride: BASE_URL,
      fetch: server.fetch,
    });
    await management.api.getOrganizationsMe();
    vi.setSystemTime(NOW + 3600_000);
    await management.api.getOrganizationsMe();
    const inference = new InferenceClient({
      credentials: creds,
      baseUrlOverride: BASE_URL,
      fetch: server.fetch,
    });
    await inference.api.getAsyncQueueStatusProduction();
    expect(server.seenAuth).toEqual(["Bearer access-1", "Bearer access-2", "Bearer access-2"]);
  });

  function refusingServer() {
    return fakeBaseten({
      api: (authorization) =>
        authorization === "Bearer access-1"
          ? new Response(null, {
              status: 401,
              headers: { "www-authenticate": 'Bearer realm="baseten", error="invalid_token"' },
            })
          : undefined,
    });
  }

  it("resend a refused token for a source that can invalidate it", async () => {
    const server = refusingServer();
    const management = new ManagementClient({
      credentials: credentials(server),
      baseUrlOverride: BASE_URL,
      fetch: server.fetch,
    });
    await management.api.getOrganizationsMe();
    expect(server.seenAuth).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  it("send once for a source that cannot invalidate", async () => {
    const server = refusingServer();
    const source: AccessTokenSource = {
      accessToken: async () => ({ token: "access-1", expiresAt: new Date(NOW + 3600_000) }),
    };
    const management = new ManagementClient({
      credentials: source,
      baseUrlOverride: BASE_URL,
      fetch: server.fetch,
    });
    await expect(management.api.getOrganizationsMe()).rejects.toThrow();
    expect(server.seenAuth).toEqual(["Bearer access-1"]);
  });

  it("leave requests to other origins alone", async () => {
    const seen: (string | null)[] = [];
    const source: AccessTokenSource = {
      accessToken: async () => {
        throw new Error("token fetched for a foreign origin");
      },
    };
    const clientFetch = bearerAuthFetch(
      async (input, init) => {
        seen.push(new Request(input, init).headers.get("authorization"));
        return new Response(null, { status: 204 });
      },
      source,
      BASE_URL,
    );
    await clientFetch("https://storage.example.com/upload");
    await clientFetch("https://api.example.com:8443/v1/x");
    expect(seen).toEqual([null, null]);
  });

  it.each<[string, object, string]>([
    ["both", { apiKey: "k", credentials: { accessToken: async () => ({}) } }, "mutually exclusive"],
    ["neither", {}, "one of apiKey or credentials is required"],
    [
      "an Authorization header with credentials",
      { credentials: { accessToken: async () => ({}) }, headers: { authorization: "x" } },
      "must not set Authorization",
    ],
  ])("reject %s", (_name, options, message) => {
    expect(() => new ManagementClient(options)).toThrow(message);
    expect(() => new InferenceClient({ modelId: "m", ...options })).toThrow(message);
  });

  it("keep sending the API key as before", async () => {
    const server = fakeBaseten();
    const management = new ManagementClient({
      apiKey: "test-key",
      baseUrlOverride: BASE_URL,
      fetch: server.fetch,
    });
    await management.api.getOrganizationsMe();
    expect(server.seenAuth).toEqual(["Api-Key test-key"]);
  });
});
