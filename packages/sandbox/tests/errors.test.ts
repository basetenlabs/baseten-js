import { describe, expect, it } from "vitest";
import { Sandbox, SandboxApiError, SandboxClient, SandboxGatewayError } from "../src/index";

// Answers every request with the given status and body, except /v1/token.
function respondWith(status: number, body: unknown): typeof fetch {
  const fetchImpl = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/v1/token") {
      return Response.json({
        token: "token-1",
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        teams: [],
      });
    }
    if (typeof body === "string") return new Response(body, { status });
    return Response.json(body, { status });
  };
  return fetchImpl as typeof fetch;
}

function controlClient(status: number, body: unknown): SandboxClient {
  return new SandboxClient({ apiKey: "test-key", fetch: respondWith(status, body) });
}

function sandbox(status: number, body: unknown): Sandbox {
  return new SandboxClient({
    apiKey: "",
    fetch: respondWith(status, body),
    retries: { gatewayMaxRetries: 0 },
  }).sandboxFromUrl({ url: "https://sbx-sb-1.b10.run" });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("control plane errors", () => {
  it("carries the status, code, message, and details", async () => {
    const body = { code: "NOT_FOUND", message: "no such sandbox", details: { name: "sb-1" } };
    const err = await caught(controlClient(404, body).getInfo({ name: "sb-1" }));
    expect(err).toBeInstanceOf(SandboxApiError);
    expect(err).not.toBeInstanceOf(SandboxGatewayError);
    const apiErr = err as SandboxApiError;
    expect(apiErr.message).toBe("sandbox API error (HTTP 404) NOT_FOUND: no such sandbox");
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe("NOT_FOUND");
    expect(apiErr.details).toEqual({ name: "sb-1" });
    expect(apiErr.body).toEqual(body);
    expect(apiErr.cause).toBeInstanceOf(Error);
  });

  it("takes the code from the error field alongside a message", async () => {
    const body = { error: "INTERNAL_ERROR", message: "Internal server error" };
    const err = await caught(controlClient(500, body).getInfo({ name: "sb-1" }));
    expect((err as SandboxApiError).message).toBe(
      "sandbox API error (HTTP 500) INTERNAL_ERROR: Internal server error",
    );
    expect((err as SandboxApiError).code).toBe("INTERNAL_ERROR");
  });

  it("keeps a body that is not JSON as text", async () => {
    const err = await caught(controlClient(500, "upstream exploded").getInfo({ name: "sb-1" }));
    expect(err).toBeInstanceOf(SandboxApiError);
    expect((err as SandboxApiError).message).toBe("sandbox API error (HTTP 500)");
    expect((err as SandboxApiError).code).toBeUndefined();
    expect((err as SandboxApiError).body).toBe("upstream exploded");
  });

  it("does not treat a gateway status as a gateway error", async () => {
    const err = await caught(controlClient(503, "unavailable").getInfo({ name: "sb-1" }));
    expect(err).toBeInstanceOf(SandboxApiError);
    expect(err).not.toBeInstanceOf(SandboxGatewayError);
  });

  it("passes a network failure through unchanged", async () => {
    const failure = new TypeError("fetch failed");
    const client = new SandboxClient({
      apiKey: "",
      tokenProvider: async () => "provided",
      fetch: (async () => {
        throw failure;
      }) as typeof fetch,
    });
    expect(await caught(client.getInfo({ name: "sb-1" }))).toBe(failure);
  });
});

describe("sandbox errors", () => {
  it("takes the message from the error field", async () => {
    const body = { code: 404, error: "file not found" };
    const err = await caught(sandbox(404, body).fs.read({ path: "/tmp/missing" }));
    expect(err).toBeInstanceOf(SandboxApiError);
    expect(err).not.toBeInstanceOf(SandboxGatewayError);
    const apiErr = err as SandboxApiError;
    expect(apiErr.message).toBe("sandbox API error (HTTP 404): file not found");
    expect(apiErr.status).toBe(404);
    // A numeric code is not a machine-readable one.
    expect(apiErr.code).toBeUndefined();
    expect(apiErr.body).toEqual(body);
  });

  it("converts an edge 502, 503, or 504 to a gateway error", async () => {
    for (const status of [502, 503, 504]) {
      const err = await caught(sandbox(status, "bad gateway").fs.read({ path: "/tmp/x" }));
      expect(err).toBeInstanceOf(SandboxGatewayError);
      expect((err as SandboxGatewayError).status).toBe(status);
      expect((err as SandboxGatewayError).name).toBe("SandboxGatewayError");
    }
  });
});
