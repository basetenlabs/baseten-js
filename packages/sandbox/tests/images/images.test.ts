import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  ImageBuildError,
  ImageBuilder,
  ImageUploadError,
  SandboxApiError,
  SandboxClient,
  type ImageIgnoreFileOptions,
  type ImageIgnoreFileProcessorOptions,
  type ImagePushDirectoryRequest,
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

// Read once, since some tests point the temporary directory elsewhere.
const TEMP_ROOT = tmpdir();

function tempDir(): string {
  const dir = mkdtempSync(join(TEMP_ROOT, "sandbox-images-test-"));
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

  it("takes BUILT at the first poll after a push", async () => {
    const server = buildServer([apiImage("BUILT")]);
    const result = await server.client.images.push({
      name: "app",
      files: { Dockerfile: DOCKERFILE },
      ...FAST_WAIT,
    });
    expect(result.status).toBe("BUILT");
    expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(1);
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
    writeFileSync(join(dir, "target.txt"), "linked");
    symlinkSync(join(dir, "target.txt"), join(dir, "link.txt"));
    const outside = tempDir();
    mkdirSync(join(outside, "linked-dir"));
    writeFileSync(join(outside, "linked-dir", "inner.txt"), "not included");
    symlinkSync(join(outside, "linked-dir"), join(dir, "dir-link"));
    symlinkSync(join(outside, "missing"), join(dir, "broken"));

    const server = buildServer([apiImage("BUILDING"), apiImage("BUILT")]);
    await server.client.images.push({ name: "app", directory: dir, ...FAST_WAIT });
    const zip = server.requests[1]!.body;
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(
      ["Dockerfile", "bin/", "bin/run.sh", "dir-link/", "link.txt", "target.txt"].sort(),
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

  it("fails a directory with a link to a file outside it, sending nothing", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Dockerfile"), DOCKERFILE);
    mkdirSync(join(dir, "sub"));
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(dir, "sub", "link.txt"));

    const server = buildServer([apiImage("BUILT")]);
    await expect(
      server.client.images.push({ name: "app", directory: dir, ...FAST_WAIT }),
    ).rejects.toThrow(/link\.txt is a link to .*secret\.txt, outside .*; only links to files/);
    expect(server.requests).toHaveLength(0);
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
      "ignoreFileProcessor without directory",
      {
        name: "app",
        files: { Dockerfile: "" },
        ignoreFileProcessor: () => () => false,
      } as unknown as ImagePushRequest,
      /ignoreFileProcessor and defaultIgnoreFile apply only to directory/,
    ],
    [
      "defaultIgnoreFile without directory",
      {
        name: "app",
        files: { Dockerfile: "" },
        defaultIgnoreFile: () => false,
      } as unknown as ImagePushRequest,
      /ignoreFileProcessor and defaultIgnoreFile apply only to directory/,
    ],
    [
      "tempFile without directory or builder",
      { name: "app", files: { Dockerfile: "" }, tempFile: false } as unknown as ImagePushRequest,
      /tempFile applies only to directory and builder/,
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
    [
      "a zip whose Dockerfile is a link",
      {
        name: "app",
        zip: zipSync({ Dockerfile: [encoder.encode("x"), { os: 3, attrs: 0o120777 << 16 }] }),
      },
      /zip has no Dockerfile file/,
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

// Creates a directory of files by forward-slashed path.
function writeTree(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// Pushes without waiting and returns the uploaded archive's files as text.
async function pushedFiles(
  request: Omit<ImagePushDirectoryRequest, "name">,
): Promise<Record<string, string>> {
  const server = buildServer([]);
  await server.client.images.push({ name: "app", wait: false, ...request });
  const decoder = new TextDecoder();
  return Object.fromEntries(
    Object.entries(unzipSync(server.requests[1]!.body)).map(([path, data]) => [
      path,
      decoder.decode(data),
    ]),
  );
}

describe("ImageClient.push ignore rules", () => {
  it("leaves out the defaults without a .dockerignore", async () => {
    const files = await pushedFiles({
      directory: writeTree({
        Dockerfile: DOCKERFILE,
        "main.py": "print()",
        ".env": "SECRET=1",
        ".git/config": "x",
        "web/node_modules/a": "x",
        "web/.env.local": "nested",
      }),
    });
    expect(Object.keys(files).sort()).toEqual(
      ["Dockerfile", "main.py", "web/", "web/.env.local"].sort(),
    );
  });

  it("uses defaultIgnoreFile instead of the defaults", async () => {
    const files = await pushedFiles({
      directory: writeTree({ Dockerfile: DOCKERFILE, ".env": "SECRET=1" }),
      defaultIgnoreFile: () => false,
    });
    expect(files[".env"]).toBe("SECRET=1");
  });

  it("reads a .dockerignore through ignoreFileProcessor, pruning directories", async () => {
    const dir = writeTree({
      Dockerfile: DOCKERFILE,
      ".dockerignore": "secret.txt\nbuild\n",
      "secret.txt": "x",
      "build/out/a.o": "x",
      // Not left out: a .dockerignore replaces the defaults.
      ".env": "SECRET=1",
    });
    let processorOptions: ImageIgnoreFileProcessorOptions | undefined;
    const checked: ImageIgnoreFileOptions[] = [];
    const files = await pushedFiles({
      directory: dir,
      ignoreFileProcessor: (options) => {
        processorOptions = options;
        // Ignores everything it is asked about, so whatever is kept was
        // never asked about.
        return async (ignoreOptions) => {
          checked.push(ignoreOptions);
          return ignoreOptions.relPath !== ".env";
        };
      },
    });
    expect(processorOptions).toEqual({
      path: join(dir, ".dockerignore"),
      contents: "secret.txt\nbuild\n",
    });
    expect(Object.keys(files).sort()).toEqual([".dockerignore", ".env", "Dockerfile"]);
    // The root Dockerfile and .dockerignore are never asked about, and an
    // ignored directory's contents are not either.
    expect(checked).toEqual([
      { relPath: ".env", isDirectory: false },
      { relPath: "build", isDirectory: true },
      { relPath: "secret.txt", isDirectory: false },
    ]);
  });

  it("fails before sending anything when a .dockerignore has no processor", async () => {
    const server = buildServer([]);
    await expect(
      server.client.images.push({
        name: "app",
        directory: writeTree({ Dockerfile: DOCKERFILE, ".dockerignore": "x\n" }),
      }),
    ).rejects.toThrow(/\.dockerignore exists but ignoreFileProcessor is not set/);
    expect(server.requests).toEqual([]);
  });

  it("fails before sending anything when the ignore function throws", async () => {
    const server = buildServer([]);
    await expect(
      server.client.images.push({
        name: "app",
        directory: writeTree({ Dockerfile: DOCKERFILE, "a.txt": "a" }),
        defaultIgnoreFile: () => {
          throw new Error("bad pattern");
        },
      }),
    ).rejects.toThrow("bad pattern");
    expect(server.requests).toEqual([]);
  });
});

interface Upload {
  headers: IncomingHttpHeaders;
  body: Uint8Array;

  /** What was in the temporary directory while the upload was received. */
  tempEntries: string[];
}

// Takes uploads on a real local server, so they are what fetch actually
// sends, and fakes everything else. Temporary files go to a fresh directory,
// listed during each upload.
async function uploadServer(uploadStatus = 200) {
  const scratch = tempDir();
  vi.stubEnv("TMPDIR", scratch);
  vi.stubEnv("TEMP", scratch);
  vi.stubEnv("TMP", scratch);
  const uploads: Upload[] = [];
  const server = createServer((request, response) => {
    const tempEntries = readdirSync(scratch, { recursive: true, encoding: "utf8" });
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      uploads.push({
        headers: request.headers,
        body: new Uint8Array(Buffer.concat(chunks)),
        tempEntries,
      });
      response.writeHead(uploadStatus).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const uploadUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/zip`;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === uploadUrl) return fetch(input, init);
    if (url.pathname === "/v1/token") {
      return Response.json({
        token: "token-1",
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        teams: [],
      });
    }
    return Response.json(
      { name: "app", status: "UPLOADING", upload_url: uploadUrl },
      { status: 202 },
    );
  };
  const client = new SandboxClient({ apiKey: "test-key", fetch: fetchImpl as typeof fetch });
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { client, uploads, scratch, close };
}

describe("ImageClient.push temporary file", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("zips a directory into a temporary file, uploaded with its length, then removed", async () => {
    const server = await uploadServer();
    try {
      const dir = writeTree({ Dockerfile: DOCKERFILE, "a.txt": "a" });
      await server.client.images.push({ name: "app", directory: dir, wait: false });
      const [upload] = server.uploads;
      expect(upload!.headers["content-length"]).toBe(String(upload!.body.length));
      expect(upload!.headers["transfer-encoding"]).toBeUndefined();
      expect(Object.keys(unzipSync(upload!.body)).sort()).toEqual(["Dockerfile", "a.txt"]);
      expect(upload!.tempEntries).toHaveLength(2);
      expect(upload!.tempEntries).toContainEqual(expect.stringMatching(/^baseten-image-[^/\\]+$/));
      expect(upload!.tempEntries).toContainEqual(
        expect.stringMatching(/^baseten-image-[^/\\]+[/\\]image\.zip$/),
      );
      expect(readdirSync(server.scratch)).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("removes the temporary file when the upload fails", async () => {
    const server = await uploadServer(403);
    try {
      const dir = writeTree({ Dockerfile: DOCKERFILE });
      await expect(
        server.client.images.push({ name: "app", directory: dir, wait: false }),
      ).rejects.toBeInstanceOf(ImageUploadError);
      expect(server.uploads[0]!.tempEntries).toHaveLength(2);
      expect(readdirSync(server.scratch)).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("zips in memory when tempFile is false", async () => {
    const server = await uploadServer();
    try {
      const dir = writeTree({ Dockerfile: DOCKERFILE });
      await server.client.images.push({
        name: "app",
        directory: dir,
        tempFile: false,
        wait: false,
      });
      const [upload] = server.uploads;
      expect(upload!.headers["content-length"]).toBe(String(upload!.body.length));
      expect(upload!.tempEntries).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("stops on abort while zipping, removing the temporary file", async () => {
    const server = await uploadServer();
    try {
      const controller = new AbortController();
      const dir = writeTree({ Dockerfile: DOCKERFILE, "z.txt": "z" });
      await expect(
        server.client.images.push({
          name: "app",
          directory: dir,
          // Aborts on the last path walked, so the walk finishes and the
          // abort is seen once zipping into the temporary file has begun.
          defaultIgnoreFile: ({ relPath }) => {
            if (relPath === "z.txt") controller.abort(new Error("stop"));
            return false;
          },
          callOptions: { signal: controller.signal },
        }),
      ).rejects.toThrow("stop");
      expect(server.uploads).toEqual([]);
      expect(readdirSync(server.scratch)).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("spools a builder only when it has local files", async () => {
    const server = await uploadServer();
    try {
      const dir = writeTree({ "tool.sh": "#!/bin/sh\n" });
      const builder = ImageBuilder.fromRegistry("debian:bookworm-slim");
      await server.client.images.push({ name: "app", builder, wait: false });
      await server.client.images.push({
        name: "app",
        builder: builder.addLocalFile(join(dir, "tool.sh"), "/usr/local/bin/tool"),
        wait: false,
      });
      expect(server.uploads.map((upload) => upload.tempEntries.length)).toEqual([0, 2]);
      expect(readdirSync(server.scratch)).toEqual([]);
    } finally {
      server.close();
    }
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

  it("lists library images", async () => {
    const server = fakeServer(() => ({
      items: [
        {
          name: "full",
          display_name: "Full",
          description: "Short",
          long_description: "Long",
          image: "baseten/full:latest",
          memory: 8192,
          ports: [{ target: 8080, name: "http", protocol: "HTTP" }],
          categories: ["dev"],
          tags: ["python"],
          url: "https://docs.example/full",
          icon: "https://icons.example/full.svg",
          icon_light: "https://icons.example/full-light.svg",
          icon_dark: "https://icons.example/full-dark.svg",
          enterprise: true,
          hidden: false,
          coming_soon: false,
          creation_options: {
            extra_args: { kernel: "6.1" },
            volumes: [
              { name: "scratch", mount_path: "/scratch", type: "ephemeral", size_mb: 1024 },
              { name: "data", mount_path: "/data", read_only: true },
            ],
          },
        },
        { name: "bare", image: "baseten/bare:latest" },
      ],
    }));
    const images = server.client.withOptions({ teamId: "team-1" }).images;
    expect(await images.listLibrary()).toEqual([
      {
        name: "full",
        displayName: "Full",
        description: "Short",
        longDescription: "Long",
        image: "baseten/full:latest",
        memory: 8192,
        ports: [{ target: 8080, name: "http", protocol: "HTTP" }],
        categories: ["dev"],
        tags: ["python"],
        url: "https://docs.example/full",
        icon: "https://icons.example/full.svg",
        iconLight: "https://icons.example/full-light.svg",
        iconDark: "https://icons.example/full-dark.svg",
        enterprise: true,
        creationExtraArgs: { kernel: "6.1" },
        creationVolumes: [
          {
            name: "scratch",
            mountPath: "/scratch",
            type: "ephemeral",
            sizeMb: 1024,
            readOnly: false,
          },
          { name: "data", mountPath: "/data", type: undefined, sizeMb: undefined, readOnly: true },
        ],
      },
      {
        name: "bare",
        displayName: undefined,
        description: undefined,
        longDescription: undefined,
        image: "baseten/bare:latest",
        memory: undefined,
        ports: [],
        categories: [],
        tags: [],
        url: undefined,
        icon: undefined,
        iconLight: undefined,
        iconDark: undefined,
        enterprise: false,
        creationExtraArgs: undefined,
        creationVolumes: [],
      },
    ]);
    expect(server.requests.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`)).toEqual([
      // No team, since library images are the same for every team.
      "GET /v1/sandboxes/library_images",
    ]);
  });
});

// A build log page as the server sends it, newest first: entries numbered
// from first down, each a second apart.
function logPage(first: number, count: number, total: number) {
  return {
    logs: Array.from({ length: count }, (_, i) => ({
      timestamp: new Date(Date.UTC(2026, 9, 1) + (first - i) * 1000).toISOString(),
      message: `line ${first - i}`,
      severity: 9,
    })),
    total_count: total,
  };
}

describe("ImageClient.logs", () => {
  it("gets every page, oldest first, with the end time pinned", async () => {
    const server = fakeServer((request) =>
      request.url.searchParams.get("offset") === "0"
        ? logPage(1500, 1000, 1500)
        : logPage(500, 500, 1500),
    );
    const lines = await server.client.images.logs({ name: "app" });
    expect(lines).toHaveLength(1500);
    expect(lines[0]).toEqual({
      timestamp: new Date(Date.UTC(2026, 9, 1) + 1000),
      severity: 9,
      text: "line 1",
    });
    expect(lines.at(-1)!.text).toBe("line 1500");
    const queries = server.requests.map((r) => r.url.searchParams);
    expect(server.requests.map((r) => r.url.pathname)).toEqual([
      "/v1/sandboxes/images/app/logs",
      "/v1/sandboxes/images/app/logs",
    ]);
    expect(queries.map((q) => q.get("offset"))).toEqual(["0", "1000"]);
    expect(queries.map((q) => q.get("limit"))).toEqual(["1000", "1000"]);
    expect(queries[0]!.get("end_time")).not.toBeNull();
    expect(queries[1]!.get("end_time")).toBe(queries[0]!.get("end_time"));
    expect(queries[0]!.has("start_time")).toBe(false);
  });

  it("sends the given range, and stops at a short page", async () => {
    const server = fakeServer(() => logPage(2, 2, 2));
    const lines = await server.client.images.logs({
      name: "app",
      startTime: new Date("2026-10-01T00:00:00Z"),
      endTime: new Date("2026-10-01T01:00:00Z"),
    });
    expect(lines.map((line) => line.text)).toEqual(["line 1", "line 2"]);
    expect(server.requests).toHaveLength(1);
    const query = server.requests[0]!.url.searchParams;
    expect(query.get("start_time")).toBe("2026-10-01T00:00:00.000Z");
    expect(query.get("end_time")).toBe("2026-10-01T01:00:00.000Z");
  });

  it("stops at the 11,000 most recent lines", async () => {
    const server = fakeServer((request) => {
      const offset = Number(request.url.searchParams.get("offset"));
      return logPage(50_000 - offset, 1000, 50_000);
    });
    const lines = await server.client.images.logs({ name: "app" });
    expect(lines).toHaveLength(11_000);
    expect(server.requests.map((r) => r.url.searchParams.get("offset"))).toEqual(
      Array.from({ length: 11 }, (_, i) => String(i * 1000)),
    );
    expect(lines[0]!.text).toBe("line 39001");
    expect(lines.at(-1)!.text).toBe("line 50000");
  });

  it("returns nothing for an empty range", async () => {
    const server = fakeServer(() => ({ logs: [], total_count: 0 }));
    expect(await server.client.images.logs({ name: "app" })).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });
});
