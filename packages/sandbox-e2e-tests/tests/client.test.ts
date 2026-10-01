import { SandboxApiError } from "@basetenlabs/sandbox";
import { describe, expect, inject, it } from "vitest";
import { E2E_LABELS, e2eEnabled, sandboxClient } from "./harness";

describe.runIf(e2eEnabled())("SandboxClient", () => {
  const client = sandboxClient();
  const sharedName = inject("sandboxName");

  it("gets a sandbox's record", async () => {
    const info = await client.getInfo({ name: sharedName });
    expect(info.name).toBe(sharedName);
    expect(info.status).toBe("DEPLOYED");
    expect(info.url).toMatch(/^https:\/\//);
    expect(info.labels).toMatchObject(E2E_LABELS);
    // Only an env set as not secret comes back unmasked, and one left unset
    // is secret.
    expect(info.envs).toEqual({
      E2E_PLAIN: { value: "plain-value", secret: false },
      E2E_SECRET: { value: "****", secret: true },
      E2E_DEFAULT: { value: "****", secret: true },
    });
  });

  it("gets a sandbox's record with secrets revealed", async () => {
    // The e2e key is a workspace admin, so secrets are revealed.
    const info = await client.getInfo({ name: sharedName, showSecrets: true });
    expect(info.envs).toEqual({
      E2E_PLAIN: { value: "plain-value", secret: false },
      E2E_SECRET: { value: "secret-value", secret: true },
      E2E_DEFAULT: { value: "default-value", secret: true },
    });
  });

  it("gets a sandbox by name and from its record", async () => {
    const info = await client.getInfo({ name: sharedName });
    const byName = await client.get({ name: sharedName });
    expect(byName.name).toBe(sharedName);
    expect(byName.url).toBe(info.url);
    const fromInfo = await client.get({ info });
    expect(fromInfo.name).toBe(sharedName);
    expect(fromInfo.url).toBe(info.url);
  });

  it("lists sandboxes", async () => {
    const names: string[] = [];
    for await (const info of client.list({ query: sharedName })) names.push(info.name);
    expect(names).toContain(sharedName);
  });

  it("returns the existing sandbox when creating one that exists", async () => {
    const before = await client.getInfo({ name: sharedName });
    const created = await client.create({
      name: sharedName,
      createIfNotExists: true,
      labels: { other: "1" },
    });
    expect(created.name).toBe(sharedName);
    expect(created.url).toBe(before.url);
    expect(created.info.createdAt).toEqual(before.createdAt);
    // The existing configuration is kept, not replaced by the request's.
    expect(created.info.labels).toEqual(before.labels);
  });

  // Changes only fields no other test on the shared sandbox depends on.
  it("updates a sandbox, replacing its labels", async () => {
    const labels = { ...E2E_LABELS, e2e_extra: "1" };
    const updated = await client.update({
      name: sharedName,
      lifecycle: {
        expirationPolicies: [{ type: "TTL_IDLE", afterMs: 3_600_000 }],
        terminatedRetentionMs: 600_000,
      },
      labels,
    });
    const fetched = await client.getInfo({ name: sharedName });
    for (const info of [updated, fetched]) {
      expect(info.lifecycle).toEqual({
        expirationPolicies: [{ type: "TTL_IDLE", afterMs: 3_600_000, action: "DELETE" }],
        terminatedRetentionMs: 600_000,
      });
      expect(info.labels).toEqual(labels);
    }
    const replaced = await client.update({ name: sharedName, labels: E2E_LABELS });
    expect(replaced.labels).toEqual(E2E_LABELS);
  });

  it("fails an update with nothing to change", async () => {
    const err = await client.update({ name: sharedName }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxApiError);
    expect((err as SandboxApiError).status).toBe(400);
  });

  it("fails getting a missing sandbox", async () => {
    const err = await client.getInfo({ name: `${sharedName}-missing` }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxApiError);
    expect((err as SandboxApiError).status).toBe(404);
    expect((err as SandboxApiError).code).toBeDefined();
  });
});
