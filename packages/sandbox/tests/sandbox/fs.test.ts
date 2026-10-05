import { describe, expect, it, vi } from "vitest";
import { SandboxClient, SandboxFileSystemCopyError, SandboxGatewayError } from "../../src/index";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  request: Request;
}

// A sandbox whose every request goes to route, recorded first. Each recorded
// request keeps an unread copy, so its body can be read in any form.
function fakeSandbox(route: (request: Recorded, index: number) => Response | Promise<Response>) {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const recorded: Recorded = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      request: request.clone(),
    };
    requests.push(recorded);
    return route(recorded, requests.length - 1);
  };
  const sandbox = new SandboxClient({
    apiKey: "",
    tokenProvider: async () => "token",
    fetch: fetchImpl as typeof fetch,
  }).sandboxFromUrl({ url: "https://sbx.example" });
  return { sandbox, requests };
}

// Runs a call that backs off before retrying, without waiting out the backoff.
async function skippingBackoff<T>(call: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const result = call();
    await vi.runAllTimersAsync();
    return await result;
  } finally {
    vi.useRealTimers();
  }
}

function ok(): Response {
  return Response.json({ message: "ok" });
}

function gateway(): Response {
  return new Response("bad gateway", { status: 502 });
}

function apiFile(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    path: `/work/${name}`,
    size: 5,
    permissions: "-rw-r--r--",
    owner: "root",
    group: "root",
    lastModified: "2026-09-30T10:00:00Z",
    ...extra,
  };
}

function apiProcess(extra: Record<string, unknown> = {}) {
  return {
    pid: "7",
    name: "cp",
    command: "cp",
    status: "running",
    exitCode: 0,
    stdout: "",
    stderr: "",
    logs: "",
    workingDir: "",
    startedAt: "2026-09-30T10:00:00Z",
    completedAt: null,
    ...extra,
  };
}

const MB = 1024 * 1024;

// Answers the multipart upload endpoints with upload ID "up-1", and anything
// else with ok. A part upload gets part's response when it returns one.
function multipart(
  part?: (
    request: Recorded,
    partNumber: number,
  ) => Response | undefined | Promise<Response | undefined>,
) {
  return async (request: Recorded) => {
    if (request.path.startsWith("/filesystem-multipart/initiate/")) {
      return Response.json({ uploadId: "up-1", path: "/work" });
    }
    if (request.path === "/filesystem-multipart/up-1/part") {
      const partNumber = Number(request.query.get("partNumber"));
      return (
        (await part?.(request, partNumber)) ?? Response.json({ etag: `e${partNumber}`, partNumber })
      );
    }
    return ok();
  };
}

// The part uploads among requests.
function partRequests(requests: Recorded[]): Recorded[] {
  return requests.filter((recorded) => recorded.path === "/filesystem-multipart/up-1/part");
}

// The content of each part upload in requests, by part number, the last
// attempt winning.
async function partContents(requests: Recorded[]): Promise<Map<number, Uint8Array>> {
  const contents = new Map<number, Uint8Array>();
  for (const recorded of partRequests(requests)) {
    const file = (await recorded.request.formData()).get("file") as File;
    contents.set(
      Number(recorded.query.get("partNumber")),
      new Uint8Array(await file.arrayBuffer()),
    );
  }
  return contents;
}

// The parts in contents, joined in part number order.
function joinParts(contents: Map<number, Uint8Array>): Uint8Array {
  const numbers = [...contents.keys()].sort((a, b) => a - b);
  const joined = new Uint8Array(numbers.reduce((size, n) => size + contents.get(n)!.length, 0));
  let offset = 0;
  for (const n of numbers) {
    joined.set(contents.get(n)!, offset);
    offset += contents.get(n)!.length;
  }
  return joined;
}

// Bytes whose pattern does not line up with 5MB, so a part off by any number
// of bytes changes the joined result.
function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return bytes;
}

// Compared in a loop, since a deep equality failure on megabytes is unreadable.
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A streamed body sending each chunk as is, noting whether it was cancelled.
function streamed(chunks: string[]): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body), cancelled: () => cancelled };
}

