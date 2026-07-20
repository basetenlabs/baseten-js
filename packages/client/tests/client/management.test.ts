import { describe, expect, it } from "vitest";
import { ManagementClient } from "../../src/management";
import { ResponseError } from "../../src/managementapi";
import { type CapturedRequest, fakeFetch } from "../helpers";

const MINIMAL_MODEL = {
  id: "model-1",
  name: "my-model",
  created_at: "2024-01-01T00:00:00Z",
  deployments_count: 2,
  production_deployment_id: "dep-1",
  development_deployment_id: "dep-2",
  instance_type_name: "A10G",
  team_name: "my-team",
};

const MINIMAL_SECRET = {
  name: "MY_SECRET",
  created_at: "2024-01-01T00:00:00Z",
  team_name: "my-team",
};

function makeClient(
  status: number,
  body: unknown,
): { client: ManagementClient; capture: () => CapturedRequest } {
  const { fetch, capture } = fakeFetch(status, body);
  const client = new ManagementClient({ apiKey: "test-key", fetch });
  return { client, capture };
}

describe("ManagementClient", () => {
  it("gets models", async () => {
    const { client, capture } = makeClient(200, { models: [MINIMAL_MODEL] });
    const resp = await client.api.getModels();
    expect(resp.models).toHaveLength(1);
    expect(resp.models[0]!.name).toBe("my-model");
    const req = capture();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1/models");
    expect(req.headers.authorization).toBe("Api-Key test-key");
    expect(req.headers["user-agent"]).toMatch(/^baseten-js\/\S+/);
  });

  it("merges custom headers and lets caller override User-Agent", async () => {
    const { fetch, capture } = fakeFetch(200, { models: [] });
    const client = new ManagementClient({
      apiKey: "test-key",
      fetch,
      headers: { "X-Custom": "v", "User-Agent": "custom/1.0" },
    });
    await client.api.getModels();
    const req = capture();
    expect(req.headers["x-custom"]).toBe("v");
    expect(req.headers["user-agent"]).toBe("custom/1.0");
  });

  it("omits Authorization when apiKey is empty string", async () => {
    const { fetch, capture } = fakeFetch(200, { models: [] });
    const client = new ManagementClient({ apiKey: "", fetch });
    await client.api.getModels();
    expect(capture().headers.authorization).toBeUndefined();
  });

  it("escapes path params", async () => {
    const { client, capture } = makeClient(200, MINIMAL_MODEL);
    await client.api.getModelsModelId({ model_id: "abc/def" });
    expect(capture().path).toBe("/v1/models/abc%2Fdef");
  });

  it("serializes query params, exploding arrays and stringifying enums", async () => {
    const { client, capture } = makeClient(200, { entries: [], next_cursor: null });
    await client.api.getAuditLogs({
      request: {
        limit: 50,
        direction: "ASC",
        search: "deploy prod",
        event_type_groups: ["DEPLOYED", "SECRETS"],
        user_ids: ["u1", "u2"],
      },
    });
    const params = new URLSearchParams(capture().search);
    expect(params.get("limit")).toBe("50");
    expect(params.get("direction")).toBe("ASC");
    expect(params.get("search")).toBe("deploy prod");
    // Arrays explode into one repeated param per element.
    expect(params.getAll("event_type_groups")).toEqual(["DEPLOYED", "SECRETS"]);
    expect(params.getAll("user_ids")).toEqual(["u1", "u2"]);
    // Unset optional params are omitted entirely.
    expect(params.has("cursor")).toBe(false);
  });

  it("omits the query string when no query params are given", async () => {
    const { client, capture } = makeClient(200, { entries: [], next_cursor: null });
    await client.api.getAuditLogs();
    expect(capture().search).toBe("");
  });

  it("sends post body", async () => {
    const { client, capture } = makeClient(200, MINIMAL_SECRET);
    const resp = await client.api.postSecrets({
      request: { name: "MY_SECRET", value: "s3cret" },
    });
    expect(resp.name).toBe("MY_SECRET");
    const req = capture();
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toEqual({ name: "MY_SECRET", value: "s3cret" });
  });

  it("throws ResponseError on failure", async () => {
    const { client } = makeClient(500, { detail: "boom" });
    await expect(client.api.getModels()).rejects.toThrow(ResponseError);
    try {
      await client.api.getModels();
    } catch (e) {
      expect(e).toBeInstanceOf(ResponseError);
      expect((e as ResponseError).statusCode).toBe(500);
      expect((e as ResponseError).body).toContain("boom");
    }
  });

  it("uses default base url", () => {
    expect(ManagementClient.defaultBaseUrl()).toBe("https://api.baseten.co");
  });

  it("allows base url override", async () => {
    const { fetch, capture } = fakeFetch(200, { models: [] });
    const client = new ManagementClient({
      apiKey: "test-key",
      baseUrlOverride: "https://custom.example.com",
      fetch,
    });
    await client.api.getModels();
    expect(capture().url.startsWith("https://custom.example.com")).toBe(true);
  });
});
