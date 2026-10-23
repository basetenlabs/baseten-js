import { describe, expect, it } from "vitest";
import { type Sandbox, SandboxApiError, SandboxClient } from "../../src/index";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

const PREVIEWS_PATH = "/v1/sandboxes/instances/sb/previews";

const apiPreview = {
  name: "web",
  port: 3000,
  url: "https://p.example",
  status: "DEPLOYED",
  public: false,
  region: "us-was-1",
  expires_at: "2026-10-20T12:00:00Z",
  response_headers: { A: "1" },
  request_headers: { Authorization: "****" },
  created_at: "2026-10-13T12:00:00Z",
  created_by: "me",
};

// A sandbox named "sb" in team "team-1" whose control plane requests go to
// route, recorded first. Getting the sandbox itself is answered and not
// recorded.
async function fakePreviews(route: (request: Recorded) => Response) {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/v1/sandboxes/instances/sb") {
      return Response.json({
        name: "sb",
        url: "https://sb.example",
        status: "DEPLOYED",
        created_at: "2026-10-13T12:00:00Z",
      });
    }
    const text = await request.text();
    const recorded: Recorded = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body: text === "" ? undefined : JSON.parse(text),
    };
    requests.push(recorded);
    return route(recorded);
  };
  const client = new SandboxClient({
    apiKey: "",
    tokenProvider: async () => "token",
    teamId: "team-1",
    fetch: fetchImpl as typeof fetch,
  });
  const sandbox: Sandbox = await client.get({ name: "sb" });
  return { client, previews: sandbox.previews, requests };
}

