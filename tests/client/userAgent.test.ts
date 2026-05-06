import { describe, expect, it } from "vitest";
import { applyUserAgentHeader, userAgentHeader } from "../../src/client/userAgent";
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
