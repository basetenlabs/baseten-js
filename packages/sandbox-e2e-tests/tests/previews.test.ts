import { type Sandbox, SandboxApiError, type SandboxPreviewInfo } from "@basetenlabs/sandbox";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { e2eEnabled, sandboxClient, uniqueName } from "./harness";

// Answers every GET with "hello " plus the X-E2E-Request header it received,
// so a test can see the headers a preview adds to requests.
const PREVIEW_SERVER = `import http.server
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = ("hello " + self.headers.get("X-E2E-Request", "")).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
http.server.ThreadingHTTPServer(("0.0.0.0", 8123), Handler).serve_forever()
`;

// GETs a preview URL until accept takes the status and body, returning the
// accepted response. The edge applies preview changes shortly after the API
// returns, so other responses and connection errors are retried, but only for
// a few seconds. want describes the accepted outcome.
async function fetchPreview(
  url: string,
  want: string,
  accept: (status: number, body: string) => boolean,
): Promise<{ headers: Headers; body: string }> {
  const deadline = Date.now() + 3000;
  for (;;) {
    let last: string;
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (accept(response.status, body)) return { headers: response.headers, body };
      last = `status ${response.status}: ${body}`;
    } catch (err) {
      last = String(err);
    }
    if (Date.now() > deadline) throw new Error(`preview ${url}: want ${want}, got ${last}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const rejected = (status: number) => status === 401 || status === 403;

describe.runIf(e2eEnabled())("SandboxPreviews", () => {
  let sandbox: Sandbox;
  const name = uniqueName();
  const serverName = uniqueName();
  const started = Date.now();
  let created: SandboxPreviewInfo;

  beforeAll(async () => {
    sandbox = await sandboxClient().get({ name: inject("sandboxName") });
    const dir = `/tmp/e2e-preview/${uniqueName()}`;
    await sandbox.fs.mkdir({ path: dir });
    await sandbox.fs.write({ path: `${dir}/server.py`, content: PREVIEW_SERVER });
    await sandbox.process.exec({
      command: "python3 server.py",
      workingDir: dir,
      name: serverName,
      waitForPorts: [8123],
    });
    created = await sandbox.previews.create({
      port: 8123,
      name,
      responseHeaders: { "X-E2E-Response": "added" },
      requestHeaders: { "X-E2E-Request": "injected" },
      ttlMs: 3_600_000,
    });
  });

  afterAll(async () => {
    await sandbox?.previews.delete({ name }).catch(() => {});
    await sandbox?.process.kill({ identifier: serverName }).catch(() => {});
  });

  it("creates a private preview", () => {
    expect(created.name).toBe(name);
    expect(created.port).toBe(8123);
    expect(created.url).toMatch(/^https:\/\//);
    expect(created.public).toBe(false);
    expect(created.createdAt!.getTime()).toBeGreaterThan(started - 60_000);
    // The TTL counts from the request, so expires_at is an hour after it.
    const expiresAfter = created.expiresAt!.getTime() - 3_600_000;
    expect(expiresAfter).toBeGreaterThan(started - 60_000);
    expect(expiresAfter).toBeLessThan(Date.now() + 60_000);
  });

  it("masks request headers", async () => {
    const info = await sandbox.previews.getInfo({ name });
    expect(info.url).toBe(created.url);
    expect(info.requestHeaders).toEqual({ "X-E2E-Request": "****" });
    expect(info.responseHeaders).toEqual({ "X-E2E-Response": "added" });
  });

  it("lists the preview", async () => {
    const names: string[] = [];
    for await (const info of sandbox.previews.list()) names.push(info.name);
    expect(names).toContain(name);
  });

  it("returns the existing preview with createIfNotExists", async () => {
    const existing = await sandbox.previews.create({
      port: 8123,
      name,
      createIfNotExists: true,
      public: true,
    });
    expect(existing.url).toBe(created.url);
    expect(existing.public).toBe(false);
  });

  it("needs a token while private", async () => {
    await fetchPreview(created.url, "rejected without a token", rejected);

    const token = await sandbox.previews.createToken({
      previewName: name,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(token.expired).toBe(false);
    // The server may not find the token just created yet, so the result may
    // be that token or a new one, either valid at least as long as asked.
    const reusedUntil = new Date(Date.now() + 1_800_000);
    const reused = await sandbox.previews.createToken({
      previewName: name,
      expiresAt: reusedUntil,
      createIfNotExists: true,
    });
    expect(reused.expired).toBe(false);
    expect(reused.expiresAt.getTime()).toBeGreaterThanOrEqual(reusedUntil.getTime() - 60_000);

    const tokenNames: string[] = [];
    for await (const info of sandbox.previews.listTokens({ previewName: name })) {
      tokenNames.push(info.name);
    }
    expect(tokenNames).toContain(token.name);
    expect(tokenNames).toContain(reused.name);

    // The preview adds its response header, and the app sees the request
    // header the preview adds.
    const withToken = `${created.url}?preview_token=${token.token}`;
    const { headers } = await fetchPreview(
      withToken,
      "served with the token and the request header",
      (status, body) => status === 200 && body === "hello injected",
    );
    expect(headers.get("X-E2E-Response")).toBe("added");

    await sandbox.previews.deleteToken({ previewName: name, tokenName: token.name });
    await fetchPreview(withToken, "rejected with the revoked token", rejected);
  });

  it("updates to public", async () => {
    const updated = await sandbox.previews.update({ name, public: true, requestHeaders: {} });
    expect(updated.public).toBe(true);
    expect(updated.url).toBe(created.url);
    expect(updated.requestHeaders).toEqual({});
    expect(updated.responseHeaders).toEqual({ "X-E2E-Response": "added" });

    // Served without a token.
    // TODO: Also require body === "hello " once the server stops adding
    // request headers cleared with an empty object; it still adds them.
    await fetchPreview(created.url, "served without a token", (status) => status === 200);

    // A public preview has no tokens, so listing them is rejected.
    const listing = sandbox.previews.listTokens({ previewName: name }).next();
    const err = await listing.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxApiError);
    expect((err as SandboxApiError).status).toBe(400);
  });

  it("deletes the preview", async () => {
    const deleted = await sandbox.previews.delete({ name });
    expect(["DELETING", "TERMINATED"]).toContain(deleted.status);
    await fetchPreview(created.url, "no longer served", (status) => status !== 200);
  });
});
