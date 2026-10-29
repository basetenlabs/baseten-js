import { describe, expect, it } from "vitest";
import { SandboxApiError, SandboxClient, type VolumeInfo } from "../src/index";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

// Serves /v1/token and hands every other request to route, recording it.
function fakeServer(route: (request: Recorded) => unknown): {
  client: SandboxClient;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/v1/token") {
      return Response.json({
        token: "token",
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        teams: [],
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
    const routed = route(recorded);
    if (routed instanceof Response) return routed;
    // The spec's success codes: create is 201 and delete is 202.
    const status = { POST: 201, DELETE: 202 }[request.method] ?? 200;
    return Response.json(routed, { status });
  };
  const client = new SandboxClient({ apiKey: "test-key", fetch: fetchImpl as typeof fetch });
  return { client, requests };
}

const VOLUMES = "/v1/sandboxes/volumes";

const apiVolume = {
  name: "data",
  size: 1024,
  region: "us-pdx-1",
  status: "DEPLOYED",
  attached_to: "sb",
  labels: { k: "v" },
  created_at: "2026-10-01T00:00:00Z",
  created_by: "me",
};

describe("VolumeClient", () => {
  it("creates, sending only set fields, and maps the record", async () => {
    const server = fakeServer(() => apiVolume);
    const info = await server.client
      .withOptions({ teamId: "team-1" })
      .volumes.create({ name: "data", size: 1024, labels: {} });
    const request = server.requests[0]!;
    expect(`${request.method} ${request.path}`).toBe(`POST ${VOLUMES}`);
    expect(request.query.get("team_id")).toBe("team-1");
    expect(request.body).toEqual({ name: "data", size: 1024, labels: {} });
    expect(info).toEqual<VolumeInfo>({
      name: "data",
      size: 1024,
      region: "us-pdx-1",
      status: "DEPLOYED",
      attachedTo: "sb",
      labels: { k: "v" },
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: undefined,
      createdBy: "me",
      updatedBy: undefined,
    });
  });

  it("creates with a string size", async () => {
    const server = fakeServer(() => ({
      name: "data",
      size: "10Gi",
      region: "r",
      status: "DEPLOYING",
    }));
    const info = await server.client.volumes.create({ size: "10Gi", region: "r" });
    expect(server.requests[0]!.body).toEqual({ size: "10Gi", region: "r" });
    expect(info.size).toBe("10Gi");
  });

  it("gets info", async () => {
    const server = fakeServer(() => apiVolume);
    expect((await server.client.volumes.getInfo({ name: "data" })).name).toBe("data");
    expect(server.requests[0]!.path).toBe(`${VOLUMES}/data`);
    expect(server.requests[0]!.query.has("team_id")).toBe(false);
  });

  it("lists across pages with filters, omitting labels", async () => {
    const pages = [
      {
        items: [{ name: "a", size: 1, region: "r", status: "DEPLOYED" }],
        pagination: { has_more: true, cursor: "c1" },
      },
      {
        items: [{ name: "b", size: 1, region: "r", status: "FAILED" }],
        pagination: { has_more: false },
      },
    ];
    const server = fakeServer(() => pages.shift());
    const volumes: VolumeInfo[] = [];
    for await (const volume of server.client.volumes.list({
      query: "x",
      statuses: ["DEPLOYED", "FAILED"],
      pageSize: 1,
    })) {
      volumes.push(volume);
    }
    expect(volumes.map((v) => v.name)).toEqual(["a", "b"]);
    // List omits labels, distinct from a volume with none.
    expect(volumes.map((v) => v.labels)).toEqual([undefined, undefined]);
    const [first, second] = server.requests;
    expect(first!.query.getAll("status")).toEqual(["DEPLOYED", "FAILED"]);
    expect([first!.query.get("q"), first!.query.get("limit")]).toEqual(["x", "1"]);
    expect(first!.query.has("cursor")).toBe(false);
    expect(second!.query.get("cursor")).toBe("c1");
  });

  it("updates, sending only set fields", async () => {
    const server = fakeServer(() => apiVolume);
    const volumes = server.client.volumes;
    await volumes.update({ name: "data", size: "20Gi", labels: {} });
    await volumes.update({ name: "data", labels: { k: "v" } });
    await volumes.update({ name: "data" });
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `PATCH ${VOLUMES}/data`,
      `PATCH ${VOLUMES}/data`,
      `PATCH ${VOLUMES}/data`,
    ]);
    expect(server.requests.map((r) => r.body)).toEqual([
      { size: "20Gi", labels: {} },
      { labels: { k: "v" } },
      {},
    ]);
  });

  it("deletes, returning the deleting record", async () => {
    const server = fakeServer(() => ({ ...apiVolume, status: "DELETING" }));
    expect((await server.client.volumes.delete({ name: "data" })).status).toBe("DELETING");
    expect(server.requests[0]!.method).toBe("DELETE");
  });

  it("throws API errors", async () => {
    const server = fakeServer(() =>
      Response.json({ code: "RESOURCE_IN_USE", message: "mounted" }, { status: 409 }),
    );
    const error = await server.client.volumes.delete({ name: "data" }).catch((err) => err);
    expect(error).toBeInstanceOf(SandboxApiError);
    expect((error as SandboxApiError).status).toBe(409);
  });
});
