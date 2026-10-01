import { describe, expect, it } from "vitest";
import {
  Sandbox,
  SandboxApiError,
  SandboxClient,
  SandboxCreateResult,
  type SandboxInfo,
} from "../src/index";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | null;
  body: unknown;
}

// Serves /v1/token, minting "token-1", "token-2", ..., and hands every other
// request to route. Records every request but the mints.
function fakeServer(route: (request: Recorded) => unknown): {
  fetch: typeof fetch;
  requests: Recorded[];
  mints: () => number;
} {
  const requests: Recorded[] = [];
  let mints = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/v1/token") {
      mints++;
      return Response.json({
        token: `token-${mints}`,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        teams: [],
      });
    }
    const text = await request.text();
    const recorded: Recorded = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      authorization: request.headers.get("authorization"),
      body: text === "" ? undefined : JSON.parse(text),
    };
    requests.push(recorded);
    const routed = route(recorded);
    if (routed instanceof Response) return routed;
    // The spec's success codes: create is 201 and delete is 202.
    const status = { POST: 201, DELETE: 202 }[request.method] ?? 200;
    return Response.json(routed, { status });
  };
  return { fetch: fetchImpl as typeof fetch, requests, mints: () => mints };
}

function apiSandbox(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    url: `https://sbx-${name}.b10.run`,
    status: "DEPLOYED",
    enabled: true,
    created_at: "2026-09-16T21:26:58Z",
    ...extra,
  };
}