describe("SandboxPreviews", () => {
  it("creates sending only set fields and maps the record", async () => {
    const { previews, requests } = await fakePreviews(() =>
      Response.json(apiPreview, { status: 201 }),
    );
    const info = await previews.create({
      port: 3000,
      name: "web",
      responseHeaders: {},
      ttlMs: 5_400_000,
    });
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.path).toBe(PREVIEWS_PATH);
    expect(requests[0]!.query.get("team_id")).toBe("team-1");
    expect(requests[0]!.body).toEqual({
      port: 3000,
      name: "web",
      response_headers: {},
      ttl: "5400000ms",
    });
    expect(info).toEqual({
      name: "web",
      port: 3000,
      url: "https://p.example",
      status: "DEPLOYED",
      public: false,
      responseHeaders: { A: "1" },
      requestHeaders: { Authorization: "****" },
      expiresAt: new Date("2026-10-20T12:00:00Z"),
      region: "us-was-1",
      createdAt: new Date("2026-10-13T12:00:00Z"),
      updatedAt: undefined,
      createdBy: "me",
      updatedBy: undefined,
    });
  });

  it("creates with every field", async () => {
    const { previews, requests } = await fakePreviews(() =>
      Response.json(apiPreview, { status: 201 }),
    );
    await previews.create({
      port: 3000,
      createIfNotExists: true,
      public: true,
      requestHeaders: { Authorization: "Bearer x" },
      expiresAt: new Date("2026-10-20T12:00:00Z"),
    });
    expect(requests[0]!.body).toEqual({
      port: 3000,
      create_if_not_exists: true,
      public: true,
      request_headers: { Authorization: "Bearer x" },
      expires_at: "2026-10-20T12:00:00.000Z",
    });
  });

  it("converts API errors", async () => {
    const { previews } = await fakePreviews(() =>
      Response.json({ code: "CONFLICT", message: "exists" }, { status: 409 }),
    );
    const err = await previews.create({ port: 3000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxApiError);
    expect((err as SandboxApiError).code).toBe("CONFLICT");
  });

  it("gets info with show secrets", async () => {
    const { previews, requests } = await fakePreviews(() => Response.json(apiPreview));
    const info = await previews.getInfo({ name: "web", showSecrets: true });
    expect(info.name).toBe("web");
    expect(requests[0]!.path).toBe(`${PREVIEWS_PATH}/web`);
    expect(requests[0]!.query.get("show_secrets")).toBe("true");
  });

  it("lists across pages", async () => {
    const { previews, requests } = await fakePreviews((request) =>
      request.query.get("cursor") === null
        ? Response.json({
            items: [{ ...apiPreview, name: "a" }],
            pagination: { has_more: true, cursor: "c1" },
          })
        : Response.json({ items: [{ ...apiPreview, name: "b" }], pagination: { has_more: false } }),
    );
    const names: string[] = [];
    for await (const info of previews.list({ pageSize: 1 })) names.push(info.name);
    expect(names).toEqual(["a", "b"]);
    expect(requests.map((r) => r.query.get("cursor"))).toEqual([null, "c1"]);
    expect(requests[0]!.query.get("limit")).toBe("1");
  });

  it("updates sending only set fields", async () => {
    const { previews, requests } = await fakePreviews(() => Response.json(apiPreview));
    await previews.update({ name: "web", public: false, requestHeaders: {} });
    await previews.update({ name: "web" });
    expect(requests[0]!.method).toBe("PATCH");
    expect(requests[0]!.path).toBe(`${PREVIEWS_PATH}/web`);
    // False is sent, since it differs from unchanged, and an empty object
    // clears the set.
    expect(requests[0]!.body).toEqual({ public: false, request_headers: {} });
    expect(requests[1]!.body).toEqual({});
  });

  it("deletes returning the record", async () => {
    const { previews, requests } = await fakePreviews(() =>
      Response.json({ ...apiPreview, status: "DELETING" }),
    );
    const info = await previews.delete({ name: "web" });
    expect(info.status).toBe("DELETING");
    expect(requests[0]!.method).toBe("DELETE");
  });

  it("creates, lists, and deletes tokens", async () => {
    const apiToken = {
      name: "t1",
      token: "secret",
      expires_at: "2026-10-14T12:00:00Z",
      expired: false,
    };
    const { previews, requests } = await fakePreviews((request) => {
      if (request.method === "POST") return Response.json(apiToken, { status: 201 });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ items: [apiToken], pagination: { has_more: false } });
    });
    const token = await previews.createToken({
      previewName: "web",
      expiresAt: new Date("2026-10-14T12:00:00Z"),
      createIfNotExists: true,
    });
    expect(requests[0]!.path).toBe(`${PREVIEWS_PATH}/web/tokens`);
    expect(requests[0]!.body).toEqual({
      expires_at: "2026-10-14T12:00:00.000Z",
      create_if_not_exists: true,
    });
    expect(token).toEqual({
      name: "t1",
      token: "secret",
      expiresAt: new Date("2026-10-14T12:00:00Z"),
      expired: false,
    });

    const names: string[] = [];
    for await (const info of previews.listTokens({ previewName: "web" })) names.push(info.name);
    expect(names).toEqual(["t1"]);

    await previews.deleteToken({ previewName: "web", tokenName: "t1" });
    expect(requests[2]!.method).toBe("DELETE");
    expect(requests[2]!.path).toBe(`${PREVIEWS_PATH}/web/tokens/t1`);
  });

  it("fails every call on a sandbox from a URL", async () => {
    const { client, requests } = await fakePreviews(() => Response.json({}));
    const previews = client.sandboxFromUrl({ url: "https://sb.example" }).previews;
    const calls: Record<string, () => Promise<unknown>> = {
      create: () => previews.create({ port: 3000 }),
      getInfo: () => previews.getInfo({ name: "web" }),
      list: () => previews.list().next(),
      update: () => previews.update({ name: "web" }),
      delete: () => previews.delete({ name: "web" }),
      createToken: () => previews.createToken({ previewName: "web", expiresAt: new Date() }),
      listTokens: () => previews.listTokens({ previewName: "web" }).next(),
      deleteToken: () => previews.deleteToken({ previewName: "web", tokenName: "t1" }),
    };
    for (const [name, call] of Object.entries(calls)) {
      await expect(call(), name).rejects.toThrow("sandboxFromUrl");
    }
    expect(requests).toEqual([]);
  });
});
