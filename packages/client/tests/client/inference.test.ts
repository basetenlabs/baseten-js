import { describe, expect, it } from "vitest";
import { InferenceClient } from "../../src/inference";
import { ResponseError, ResponseErrorResponse } from "../../src/inferenceapi";
import { type CapturedRequest, fakeFetch } from "../helpers";

function makeClient(
  status: number,
  body: unknown,
  options?: Partial<ConstructorParameters<typeof InferenceClient>[0]>,
): { client: InferenceClient; capture: () => CapturedRequest } {
  const { fetch, capture } = fakeFetch(status, body);
  const client = new InferenceClient({
    apiKey: "test-key",
    modelId: "abc123",
    fetch,
    ...options,
  });
  return { client, capture };
}

describe("InferenceClient", () => {
  it("calls predict", async () => {
    const { client, capture } = makeClient(200, { output: "hello" });
    const resp = await client.api.predictProduction({ request: { input: "hi" } });
    expect(resp).toEqual({ output: "hello" });
    const req = capture();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/production/predict");
    expect(req.headers.authorization).toBe("Api-Key test-key");
    expect(req.headers["user-agent"]).toMatch(/^baseten-js\/\S+/);
    expect(req.body).toEqual({ input: "hi" });
  });

  it("merges custom headers and lets caller override User-Agent", async () => {
    const { client, capture } = makeClient(
      200,
      { output: "ok" },
      { headers: { "X-Custom": "v", "User-Agent": "custom/1.0" } },
    );
    await client.api.predictProduction({ request: {} });
    const req = capture();
    expect(req.headers["x-custom"]).toBe("v");
    expect(req.headers["user-agent"]).toBe("custom/1.0");
  });

  it("omits Authorization when apiKey is empty string", async () => {
    const { client, capture } = makeClient(200, { output: "ok" }, { apiKey: "" });
    await client.api.predictProduction({ request: {} });
    expect(capture().headers.authorization).toBeUndefined();
  });

  it("throws ResponseError on failure", async () => {
    const { client } = makeClient(500, { detail: "boom" });
    await expect(client.api.predictProduction({ request: {} })).rejects.toThrow(ResponseError);
  });

  it("throws ResponseErrorResponse on typed error", async () => {
    const { client } = makeClient(400, { error: "bad input", error_code: "client_error" });
    await expect(client.api.predictProduction({ request: {} })).rejects.toThrow(
      ResponseErrorResponse,
    );
    try {
      await client.api.predictProduction({ request: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(ResponseErrorResponse);
      expect((e as ResponseErrorResponse).error_response.error).toBe("bad input");
    }
  });

  it("computes default base url for model", () => {
    expect(InferenceClient.defaultBaseUrl({ modelId: "abc" })).toBe(
      "https://model-abc.api.baseten.co",
    );
  });

  it("computes default base url for chain with environment", () => {
    expect(InferenceClient.defaultBaseUrl({ chainId: "xyz", environment: "production" })).toBe(
      "https://chain-xyz-production.api.baseten.co",
    );
  });

  it("throws if both modelId and chainId provided", () => {
    expect(() => InferenceClient.defaultBaseUrl({ modelId: "abc", chainId: "xyz" })).toThrow(
      "exactly one",
    );
  });

  it("throws if neither modelId nor chainId provided", () => {
    expect(() => InferenceClient.defaultBaseUrl({})).toThrow("exactly one");
  });

  it("allows base url override", async () => {
    const { client, capture } = makeClient(
      200,
      { output: "ok" },
      {
        modelId: undefined,
        baseUrlOverride: "https://custom.example.com",
      },
    );
    await client.api.predictProduction({ request: {} });
    expect(capture().url.startsWith("https://custom.example.com")).toBe(true);
  });
});
