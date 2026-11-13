import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { applyUserAgentHeader, defaultFetch, userAgentHeader } from "../../src/common";
import { VERSION } from "../../src/version";

describe("userAgentHeader", () => {
  it("includes client, version, runtime, and platform when running on Node", () => {
    const ua = userAgentHeader();
    expect(ua).toMatch(new RegExp(`^baseten-js/${VERSION} \\(Node/\\S+; [^)]+\\)$`));
  });
});

describe("applyUserAgentHeader", () => {
  it("sets User-Agent when absent", () => {
    const headers: Record<string, string> = {};
    applyUserAgentHeader(headers);
    expect(headers["User-Agent"]).toBe(userAgentHeader());
  });

  it("does not overwrite an existing User-Agent (any case)", () => {
    const headers: Record<string, string> = { "user-agent": "custom/1.0" };
    applyUserAgentHeader(headers);
    expect(headers["user-agent"]).toBe("custom/1.0");
    expect(headers["User-Agent"]).toBeUndefined();
  });
});

describe("defaultFetch", () => {
  it("does not follow redirects", async () => {
    let followed = false;
    const server = createServer((req, res) => {
      if (req.url === "/target") followed = true;
      res.writeHead(req.url === "/start" ? 302 : 200, { Location: "/target" }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await defaultFetch(`http://127.0.0.1:${port}/start`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/target");
      expect(followed).toBe(false);
    } finally {
      server.close();
    }
  });
});