describe("SandboxFileSystem", () => {
  it("reads bytes as octets", async () => {
    const { sandbox, requests } = fakeSandbox(
      () =>
        new Response(new Uint8Array([0, 1, 255]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    expect(await sandbox.fs.readBytes({ path: "/work/a b%.bin" })).toEqual(
      new Uint8Array([0, 1, 255]),
    );
    expect(requests[0]!.headers.get("accept")).toBe("application/octet-stream");
    expect(requests[0]!.path).toBe("/filesystem/%2Fwork%2Fa%20b%25.bin");
  });

  it("fails to read a directory as bytes", async () => {
    const { sandbox } = fakeSandbox(() =>
      Response.json({ name: "work", path: "/work", files: [], subdirectories: [] }),
    );
    await expect(sandbox.fs.readBytes({ path: "/work" })).rejects.toThrow(
      "/work is a directory, not a file",
    );
  });

  it("writes text, retrying a gateway error", async () => {
    const { sandbox, requests } = fakeSandbox((_, index) => (index === 0 ? gateway() : ok()));
    await skippingBackoff(() => sandbox.fs.write({ path: "/work/a.txt", content: "hello" }));
    expect(requests).toHaveLength(2);
    expect(requests[1]!.method).toBe("PUT");
    expect(await requests[1]!.request.json()).toEqual({ content: "hello" });
  });

  it("writes bytes as a form, rebuilt for each attempt", async () => {
    const { sandbox, requests } = fakeSandbox((_, index) => (index === 0 ? gateway() : ok()));
    await skippingBackoff(() =>
      sandbox.fs.writeBytes({
        path: "/work/run.sh",
        content: new Uint8Array([35, 33]),
        permissions: "0755",
      }),
    );
    expect(requests).toHaveLength(2);
    for (const recorded of requests) {
      expect(recorded.method).toBe("PUT");
      expect(recorded.path).toBe("/filesystem/%2Fwork%2Frun.sh");
      expect(recorded.headers.get("authorization")).toBe("Bearer token");
      const form = await recorded.request.formData();
      const file = form.get("file") as File;
      expect(file.name).toBe("run.sh");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([35, 33]));
      expect(form.get("permissions")).toBe("0755");
      expect(form.get("path")).toBe("/work/run.sh");
    }
  });

  it("writes bytes from a blob without permissions when unset", async () => {
    const { sandbox, requests } = fakeSandbox(ok);
    await sandbox.fs.writeBytes({ path: "/work/a.bin", content: new Blob(["hi"]) });
    const form = await requests[0]!.request.formData();
    expect(await (form.get("file") as File).text()).toBe("hi");
    expect(form.has("permissions")).toBe(false);
  });

  it("fails a byte write with the sandbox's error", async () => {
    const { sandbox } = fakeSandbox(() => Response.json({ error: "disk full" }, { status: 500 }));
    await expect(
      sandbox.fs.writeBytes({ path: "/work/a.bin", content: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ status: 500, message: expect.stringContaining("disk full") });
  });

  it("writes bytes over 5MB in 5MB parts, every byte exactly once", async () => {
    const { sandbox, requests } = fakeSandbox(multipart());
    const content = pattern(12 * MB + 17);
    await sandbox.fs.writeBytes({ path: "/work/big.bin", content, permissions: "0755" });

    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/filesystem-multipart/initiate/%2Fwork%2Fbig.bin",
    });
    expect(await requests[0]!.request.json()).toEqual({ permissions: "0755" });
    expect(partRequests(requests).map((recorded) => recorded.method)).toEqual([
      "PUT",
      "PUT",
      "PUT",
    ]);
    const contents = await partContents(requests);
    expect([1, 2, 3].map((n) => contents.get(n)?.length)).toEqual([5 * MB, 5 * MB, 2 * MB + 17]);
    expect(sameBytes(joinParts(contents), content)).toBe(true);
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/filesystem-multipart/up-1/complete",
    });
    expect(await requests.at(-1)!.request.json()).toEqual({
      parts: [
        { partNumber: 1, etag: "e1" },
        { partNumber: 2, etag: "e2" },
        { partNumber: 3, etag: "e3" },
      ],
    });
  });

  it("writes exactly 5MB of bytes in one request", async () => {
    const { sandbox, requests } = fakeSandbox(ok);
    await sandbox.fs.writeBytes({ path: "/work/a.bin", content: new Uint8Array(5 * MB) });
    expect(requests.map((recorded) => recorded.path)).toEqual(["/filesystem/%2Fwork%2Fa.bin"]);
  });

  it("writes text over 5MB of UTF-8 in parts, without permissions", async () => {
    const { sandbox, requests } = fakeSandbox(multipart());
    // Two bytes each, so over 5MB while under 5M characters.
    const content = "é".repeat(2.5 * MB + 1);
    await sandbox.fs.write({ path: "/work/big.txt", content });
    expect(await requests[0]!.request.json()).toEqual({});
    expect(partRequests(requests)).toHaveLength(2);
    expect(new TextDecoder().decode(joinParts(await partContents(requests)))).toBe(content);
  });

  it("writes text of up to 5MB of UTF-8 in one request", async () => {
    const { sandbox, requests } = fakeSandbox(ok);
    // Long enough that its UTF-8 must be measured, but 4MB of it.
    const content = "é".repeat(2 * MB);
    await sandbox.fs.write({ path: "/work/a.txt", content });
    expect(requests.map((recorded) => recorded.path)).toEqual(["/filesystem/%2Fwork%2Fa.txt"]);
    expect(await requests[0]!.request.json()).toEqual({ content });
  });

  it("retries a part after a gateway error, rebuilding its form", async () => {
    let failed = false;
    const { sandbox, requests } = fakeSandbox(
      multipart((_, partNumber) => {
        if (partNumber !== 2 || failed) return undefined;
        failed = true;
        return gateway();
      }),
    );
    const content = pattern(12 * MB + 17);
    await skippingBackoff(() => sandbox.fs.writeBytes({ path: "/work/big.bin", content }));
    expect(partRequests(requests)).toHaveLength(4);
    expect(sameBytes(joinParts(await partContents(requests)), content)).toBe(true);
    expect((await requests.at(-1)!.request.json()).parts).toHaveLength(3);
  });

  it("completes with the parts in order when they finish out of order", async () => {
    let finishFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (finishFirst = resolve));
    const { sandbox, requests } = fakeSandbox(
      multipart(async (_, partNumber) => {
        if (partNumber === 1) await firstHeld;
        if (partNumber === 2) finishFirst();
        return undefined;
      }),
    );
    await sandbox.fs.writeBytes({ path: "/work/big.bin", content: pattern(12 * MB + 17) });
    expect(
      (await requests.at(-1)!.request.json()).parts.map(
        (part: { partNumber: number }) => part.partNumber,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("aborts the upload when a part fails, with the part's error", async () => {
    const { sandbox, requests } = fakeSandbox(
      multipart((_, partNumber) =>
        partNumber === 2 ? Response.json({ error: "disk full" }, { status: 500 }) : undefined,
      ),
    );
    await expect(
      sandbox.fs.writeBytes({ path: "/work/big.bin", content: pattern(12 * MB + 17) }),
    ).rejects.toMatchObject({ status: 500, message: expect.stringContaining("disk full") });
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/filesystem-multipart/up-1/abort",
    });
    expect(requests.some((recorded) => recorded.path.endsWith("/complete"))).toBe(false);
    // The third part is never started once the second fails.
    expect(partRequests(requests).map((recorded) => recorded.query.get("partNumber"))).toEqual([
      "1",
      "2",
    ]);
  });

  it("aborts the upload when completing fails, keeping that error if aborting fails too", async () => {
    const { sandbox, requests } = fakeSandbox(async (recorded) => {
      if (recorded.path.endsWith("/complete")) {
        return Response.json({ error: "assembly failed" }, { status: 500 });
      }
      if (recorded.path.endsWith("/abort")) {
        return Response.json({ error: "abort failed" }, { status: 500 });
      }
      return multipart()(recorded);
    });
    await expect(
      sandbox.fs.writeBytes({ path: "/work/big.bin", content: pattern(6 * MB) }),
    ).rejects.toMatchObject({ message: expect.stringContaining("assembly failed") });
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/filesystem-multipart/up-1/abort",
    });
  });

  it("aborts the upload without the caller's signal once it aborts", async () => {
    const controller = new AbortController();
    const { sandbox, requests } = fakeSandbox(
      multipart(() => {
        controller.abort(new Error("caller stopped"));
        return undefined;
      }),
    );
    await expect(
      sandbox.fs.writeBytes({
        path: "/work/big.bin",
        content: pattern(12 * MB + 17),
        callOptions: { signal: controller.signal },
      }),
    ).rejects.toThrow("caller stopped");
    const abort = requests.at(-1)!;
    expect(abort).toMatchObject({ method: "DELETE", path: "/filesystem-multipart/up-1/abort" });
    expect(abort.request.signal.aborted).toBe(false);
  });

  it("keeps at most 2 parts in flight per sandbox, across its uploads", async () => {
    let inFlight = 0;
    let most = 0;
    const { sandbox } = fakeSandbox(
      multipart(async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        // Lets every other upload waiting to send a part run first.
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return undefined;
      }),
    );
    await Promise.all([
      sandbox.fs.writeBytes({ path: "/work/a.bin", content: pattern(12 * MB) }),
      sandbox.fs.writeBytes({ path: "/work/b.bin", content: pattern(12 * MB) }),
    ]);
    expect(most).toBe(2);
  });

  it("gives each sandbox its own limit of parts in flight", async () => {
    let inFlight = 0;
    let most = 0;
    const route = multipart(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      // Lets the other sandbox's upload send its parts first.
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return undefined;
    });
    await Promise.all([
      fakeSandbox(route).sandbox.fs.writeBytes({ path: "/work/a.bin", content: pattern(12 * MB) }),
      fakeSandbox(route).sandbox.fs.writeBytes({ path: "/work/b.bin", content: pattern(12 * MB) }),
    ]);
    expect(most).toBe(4);
  });

  it("makes a directory, with permissions only when set", async () => {
    const { sandbox, requests } = fakeSandbox(ok);
    await sandbox.fs.mkdir({ path: "/work/d" });
    await sandbox.fs.mkdir({ path: "/work/e", permissions: "0700" });
    expect(await requests[0]!.request.json()).toEqual({ isDirectory: true });
    expect(await requests[1]!.request.json()).toEqual({ isDirectory: true, permissions: "0700" });
  });

  it("lists a directory", async () => {
    const { sandbox } = fakeSandbox(() =>
      Response.json({
        name: "work",
        path: "/work",
        files: [apiFile("a.txt")],
        subdirectories: [{ name: "d", path: "/work/d" }],
      }),
    );
    expect(await sandbox.fs.list({ path: "/work" })).toEqual({
      name: "work",
      path: "/work",
      files: [
        {
          name: "a.txt",
          path: "/work/a.txt",
          sizeBytes: 5,
          permissions: "-rw-r--r--",
          owner: "root",
          group: "root",
          lastModified: new Date("2026-09-30T10:00:00Z"),
        },
      ],
      subdirectories: [{ name: "d", path: "/work/d" }],
    });
  });

  it("fails to list a file", async () => {
    const { sandbox } = fakeSandbox(() => Response.json({ ...apiFile("a.txt"), content: "x" }));
    await expect(sandbox.fs.list({ path: "/work/a.txt" })).rejects.toThrow(
      "/work/a.txt is a file, not a directory",
    );
  });

  it("removes without retrying, sending recursive only when set", async () => {
    const { sandbox, requests } = fakeSandbox((_, index) => (index === 0 ? ok() : gateway()));
    await sandbox.fs.remove({ path: "/work/a.txt" });
    await expect(sandbox.fs.remove({ path: "/work/d", recursive: true })).rejects.toBeInstanceOf(
      SandboxGatewayError,
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.query.has("recursive")).toBe(false);
    expect(requests[1]!.query.get("recursive")).toBe("true");
  });

  it("finds entries with every option mapped", async () => {
    const { sandbox, requests } = fakeSandbox(() =>
      Response.json({ matches: [{ path: "/work/a.ts", type: "file" }], total: 3 }),
    );
    const result = await sandbox.fs.find({
      path: "/work",
      type: "file",
      patterns: ["*.ts", "*.js"],
      maxResults: 1,
      excludeDirs: ["node_modules", "dist"],
      excludeHidden: false,
    });
    expect(result).toEqual({ matches: [{ path: "/work/a.ts", type: "file" }], total: 3 });
    expect(requests[0]!.path).toBe("/filesystem-find/%2Fwork");
    expect(Object.fromEntries(requests[0]!.query)).toEqual({
      type: "file",
      patterns: "*.ts,*.js",
      maxResults: "1",
      excludeDirs: "node_modules,dist",
      excludeHidden: "false",
    });
  });

  it("finds with no options sent when none are set", async () => {
    const { sandbox, requests } = fakeSandbox(() => Response.json({ matches: [], total: 0 }));
    await sandbox.fs.find({ path: "/work" });
    expect([...requests[0]!.query]).toEqual([]);
  });

  it("finds nothing when the server sends null matches", async () => {
    const { sandbox } = fakeSandbox(() => Response.json({ matches: null, total: 0 }));
    expect(await sandbox.fs.find({ path: "/work" })).toEqual({ matches: [], total: 0 });
  });

  it("greps nothing when the server sends null matches", async () => {
    const { sandbox } = fakeSandbox(() =>
      Response.json({ query: "needle", matches: null, total: 0 }),
    );
    expect(await sandbox.fs.grep({ path: "/work", query: "needle" })).toEqual({
      matches: [],
      total: 0,
    });
  });

  it("greps with every option mapped", async () => {
    const { sandbox, requests } = fakeSandbox(() =>
      Response.json({
        query: "needle",
        matches: [{ path: "/work/a.ts", line: 3, column: 5, text: "a needle", context: "x" }],
        total: 1,
      }),
    );
    const result = await sandbox.fs.grep({
      path: "/work",
      query: "needle",
      caseSensitive: true,
      maxResults: 10,
      filePattern: "*.ts",
      excludeDirs: ["dist"],
    });
    expect(result).toEqual({
      matches: [{ path: "/work/a.ts", line: 3, column: 5, text: "a needle", context: "x" }],
      total: 1,
    });
    expect(requests[0]!.path).toBe("/filesystem-content-search/%2Fwork");
    expect(Object.fromEntries(requests[0]!.query)).toEqual({
      query: "needle",
      caseSensitive: "true",
      maxResults: "10",
      filePattern: "*.ts",
      excludeDirs: "dist",
    });
  });

  it("copies by running cp with both paths quoted, then waiting", async () => {
    const { sandbox, requests } = fakeSandbox((recorded) =>
      recorded.method === "POST"
        ? Response.json(apiProcess())
        : Response.json(apiProcess({ status: "completed" })),
    );
    await sandbox.fs.copy({ source: "/work/it's here", destination: "/tmp/$HOME" });
    expect((await requests[0]!.request.json()) as unknown).toEqual({
      command: `cp -r '/work/it'\\''s here' '/tmp/$HOME'`,
    });
    expect(requests[1]!.path).toBe("/process/7");
  });

  it("fails a copy whose cp fails", async () => {
    const { sandbox } = fakeSandbox((recorded) =>
      recorded.method === "POST"
        ? Response.json(apiProcess())
        : Response.json(
            apiProcess({ status: "failed", exitCode: 1, stderr: "cp: cannot stat '/nope'\n" }),
          ),
    );
    const err = await sandbox.fs
      .copy({ source: "/nope", destination: "/tmp/x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxFileSystemCopyError);
    expect((err as SandboxFileSystemCopyError).process.exitCode).toBe(1);
    expect((err as Error).message).toContain("cannot stat");
  });

  it("fails a copy whose cp is killed", async () => {
    const { sandbox } = fakeSandbox((recorded) =>
      recorded.method === "POST"
        ? Response.json(apiProcess())
        : Response.json(apiProcess({ status: "killed", exitCode: -1 })),
    );
    await expect(sandbox.fs.copy({ source: "/a", destination: "/b" })).rejects.toBeInstanceOf(
      SandboxFileSystemCopyError,
    );
  });

  it("writes a tree, retrying a gateway error", async () => {
    const { sandbox, requests } = fakeSandbox((_, index) =>
      index === 0
        ? gateway()
        : Response.json({ name: "work", path: "/work", files: [], subdirectories: [] }),
    );
    await skippingBackoff(() =>
      sandbox.fs.writeTree({ path: "/work", files: { "a.txt": "a", "d/b.txt": "b" } }),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]!.path).toBe("/filesystem/tree/%2Fwork");
    expect(await requests[1]!.request.json()).toEqual({ files: { "a.txt": "a", "d/b.txt": "b" } });
  });

  it("watches, joining each event's directory and name", async () => {
    const { response } = streamed([
      `${JSON.stringify({ op: "CREATE", path: "/work", name: "a.txt" })}\n[keepalive]\n`,
      `${JSON.stringify({ op: "WRITE", path: "/work/", name: "b.txt" })}\n\n`,
      JSON.stringify({ op: "REMOVE", path: "/work/d", name: "c.txt" }),
    ]);
    const { sandbox, requests } = fakeSandbox(() => response);
    const events = [];
    for await (const event of sandbox.fs.watch({ path: "/work", ignore: ["*.log", "tmp"] })) {
      events.push(event);
    }
    expect(events).toEqual([
      { op: "CREATE", path: "/work/a.txt" },
      { op: "WRITE", path: "/work/b.txt" },
      { op: "REMOVE", path: "/work/d/c.txt" },
    ]);
    expect(requests[0]!.path).toBe("/watch/filesystem/%2Fwork");
    expect(requests[0]!.query.get("ignore")).toBe("*.log,tmp");
  });

  it("cancels the watch stream when iteration ends early", async () => {
    const line = `${JSON.stringify({ op: "CREATE", path: "/work", name: "a" })}\n`;
    const { response, cancelled } = streamed([line, line, line]);
    const { sandbox } = fakeSandbox(() => response);
    for await (const event of sandbox.fs.watch({ path: "/work" })) {
      expect(event.path).toBe("/work/a");
      break;
    }
    expect(cancelled()).toBe(true);
  });
});
