import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { e2eEnabled, sandboxClient, uniqueName } from "./harness";

// The sandbox package resolves undici 8, which it only uses for HTTP/2 when
// Node's bundled undici is 8 or newer too.
const nodeBundlesUndici8 = Number(process.versions.undici?.split(".")[0]) >= 8;

describe.runIf(e2eEnabled())("transport", () => {
  const sharedName = inject("sandboxName");
  // ALPN protocol and count of new connections, by host. Every undici copy,
  // Node's own included, publishes to the same channel.
  const protocols = new Map<string, string>();
  const connects = new Map<string, number>();
  const onConnected = (message: unknown) => {
    const { connectParams, socket } = message as {
      connectParams: { hostname: string };
      socket: { alpnProtocol?: string | false };
    };
    protocols.set(connectParams.hostname, String(socket.alpnProtocol));
    connects.set(connectParams.hostname, (connects.get(connectParams.hostname) ?? 0) + 1);
  };

  beforeEach(() => {
    protocols.clear();
    connects.clear();
    subscribe("undici:client:connected", onConnected);
  });

  afterEach(() => {
    unsubscribe("undici:client:connected", onConnected);
  });

  // Each client drops the harness's debug fetch, which would bypass the
  // client's own transport selection.
  it.runIf(nodeBundlesUndici8)("uses HTTP/2 on both planes by default", async () => {
    const client = sandboxClient().withOptions({ fetch: undefined });
    const sandbox = await client.get({ name: sharedName });
    await sandbox.process.exec({ command: "true", waitForCompletion: true });
    expect(protocols.get(new URL(client.options.baseUrlOverride!).hostname)).toBe("h2");
    expect(protocols.get(new URL(sandbox.url).hostname)).toBe("h2");
  });

  it.runIf(nodeBundlesUndici8)("reuses the connection after aborting a stream", async () => {
    const client = sandboxClient().withOptions({ fetch: undefined });
    const sandbox = await client.get({ name: sharedName });
    const name = uniqueName();
    await sandbox.process.exec({
      command: "sh -c 'while true; do echo tick; sleep 0.2; done'",
      name,
    });
    try {
      const controller = new AbortController();
      const lines = sandbox.process.streamLogs({
        identifier: name,
        callOptions: { signal: controller.signal },
      });
      expect((await lines.next()).value).toEqual({ stream: "stdout", text: "tick" });
      controller.abort();
      await expect(lines.next()).rejects.toThrow();

      expect((await sandbox.process.get({ identifier: name })).status).toBe("running");
      expect(connects.get(new URL(sandbox.url).hostname)).toBe(1);
    } finally {
      await sandbox.process.kill({ identifier: name }).catch(() => {});
    }
  });

  it("leaves both planes to Node's own fetch when undici is off", async () => {
    const client = sandboxClient().withOptions({ fetch: undefined, nodeUndici: false });
    const sandbox = await client.get({ name: sharedName });
    await sandbox.process.exec({ command: "true", waitForCompletion: true });
    // Node's fetch uses HTTP/2 from Node 26 on, which bundles undici 8.
    const expected = nodeBundlesUndici8 ? "h2" : "http/1.1";
    expect(protocols.get(new URL(client.options.baseUrlOverride!).hostname)).toBe(expected);
    expect(protocols.get(new URL(sandbox.url).hostname)).toBe(expected);
  });
});
