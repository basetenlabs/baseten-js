import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import {
  ImageBuildError,
  ImageUploadError,
  SandboxApiError,
  SandboxClient,
  type ImagePushRequest,
} from "../../src/index";

const UPLOAD_URL = "https://uploads.b10.run/images/app/20260929/source.zip?signature=test";

interface Recorded {
  method: string;
  url: URL;
  authorization: string | null;
  contentType: string | null;
  body: Uint8Array;
}

// Serves /v1/token and hands every other request, including uploads, to
// route. A plain value becomes a JSON response.
function fakeServer(route: (request: Recorded) => unknown) {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/v1/token") {
      return Response.json({
        token: "token-1",
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        teams: [],
      });
    }
    const recorded: Recorded = {
      method: request.method,
      url,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body: new Uint8Array(await request.arrayBuffer()),
    };
    requests.push(recorded);
    const routed = route(recorded);
    if (routed instanceof Response) return routed;
    // The spec's success code for a push is 202.
    const status =
      recorded.method === "POST" && url.pathname === "/v1/sandboxes/images" ? 202 : 200;
    return Response.json(routed, { status });
  };
  const client = new SandboxClient({ apiKey: "test-key", fetch: fetchImpl as typeof fetch });
  return { client, requests };
}

function json(request: Recorded): unknown {
  return JSON.parse(new TextDecoder().decode(request.body));
}

function apiImage(status: string, extra: Record<string, unknown> = {}) {
  return { name: "app", status, tags: [], ...extra };
}

// Answers a push with an upload URL, the upload with 200, and each image get
// with the next of the given responses, repeating the last.
function buildServer(gets: unknown[]) {
  let getCount = 0;
  return fakeServer((request) => {
    if (request.url.host === "uploads.b10.run") return new Response(null, { status: 200 });
    if (request.method === "POST")
      return { name: "app", status: "UPLOADING", upload_url: UPLOAD_URL };
    const response = gets[Math.min(getCount++, gets.length - 1)];
    return response;
  });
}

