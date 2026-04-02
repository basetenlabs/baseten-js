import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InferenceClient } from "../src/client/inference";
import { ManagementClient } from "../src/client/management";
import { ResponseError } from "../src/client/managementapi";

const API_KEY = process.env.BASETEN_E2E_TEST_API_KEY ?? "";
const DOMAIN = process.env.BASETEN_E2E_TEST_DOMAIN ?? "";
const MODEL_ID = process.env.BASETEN_E2E_TEST_MODEL_ID ?? "";

function ensureE2EEnv() {
  if (!API_KEY) {
    return false;
  }
  if (!DOMAIN) {
    throw new Error("BASETEN_E2E_TEST_API_KEY is set but BASETEN_E2E_TEST_DOMAIN is missing");
  }
  if (!MODEL_ID) {
    throw new Error("BASETEN_E2E_TEST_API_KEY is set but BASETEN_E2E_TEST_MODEL_ID is missing");
  }
  return true;
}

function managementClient(): ManagementClient {
  return new ManagementClient({
    apiKey: API_KEY,
    baseUrlOverride: `https://api.${DOMAIN}`,
  });
}

function inferenceClient(): InferenceClient {
  return new InferenceClient({
    apiKey: API_KEY,
    baseUrlOverride: `https://model-${MODEL_ID}.api.${DOMAIN}`,
  });
}

describe.runIf(ensureE2EEnv())("e2e", () => {
  it("lists models", async () => {
    const models = await managementClient().api.getModels();
    const ids = models.models.map((m) => m.id);
    expect(ids).toContain(MODEL_ID);
  });

  it("gets model", async () => {
    const model = await managementClient().api.getModelsModelId({
      model_id: MODEL_ID,
    });
    expect(model.id).toBe(MODEL_ID);
    expect(model.name).toBeDefined();
  });

  it("gets model not found", async () => {
    try {
      await managementClient().api.getModelsModelId({
        model_id: "nonexistent-model-id",
      });
      expect.unreachable("expected ResponseError");
    } catch (e) {
      expect(e).toBeInstanceOf(ResponseError);
      expect((e as ResponseError).statusCode).toBe(404);
    }
  });

  it("lists deployments", async () => {
    const deployments = await managementClient().api.getModelsDeployments({
      model_id: MODEL_ID,
    });
    expect(deployments.deployments.length).toBeGreaterThan(0);
  });

  it("runs inference", { timeout: 30_000 }, async () => {
    const result = await inferenceClient().api.predictProduction({
      body: { prompt: "hello" },
    });
    expect(result).toBeDefined();
  });

  it("api key crud", async () => {
    const client = managementClient();
    const keyName = `e2e-test-${randomUUID()}`;
    let createdPrefix: string | undefined;

    try {
      const created = await client.api.postApiKeys({
        body: { name: keyName, type: "PERSONAL", model_ids: null },
      });
      expect(created.api_key).toBeTruthy();
      createdPrefix = created.api_key.split(".")[0];

      const keys = await client.api.getApiKeys();
      const names = keys.keys.map((k) => k.name);
      expect(names).toContain(keyName);

      const tombstone = await client.api.deleteApiKeys({
        api_key_prefix: createdPrefix,
      });
      expect(tombstone.prefix).toBe(createdPrefix);

      const keysAfter = await client.api.getApiKeys();
      const prefixes = keysAfter.keys.map((k) => k.prefix);
      expect(prefixes).not.toContain(createdPrefix);
      createdPrefix = undefined;
    } finally {
      if (createdPrefix) {
        await client.api.deleteApiKeys({ api_key_prefix: createdPrefix }).catch(() => {});
      }
    }
  });
});
