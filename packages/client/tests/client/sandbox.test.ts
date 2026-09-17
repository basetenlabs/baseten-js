import { describe, expect, it } from "vitest";
import { SandboxClient } from "../../src/sandbox";
import { type CapturedRequest, fakeFetch } from "../helpers";

// Every test supplies a fake fetch, so nothing is ever dialed. The .invalid TLD
// is reserved by RFC 2606 and cannot resolve, so a missing mock fails loudly
// instead of reaching a host that exists.
const BASE_URL = "https://sandbox.invalid";

function makeClient(
  status: number,
  body: unknown,
  options?: Partial<ConstructorParameters<typeof SandboxClient>[0]>,
): { client: SandboxClient; capture: () => CapturedRequest } {
  const { fetch, capture } = fakeFetch(status, body);
  const client = new SandboxClient({ token: "test-token", baseUrl: BASE_URL, fetch, ...options });
  return { client, capture };
}

// Captures the RequestInit as given, without assuming a JSON body, which the
// shared helper does. Needed for the FormData and octet-stream bodies.
function rawCapture(responseBody = "{}"): {
  fetch: typeof globalThis.fetch;
  capture: () => { url: string; init: RequestInit; headers: Record<string, string> };
} {
  let captured: { url: string; init: RequestInit; headers: Record<string, string> } | null = null;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    captured = { url: String(input), init: init ?? {}, headers };
    return new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetch: fetchImpl as typeof globalThis.fetch,
    capture: () => {
      if (!captured) throw new Error("no request captured");
      return captured;
    },
  };
}

/** Response whose body emits the given chunks, then closes. */
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/plain" } },
  );
}

describe("SandboxClient", () => {
  it("sends a bearer token", async () => {
    const { client, capture } = makeClient(200, { status: "ok" });
    await client.api.getHealth();
    const req = capture();
    expect(req.path).toBe("/health");
    expect(req.headers.authorization).toBe("Bearer test-token");
    expect(req.headers["user-agent"]).toMatch(/^baseten-js\/\S+/);
  });

  it("omits Authorization when token is empty string", async () => {
    const { client, capture } = makeClient(200, { status: "ok" }, { token: "" });
    await client.api.getHealth();
    expect(capture().headers.authorization).toBeUndefined();
  });

  it("sends FormData without a Content-Type so fetch supplies the boundary", async () => {
    const { fetch, capture } = rawCapture();
    const client = new SandboxClient({ token: "t", baseUrl: BASE_URL, fetch });
    const form = new FormData();
    form.append("file", new Blob(["data"]), "part.bin");

    await client.api.putFilesystemMultipartPart({
      uploadId: "up-1",
      query: { partNumber: 2 },
      request: form,
    });

    const req = capture();
    expect(req.url).toBe(`${BASE_URL}/filesystem-multipart/up-1/part?partNumber=2`);
    expect(req.init.body).toBe(form);
    expect(req.headers["content-type"]).toBeUndefined();
  });

  it("drops a caller-supplied Content-Type for FormData regardless of casing", async () => {
    const { fetch, capture } = rawCapture();
    const client = new SandboxClient({
      token: "t",
      baseUrl: BASE_URL,
      fetch,
      headers: { "content-TYPE": "application/json" },
    });

    await client.api.putFilesystemMultipartPart({
      uploadId: "up-1",
      query: { partNumber: 1 },
      request: new FormData(),
    });

    expect(capture().headers["content-type"]).toBeUndefined();
  });

  it("sends an octet-stream body unmodified", async () => {
    const { fetch, capture } = rawCapture();
    const client = new SandboxClient({ token: "t", baseUrl: BASE_URL, fetch });
    const bytes = new Uint8Array([1, 2, 3]);

    await client.api.postProcessStdin({ identifier: "p-1", request: bytes });

    const req = capture();
    expect(req.init.body).toBe(bytes);
    expect(req.headers["content-type"]).toBe("application/octet-stream");
  });

  it("sets the requested Accept and returns the response unread", async () => {
    const { fetch, capture } = rawCapture();
    const client = new SandboxClient({ token: "t", baseUrl: BASE_URL, fetch });

    const response = await client.api.postProcessRaw({
      accept: "text/event-stream",
      request: { command: "echo hi" },
    });

    expect(capture().headers.accept).toBe("text/event-stream");
    expect(response).toBeInstanceOf(Response);
    expect(response.bodyUsed).toBe(false);
  });

  it("reads raw file bytes", async () => {
    const fetchImpl = async () =>
      new Response(new Uint8Array([7, 8, 9]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    const client = new SandboxClient({
      token: "t",
      baseUrl: BASE_URL,
      fetch: fetchImpl as typeof globalThis.fetch,
    });

    expect(await client.readFileBytes("/tmp/f")).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("narrows an export on its status code", async () => {
    const sync = makeClient(200, { manifest: "m-1" });
    const syncResult = await sync.client.api.postArchiveExport({ request: {} });
    expect(syncResult.status).toBe(200);
    if (syncResult.status === 200) expect(syncResult.data.manifest).toBe("m-1");

    const async_ = makeClient(202, { state: "running" });
    const asyncResult = await async_.client.api.postArchiveExport({ request: { async: true } });
    expect(asyncResult.status).toBe(202);
    if (asyncResult.status === 202) expect(asyncResult.data.state).toBe("running");
  });

  it("streams process logs, tagging streams and splitting across chunks", async () => {
    const fetchImpl = async () =>
      streamResponse(["stdout:one\nstde", "rr:two\nplain\n", "stdout:trailing"]);
    const client = new SandboxClient({
      token: "t",
      baseUrl: BASE_URL,
      fetch: fetchImpl as typeof globalThis.fetch,
    });

    const lines = [];
    for await (const line of client.streamProcessLogs("p-1")) lines.push(line);

    expect(lines).toEqual([
      { stream: "stdout", line: "one" },
      { stream: "stderr", line: "two" },
      { stream: "unknown", line: "plain" },
      // No trailing newline, so this is flushed when the stream closes.
      { stream: "stdout", line: "trailing" },
    ]);
  });

  it("stops watching when a quiet stream is aborted", async () => {
    // Reports one change, then stays open with nothing further to deliver,
    // which is the normal resting state of a watched directory.
    const fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("a.txt\n"));
          },
        }),
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    const client = new SandboxClient({
      token: "t",
      baseUrl: BASE_URL,
      fetch: fetchImpl as typeof globalThis.fetch,
    });

    const controller = new AbortController();
    const iterator = client.watchFilesystem("/app", { signal: controller.signal });

    // Awaiting the first value proves the response arrived and the read loop is
    // running, so the next read is parked on a chunk that never comes. Aborting
    // has to interrupt that read itself. A flag checked between reads would
    // leave this hanging forever.
    expect(await iterator.next()).toEqual({ done: false, value: "a.txt" });
    const pending = iterator.next();
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
  });

  it("passes watch ignore patterns as a query parameter", async () => {
    const { fetch, capture } = rawCapture();
    const client = new SandboxClient({ token: "t", baseUrl: BASE_URL, fetch });

    await client.api.getWatchFilesystem({ path: "/app", query: { ignore: "node_modules,dist" } });

    expect(capture().url).toBe(`${BASE_URL}/watch/filesystem/%2Fapp?ignore=node_modules%2Cdist`);
  });
});