const FAST_WAIT = { pollIntervalMs: 1 };
const DOCKERFILE = "FROM debian:bookworm-slim\n";
const encoder = new TextEncoder();

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-images-test-"));
  tempDirs.push(dir);
  return dir;
}

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("ImageClient.push", () => {
  it("pushes files: uploads a zip without auth, then waits for BUILT", async () => {
    const server = buildServer([
      apiImage("UPLOADING"),
      apiImage("BUILDING"),
      apiImage("BUILT", { size: 42, tag_count: 1, created_at: "2026-09-29T00:00:00Z" }),
    ]);
    const result = await server.client.images.push({
      name: "app",
      files: { Dockerfile: DOCKERFILE, "hello.txt": "hi" },
      ...FAST_WAIT,
    });
    expect(result).toEqual({
      name: "app",
      status: "BUILT",
      sizeBytes: 42,
      tagCount: 1,
      createdAt: new Date("2026-09-29T00:00:00Z"),
      displayName: undefined,
      updatedAt: undefined,
      lastDeployedAt: undefined,
    });

    const [push, upload, ...gets] = server.requests;
    expect(push!.url.pathname).toBe("/v1/sandboxes/images");
    expect(push!.authorization).toBe("Bearer token-1");
    expect(json(push!)).toEqual({ name: "app" });
    expect(upload!.method).toBe("PUT");
    expect(upload!.url.href).toBe(UPLOAD_URL);
    expect(upload!.authorization).toBeNull();
    expect(upload!.contentType).toBe("application/zip");
    const files = unzipSync(upload!.body);
    expect(new TextDecoder().decode(files.Dockerfile)).toBe(DOCKERFILE);
    expect(new TextDecoder().decode(files["hello.txt"])).toBe("hi");
    expect(gets.map((g) => g.url.pathname)).toEqual(Array(3).fill("/v1/sandboxes/images/app"));
  });

  it("does not take a previous version's BUILT as this push's outcome", async () => {
    const server = buildServer([apiImage("BUILT"), apiImage("BUILDING"), apiImage("BUILT")]);
    await server.client.images.push({
      name: "app",
      files: { Dockerfile: DOCKERFILE },
      ...FAST_WAIT,
    });
    expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(3);
  });

  it("does not take a previous version's FAILED as this push's outcome", async () => {
    const server = buildServer([apiImage("FAILED"), apiImage("BUILDING"), apiImage("BUILT")]);
    const result = await server.client.images.push({
      name: "app",
      files: { Dockerfile: DOCKERFILE },
      ...FAST_WAIT,
    });
    expect(result.status).toBe("BUILT");
  });

  it("throws ImageBuildError when the build fails", async () => {
    const server = buildServer([apiImage("BUILDING"), apiImage("FAILED")]);
    const error = await server.client.images
      .push({ name: "app", files: { Dockerfile: DOCKERFILE }, ...FAST_WAIT })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ImageBuildError);
    expect(error).toMatchObject({ imageName: "app", status: "FAILED", timedOut: false });
  });

  it("throws a timed-out ImageBuildError when the wait runs out", async () => {
    const server = buildServer([apiImage("BUILDING")]);
    const error = await server.client.images
      .push({
        name: "app",
        files: { Dockerfile: DOCKERFILE },
        timeoutMs: 50,
        pollIntervalMs: 10,
      })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ImageBuildError);
    expect(error).toMatchObject({ imageName: "app", status: "BUILDING", timedOut: true });
  });

  it("rides out 404 and gateway errors while waiting", async () => {
    const server = buildServer([
      new Response('{"error":"NOT_FOUND"}', { status: 404 }),
      new Response("bad gateway", { status: 502 }),
      apiImage("BUILDING"),
      apiImage("BUILT"),
    ]);
    const result = await server.client.images.push({
      name: "app",
      files: { Dockerfile: DOCKERFILE },
      ...FAST_WAIT,
    });
    expect(result.status).toBe("BUILT");
  });

  it("stops waiting on other errors", async () => {
    const server = buildServer([
      apiImage("BUILDING"),
      new Response('{"error":"INTERNAL","message":"boom"}', { status: 500 }),
    ]);
    const error = await server.client.images
      .push({ name: "app", files: { Dockerfile: DOCKERFILE }, ...FAST_WAIT })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SandboxApiError);
    expect(error).toMatchObject({ status: 500 });
  });

  it("rejects with the caller's abort, not a timeout", async () => {
    const server = buildServer([apiImage("BUILDING")]);
    const controller = new AbortController();
    const pushed = server.client.images.push({
      name: "app",
      files: { Dockerfile: DOCKERFILE },
      pollIntervalMs: 10,
      callOptions: { signal: controller.signal },
    });
    setTimeout(() => controller.abort(new Error("stop")), 30);
    await expect(pushed).rejects.toThrow("stop");
  });

  it("returns the push response without waiting when wait is false", async () => {
    const server = buildServer([]);
    const result = await server.client.images.push({
      name: "app",
      files: { Dockerfile: DOCKERFILE },
      wait: false,
    });
    expect(result).toStrictEqual({ name: "app", status: "UPLOADING" });
    expect(server.requests.map((r) => r.method)).toEqual(["POST", "PUT"]);
  });

  it("imports a registry image without uploading", async () => {
    let gets = 0;
    const server = fakeServer((request) => {
      if (request.method === "POST") return { name: "app", status: "BUILDING" };
      return apiImage(gets++ === 0 ? "BUILDING" : "BUILT");
    });
    const result = await server.client.images.push({
      name: "app",
      registryImage: "ghcr.io/org/app:v2",
      dockerConfig: '{"auths":{}}',
      ...FAST_WAIT,
    });
    expect(result.status).toBe("BUILT");
    expect(json(server.requests[0]!)).toEqual({
      name: "app",
      image: "ghcr.io/org/app:v2",
      docker_config: '{"auths":{}}',
    });
    expect(server.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("throws ImageUploadError when storage rejects the upload, without waiting", async () => {
    const server = fakeServer((request) => {
      if (request.url.host === "uploads.b10.run") {
        return new Response("<Error>SignatureDoesNotMatch</Error>", { status: 403 });
      }
      return { name: "app", status: "UPLOADING", upload_url: UPLOAD_URL };
    });
    const error = await server.client.images
      .push({ name: "app", files: { Dockerfile: DOCKERFILE } })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ImageUploadError);
    expect(error).toMatchObject({
      imageName: "app",
      status: 403,
      body: "<Error>SignatureDoesNotMatch</Error>",
    });
    expect(server.requests.map((r) => r.method)).toEqual(["POST", "PUT"]);
  });

  it("uploads a given zip as is", async () => {
    const zip = zipSync({ Dockerfile: encoder.encode(DOCKERFILE) });
    const server = buildServer([apiImage("BUILDING"), apiImage("BUILT")]);
    await server.client.images.push({ name: "app", zip, ...FAST_WAIT });
    expect(server.requests[1]!.body).toEqual(zip);
  });

  it("zips a directory with modes, following file links but not directory links", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Dockerfile"), DOCKERFILE);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "run.sh"), "#!/bin/sh\n");
    chmodSync(join(dir, "bin", "run.sh"), 0o755);
    const outside = tempDir();
    writeFileSync(join(outside, "target.txt"), "linked");
    mkdirSync(join(outside, "linked-dir"));
    writeFileSync(join(outside, "linked-dir", "inner.txt"), "not included");
    symlinkSync(join(outside, "target.txt"), join(dir, "link.txt"));
    symlinkSync(join(outside, "linked-dir"), join(dir, "dir-link"));
    symlinkSync(join(outside, "missing"), join(dir, "broken"));

    const server = buildServer([apiImage("BUILDING"), apiImage("BUILT")]);
    await server.client.images.push({ name: "app", directory: dir, ...FAST_WAIT });
    const zip = server.requests[1]!.body;
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(
      ["Dockerfile", "bin/", "bin/run.sh", "dir-link/", "link.txt"].sort(),
    );
    expect(new TextDecoder().decode(files["link.txt"])).toBe("linked");
    // Windows has no Unix permission bits, so every file reads as 0666 there.
    if (process.platform !== "win32" && hasCommand("unzip")) {
      const zipPath = join(tempDir(), "out.zip");
      writeFileSync(zipPath, zip);
      expect(execFileSync("unzip", ["-Z", zipPath], { encoding: "utf8" })).toMatch(
        /-rwxr-xr-x .* bin\/run\.sh/,
      );
    }
  });
});