describe("SandboxClient", () => {
  it("creates with nothing set, leaving defaults to the server", async () => {
    const server = fakeServer(() => apiSandbox("sb-1", { status: "DEPLOYING" }));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const created = await client.create();
    expect(created).toBeInstanceOf(SandboxCreateResult);
    expect(created).toBeInstanceOf(Sandbox);
    expect(created.name).toBe("sb-1");
    expect(created.url).toBe("https://sbx-sb-1.b10.run");
    expect(created.info.status).toBe("DEPLOYING");
    const [request] = server.requests;
    expect(request!.method).toBe("POST");
    expect(request!.path).toBe("/v1/sandboxes/instances");
    expect(request!.authorization).toBe("Bearer token-1");
    expect(request!.body).toEqual({});
  });

  it("creates with every field mapped", async () => {
    const server = fakeServer(() => apiSandbox("sb-1"));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    await client.create({
      name: "sb-1",
      image: "custom:1",
      memory: 2048,
      region: "us-pdx-1",
      envs: { PLAIN: { value: "a" }, HIDDEN: { value: "b", secret: true } },
      labels: { team: "eng" },
      createIfNotExists: true,
      externalId: "ext-1",
      lifecycle: {
        expirationPolicies: [
          { type: "TTL_IDLE", afterMs: 86_400_000 },
          { type: "TTL_MAX_AGE", afterMs: 1500.4, action: "DELETE" },
          { type: "DATE", at: new Date("2026-09-23T21:26:58Z") },
        ],
        terminatedRetentionMs: 3_600_000,
      },
      ports: [{ target: 3000, name: "http", protocol: "HTTP" }, { target: 9000 }],
      network: {
        subnet: "default",
        proxy: {
          allowedDomains: ["*.example.com"],
          forbiddenDomains: ["bad.example.com"],
          bypass: ["direct.example.com"],
          routing: [
            {
              destinations: ["*"],
              headers: { "x-a": "{{SECRET:a}}" },
              body: { b: "c" },
              secrets: { a: "s" },
            },
          ],
        },
      },
    });
    expect(server.requests[0]!.body).toEqual({
      name: "sb-1",
      image: "custom:1",
      memory: 2048,
      region: "us-pdx-1",
      envs: [
        { name: "PLAIN", value: "a" },
        { name: "HIDDEN", value: "b", secret: true },
      ],
      labels: { team: "eng" },
      create_if_not_exists: true,
      external_id: "ext-1",
      lifecycle: {
        expiration_policies: [
          { type: "TTL_IDLE", action: "DELETE", value: "86400000ms" },
          { type: "TTL_MAX_AGE", action: "DELETE", value: "1500ms" },
          { type: "DATE", action: "DELETE", value: "2026-09-23T21:26:58.000Z" },
        ],
        terminated_retention: "3600000ms",
      },
      ports: [{ target: 3000, name: "http", protocol: "HTTP" }, { target: 9000 }],
      network: {
        subnet: "default",
        proxy: {
          allowed_domains: ["*.example.com"],
          forbidden_domains: ["bad.example.com"],
          bypass: ["direct.example.com"],
          routing: [
            {
              destinations: ["*"],
              headers: { "x-a": "{{SECRET:a}}" },
              body: { b: "c" },
              secrets: { a: "s" },
            },
          ],
        },
      },
    });
  });

  it("sends team_id on every call when set", async () => {
    const server = fakeServer((request) =>
      request.method === "GET" && request.path === "/v1/sandboxes/instances"
        ? { items: [], pagination: { has_more: false } }
        : apiSandbox("sb-1"),
    );
    const client = new SandboxClient({ apiKey: "test-key", teamId: "team-1", fetch: server.fetch });
    await client.create({ name: "sb-1" });
    await client.getInfo({ name: "sb-1" });
    for await (const _ of client.list()) {
      // Drained for the request only.
    }
    await client.update({ name: "sb-1", enabled: false });
    await client.delete({ name: "sb-1" });
    expect(server.requests.map((r) => r.query.get("team_id"))).toEqual([
      "team-1",
      "team-1",
      "team-1",
      "team-1",
      "team-1",
    ]);
  });

  it("omits team_id when unset", async () => {
    const server = fakeServer(() => apiSandbox("sb-1"));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    await client.getInfo({ name: "sb-1" });
    expect(server.requests[0]!.query.has("team_id")).toBe(false);
  });

  it("maps the sandbox record", async () => {
    const server = fakeServer(() =>
      apiSandbox("sb-1", {
        state: "RUNNING",
        image: "blaxel/base-image:latest",
        memory: 4096,
        region: "us-pdx-1",
        envs: [
          { name: "PLAIN", value: "a", secret: false },
          { name: "HIDDEN", secret: true },
        ],
        labels: { team: "eng" },
        external_id: "ext-1",
        lifecycle: {
          expiration_policies: [
            { type: "TTL_IDLE", action: "DELETE", value: "24h" },
            { type: "TTL_MAX_AGE", action: "DELETE", value: "7d" },
            { type: "DATE", action: "DELETE", value: "2026-09-23T21:26:58Z" },
          ],
          terminated_retention: "1h30m",
        },
        ports: [{ target: 3000, name: "http", protocol: "HTTP" }, { target: 9000 }],
        network: {
          subnet: "default",
          proxy: {
            allowed_domains: ["*.example.com"],
            forbidden_domains: ["bad.example.com"],
            bypass: ["direct.example.com"],
            routing: [
              { destinations: ["*"], headers: { "x-a": "{{SECRET:a}}" }, body: { b: "c" } },
            ],
          },
        },
        updated_at: "2026-09-16T21:31:13Z",
        created_by: "creator",
        updated_by: "updater",
        last_used_at: "",
        expires_in: 86400,
      }),
    );
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const info = await client.getInfo({ name: "sb-1" });
    expect(server.requests[0]!.method).toBe("GET");
    expect(server.requests[0]!.path).toBe("/v1/sandboxes/instances/sb-1");
    expect(info).toEqual<SandboxInfo>({
      name: "sb-1",
      url: "https://sbx-sb-1.b10.run",
      status: "DEPLOYED",
      image: "blaxel/base-image:latest",
      memory: 4096,
      region: "us-pdx-1",
      enabled: true,
      envs: { PLAIN: { value: "a", secret: false }, HIDDEN: { value: "", secret: true } },
      labels: { team: "eng" },
      externalId: "ext-1",
      lifecycle: {
        expirationPolicies: [
          { type: "TTL_IDLE", action: "DELETE", afterMs: 86_400_000 },
          { type: "TTL_MAX_AGE", action: "DELETE", afterMs: 604_800_000 },
          { type: "DATE", action: "DELETE", at: new Date("2026-09-23T21:26:58Z") },
        ],
        terminatedRetentionMs: 5_400_000,
      },
      ports: [
        { target: 3000, name: "http", protocol: "HTTP" },
        { target: 9000, name: undefined, protocol: undefined },
      ],
      network: {
        subnet: "default",
        proxy: {
          allowedDomains: ["*.example.com"],
          forbiddenDomains: ["bad.example.com"],
          bypass: ["direct.example.com"],
          routing: [
            {
              destinations: ["*"],
              headers: { "x-a": "{{SECRET:a}}" },
              body: { b: "c" },
              secrets: undefined,
            },
          ],
        },
      },
      createdAt: new Date("2026-09-16T21:26:58Z"),
      updatedAt: new Date("2026-09-16T21:31:13Z"),
      createdBy: "creator",
      updatedBy: "updater",
      lastUsedAt: undefined,
      expiresInMs: 86_400_000,
    });
  });

  it("maps a sandbox record without optional fields", async () => {
    const server = fakeServer(() =>
      apiSandbox("sb-1", { lifecycle: { terminated_retention: "" } }),
    );
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const info = await client.getInfo({ name: "sb-1" });
    expect(info.lifecycle).toEqual({
      expirationPolicies: undefined,
      terminatedRetentionMs: undefined,
    });
    expect(info.ports).toEqual([]);
    expect(info.network).toBeUndefined();
    expect(info.expiresInMs).toBeUndefined();
  });

  it("gets with show_secrets only when set", async () => {
    const server = fakeServer(() => apiSandbox("sb-1"));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    await client.getInfo({ name: "sb-1" });
    await client.getInfo({ name: "sb-1", showSecrets: true });
    await client.getInfo({ name: "sb-1", showSecrets: false });
    expect(server.requests.map((request) => request.query.get("show_secrets"))).toEqual([
      null,
      "true",
      "false",
    ]);
  });

  it("fails to map a record with an invalid duration", async () => {
    const server = fakeServer(() =>
      apiSandbox("sb-1", {
        lifecycle: {
          expiration_policies: [{ type: "TTL_IDLE", action: "DELETE", value: "1d12h" }],
        },
      }),
    );
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    await expect(client.getInfo({ name: "sb-1" })).rejects.toThrow(
      'TTL_IDLE expiration policy is not a valid duration: "1d12h"',
    );
  });

  it("gets a sandbox by name with a call, and from a record without one", async () => {
    const server = fakeServer(() => apiSandbox("sb-1"));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const byName = await client.get({ name: "sb-1" });
    expect(byName.url).toBe("https://sbx-sb-1.b10.run");
    expect(server.requests).toHaveLength(1);
    const info = await client.getInfo({ name: "sb-1" });
    const fromInfo = await client.get({ info });
    expect(fromInfo.name).toBe("sb-1");
    expect(server.requests).toHaveLength(2);
  });

  it("fails to get a sandbox that has no URL yet", async () => {
    const server = fakeServer(() => apiSandbox("sb-1", { url: undefined }));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    await expect(client.get({ name: "sb-1" })).rejects.toThrow("sandbox sb-1 has no URL yet");
  });

  it("gives sandboxes the client's cached token", async () => {
    const server = fakeServer(() => apiSandbox("sb-1"));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const sandbox = await client.get({ name: "sb-1" });
    expect(await sandbox.options.tokenProvider!({})).toBe("token-1");
    expect(server.mints()).toBe(1);
  });

  it("drops the client's token when a sandbox finds it revoked", async () => {
    let revoke = true;
    const server = fakeServer((request) => {
      if (!request.path.startsWith("/filesystem/")) return apiSandbox("sb-1");
      if (revoke) {
        revoke = false;
        return Response.json(
          { error: { code: "TOKEN_REVOKED" } },
          { status: 401, headers: { "x-blaxel-error-code": "TOKEN_REVOKED" } },
        );
      }
      return { path: "/tmp/x", content: "hello" };
    });
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const sandbox = await client.get({ name: "sb-1" });
    expect(await sandbox.fs.read({ path: "/tmp/x" })).toBe("hello");
    await client.getInfo({ name: "sb-1" });
    expect(server.requests.map((r) => r.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-1",
      "Bearer token-2",
      "Bearer token-2",
    ]);
  });

  it("lists lazily across pages with the filters on each", async () => {
    const server = fakeServer((request) =>
      request.query.get("cursor") === null
        ? {
            items: [apiSandbox("sb-1"), apiSandbox("sb-2")],
            pagination: { has_more: true, cursor: "c1" },
          }
        : { items: [apiSandbox("sb-3")], pagination: { has_more: false } },
    );
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const iterator = client.list({ query: "sb", statuses: ["DEPLOYED", "DEPLOYING"], pageSize: 2 });
    expect((await iterator.next()).value?.name).toBe("sb-1");
    expect((await iterator.next()).value?.name).toBe("sb-2");
    expect(server.requests).toHaveLength(1);
    expect((await iterator.next()).value?.name).toBe("sb-3");
    expect((await iterator.next()).done).toBe(true);
    expect(server.requests).toHaveLength(2);
    for (const [index, request] of server.requests.entries()) {
      expect(request.method).toBe("GET");
      expect(request.path).toBe("/v1/sandboxes/instances");
      expect(request.query.get("q")).toBe("sb");
      expect(request.query.getAll("status")).toEqual(["DEPLOYED", "DEPLOYING"]);
      expect(request.query.get("limit")).toBe("2");
      expect(request.query.get("cursor")).toBe(index === 0 ? null : "c1");
    }
  });

  it("stops listing on a repeated cursor", async () => {
    const server = fakeServer(() => ({
      items: [apiSandbox("sb-1")],
      pagination: { has_more: true, cursor: "same" },
    }));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const names: string[] = [];
    await expect(
      (async () => {
        for await (const info of client.list()) names.push(info.name);
      })(),
    ).rejects.toThrow("sandbox list returned a repeated cursor");
    expect(names).toEqual(["sb-1", "sb-1"]);
  });

  it("updates with every field mapped and returns the record", async () => {
    const server = fakeServer(() => apiSandbox("sb-1", { enabled: false }));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const info = await client.update({
      name: "sb-1",
      enabled: false,
      lifecycle: {
        expirationPolicies: [{ type: "TTL_IDLE", afterMs: 1_800_000 }],
        terminatedRetentionMs: 300_000,
      },
      region: "us-pdx-1",
      envs: { PLAIN: { value: "a" } },
      image: "custom:2",
      ports: [{ target: 8080 }],
      externalId: "ext-2",
      labels: { team: "infra" },
    });
    expect(server.requests[0]!.method).toBe("PATCH");
    expect(server.requests[0]!.path).toBe("/v1/sandboxes/instances/sb-1");
    expect(server.requests[0]!.body).toEqual({
      enabled: false,
      lifecycle: {
        expiration_policies: [{ type: "TTL_IDLE", action: "DELETE", value: "1800000ms" }],
        terminated_retention: "300000ms",
      },
      region: "us-pdx-1",
      envs: [{ name: "PLAIN", value: "a" }],
      image: "custom:2",
      ports: [{ target: 8080 }],
      external_id: "ext-2",
      labels: { team: "infra" },
    });
    expect(info.name).toBe("sb-1");
    expect(info.enabled).toBe(false);
  });

  it("updates only the fields that are set", async () => {
    const server = fakeServer(() => apiSandbox("sb-1"));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    await client.update({ name: "sb-1", labels: {} });
    await client.update({ name: "sb-1", lifecycle: { expirationPolicies: [] } });
    expect(server.requests.map((r) => r.body)).toEqual([
      { labels: {} },
      { lifecycle: { expiration_policies: [] } },
    ]);
  });

  it("fails an update the server rejects", async () => {
    const server = fakeServer(() =>
      Response.json({ error: "BAD_REQUEST", message: "memory is immutable" }, { status: 400 }),
    );
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const err = await client.update({ name: "sb-1", image: "x:1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxApiError);
    expect(err).toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "sandbox API error (HTTP 400) BAD_REQUEST: memory is immutable",
    });
  });

  it("deletes and returns the record", async () => {
    const server = fakeServer(() => apiSandbox("sb-1", { status: "DELETING" }));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const info = await client.delete({ name: "sb-1" });
    expect(info.status).toBe("DELETING");
    expect(server.requests[0]!.method).toBe("DELETE");
    expect(server.requests[0]!.path).toBe("/v1/sandboxes/instances/sb-1");
  });

  it("shares the cached token with a clone in another team", async () => {
    const server = fakeServer(() => apiSandbox("sb-1"));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const clone = client.withOptions({ teamId: "team-2" });
    await client.getInfo({ name: "sb-1" });
    await clone.getInfo({ name: "sb-1" });
    expect(server.mints()).toBe(1);
    expect(server.requests[1]!.query.get("team_id")).toBe("team-2");
    expect(client.options.teamId).toBeUndefined();
  });

  it("mints a clone's token through the clone's own fetch", async () => {
    const original = fakeServer(() => apiSandbox("sb-1"));
    const replacement = fakeServer(() => apiSandbox("sb-1"));
    const client = new SandboxClient({ apiKey: "test-key", fetch: original.fetch });
    const clone = client.withOptions({ fetch: replacement.fetch });
    await client.getInfo({ name: "sb-1" });
    await clone.getInfo({ name: "sb-1" });
    expect(original.mints()).toBe(1);
    expect(replacement.mints()).toBe(1);
  });

  it("mints a separate token for a clone with other headers", async () => {
    const server = fakeServer(() => apiSandbox("sb-1"));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const clone = client.withOptions({ headers: { "x-extra": "1" } });
    await client.getInfo({ name: "sb-1" });
    await clone.getInfo({ name: "sb-1" });
    expect(server.mints()).toBe(2);
  });

  it("mints a separate token for a clone with another API key", async () => {
    const server = fakeServer(() => apiSandbox("sb-1"));
    const client = new SandboxClient({ apiKey: "test-key", fetch: server.fetch });
    const clone = client.withOptions({ apiKey: "other-key" });
    await client.getInfo({ name: "sb-1" });
    await clone.getInfo({ name: "sb-1" });
    expect(server.mints()).toBe(2);
    expect(server.requests.map((r) => r.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
  });
});