describe("ImageClient.push validation", () => {
  const cases: [string, ImagePushRequest, RegExp][] = [
    ["no source", { name: "app" } as ImagePushRequest, /exactly one of .* got none/],
    [
      "two sources",
      {
        name: "app",
        files: { Dockerfile: "" },
        registryImage: "x.io/a",
      } as unknown as ImagePushRequest,
      /exactly one of .* got registryImage, files/,
    ],
    [
      "dockerConfig without registryImage",
      { name: "app", files: { Dockerfile: "" }, dockerConfig: "{}" } as unknown as ImagePushRequest,
      /dockerConfig applies only to registryImage/,
    ],
    [
      "files without a Dockerfile",
      { name: "app", files: { "a.txt": "a" } },
      /files has no Dockerfile/,
    ],
    [
      "files with an escaping path",
      { name: "app", files: { Dockerfile: "", "../etc/passwd": "x" } },
      /must be relative/,
    ],
    [
      "files with an absolute path",
      { name: "app", files: { Dockerfile: "", "/abs": "x" } },
      /must be relative/,
    ],
    [
      "a zip without a Dockerfile",
      { name: "app", zip: zipSync({ "a.txt": encoder.encode("a") }) },
      /zip has no Dockerfile/,
    ],
    ["a zip that is not a zip", { name: "app", zip: encoder.encode("nope") }, /not a zip archive/],
  ];

  for (const [description, request, message] of cases) {
    it(`rejects ${description} before sending anything`, async () => {
      const server = buildServer([]);
      await expect(server.client.images.push(request)).rejects.toThrow(message);
      expect(server.requests).toEqual([]);
    });
  }

  it("rejects a directory without a Dockerfile before reading it", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "a");
    const server = buildServer([]);
    await expect(server.client.images.push({ name: "app", directory: dir })).rejects.toThrow(
      /has no Dockerfile at its root/,
    );
    expect(server.requests).toEqual([]);
  });
});

describe("ImageClient", () => {
  it("lists images across pages, with filters and team", async () => {
    // The middle page is empty but has more, as the spec warns can happen.
    const pages: Record<string, unknown> = {
      "": {
        items: [apiImage("BUILT", { name: "a1" })],
        pagination: { has_more: true, cursor: "c1" },
      },
      c1: { items: [], pagination: { has_more: true, cursor: "c2" } },
      c2: { items: [apiImage("BUILT", { name: "a2" })], pagination: { has_more: false } },
    };
    const server = fakeServer((request) => pages[request.url.searchParams.get("cursor") ?? ""]);
    const client = server.client.withOptions({ teamId: "team-1" });
    const names: string[] = [];
    for await (const image of client.images.list({
      namePrefix: "a",
      sort: "name:asc",
      pageSize: 5,
    })) {
      names.push(image.name);
    }
    expect(names).toEqual(["a1", "a2"]);
    expect(server.requests).toHaveLength(3);
    const first = server.requests[0]!.url.searchParams;
    expect(Object.fromEntries(first)).toEqual({
      team_id: "team-1",
      q: "a",
      sort: "name:asc",
      limit: "5",
    });
  });

  it("stops listing on a repeated cursor", async () => {
    const server = fakeServer(() => ({
      items: [],
      pagination: { has_more: true, cursor: "same" },
    }));
    const iterate = async () => {
      for await (const _ of server.client.images.list()) void _;
    };
    await expect(iterate()).rejects.toThrow("image list returned a repeated cursor");
  });

  it("lists tags, deletes a tag, gets, deletes, and cleans up", async () => {
    const server = fakeServer((request) => {
      const path = request.url.pathname;
      if (path.endsWith("/tags")) {
        return {
          items: [{ name: "v1", size: 7, created_at: "2026-09-29T00:00:00Z" }],
          pagination: { has_more: false },
        };
      }
      if (path === "/v1/sandboxes/cleanup_images") return { deleted: 3, message: "done" };
      return apiImage("BUILT");
    });
    const images = server.client.images;
    const tags = [];
    for await (const tag of images.listTags({ name: "app", namePrefix: "v" })) tags.push(tag);
    expect(tags).toEqual([
      {
        name: "v1",
        sizeBytes: 7,
        createdAt: new Date("2026-09-29T00:00:00Z"),
        updatedAt: undefined,
      },
    ]);
    await images.deleteTag({ name: "app", tag: "v1" });
    expect((await images.getInfo({ name: "app" })).status).toBe("BUILT");
    await images.delete({ name: "app" });
    expect(await images.cleanup()).toEqual({ deleted: 3, message: "done" });
    expect(server.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "GET /v1/sandboxes/images/app/tags",
      "DELETE /v1/sandboxes/images/app/tags/v1",
      "GET /v1/sandboxes/images/app",
      "DELETE /v1/sandboxes/images/app",
      "POST /v1/sandboxes/cleanup_images",
    ]);
  });

  it("waitBuilt accepts BUILT immediately", async () => {
    const server = fakeServer(() => apiImage("BUILT"));
    expect((await server.client.images.waitBuilt({ name: "app" })).status).toBe("BUILT");
    expect(server.requests).toHaveLength(1);
  });
});
