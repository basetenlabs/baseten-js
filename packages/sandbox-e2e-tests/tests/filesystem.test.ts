import {
  type Sandbox,
  SandboxApiError,
  SandboxFileSystemCopyError,
  type SandboxFileSystemWatchEvent,
} from "@basetenlabs/sandbox";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { e2eEnabled, sandboxClient, uniqueName } from "./harness";

describe.runIf(e2eEnabled())("SandboxFileSystem", () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await sandboxClient().get({ name: inject("sandboxName") });
  });

  // A directory of the test's own, so tests on the shared sandbox never see
  // each other's files.
  async function testDir(): Promise<string> {
    const dir = `/tmp/e2e-fs/${uniqueName()}`;
    await sandbox.fs.mkdir({ path: dir });
    return dir;
  }

  it("writes and reads a file", async () => {
    const dir = await testDir();
    await sandbox.fs.write({ path: `${dir}/hello.txt`, content: "hello" });
    expect(await sandbox.fs.read({ path: `${dir}/hello.txt` })).toBe("hello");
  });

  it("writes into directories that do not exist yet", async () => {
    const dir = await testDir();
    await sandbox.fs.write({ path: `${dir}/a/b/c.txt`, content: "nested" });
    expect(await sandbox.fs.read({ path: `${dir}/a/b/c.txt` })).toBe("nested");
  });

  it("writes and reads a relative path", async () => {
    const path = `${uniqueName()}.txt`;
    await sandbox.fs.write({ path, content: "relative" });
    try {
      expect(await sandbox.fs.read({ path })).toBe("relative");
    } finally {
      await sandbox.fs.remove({ path });
    }
  });

  it("fails reading a missing file", async () => {
    const dir = await testDir();
    const err = await sandbox.fs.read({ path: `${dir}/missing.txt` }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxApiError);
    expect((err as SandboxApiError).status).toBe(404);
  });

  it("handles names that need escaping", async () => {
    const dir = await testDir();
    const path = `${dir}/a b%#?.txt`;
    await sandbox.fs.write({ path, content: "escaped" });
    expect(await sandbox.fs.read({ path })).toBe("escaped");
    await sandbox.fs.writeBytes({ path, content: new Uint8Array([1, 2, 3]) });
    expect(await sandbox.fs.readBytes({ path })).toEqual(new Uint8Array([1, 2, 3]));
    const listing = await sandbox.fs.list({ path: dir });
    expect(listing.files.map((f) => f.name)).toEqual(["a b%#?.txt"]);
  });

  it("round-trips every byte value", async () => {
    const dir = await testDir();
    const bytes = new Uint8Array(256).map((_, i) => i);
    await sandbox.fs.writeBytes({ path: `${dir}/all.bin`, content: bytes });
    expect(await sandbox.fs.readBytes({ path: `${dir}/all.bin` })).toEqual(bytes);
    await sandbox.fs.writeBytes({ path: `${dir}/blob.bin`, content: new Blob([bytes]) });
    expect(await sandbox.fs.readBytes({ path: `${dir}/blob.bin` })).toEqual(bytes);
  });

  it("writes bytes with the given permissions", async () => {
    const dir = await testDir();
    await sandbox.fs.writeBytes({
      path: `${dir}/run.sh`,
      content: new TextEncoder().encode("#!/bin/sh\necho ran\n"),
      permissions: "0755",
    });
    const ran = await sandbox.process.exec({
      command: `stat -c %a ${dir}/run.sh && ${dir}/run.sh`,
      waitForCompletion: true,
    });
    expect(ran.stdout).toBe("755\nran\n");
    // An existing file keeps its mode.
    await sandbox.fs.writeBytes({
      path: `${dir}/run.sh`,
      content: new TextEncoder().encode("#!/bin/sh\necho again\n"),
      permissions: "0700",
    });
    const mode = await sandbox.process.exec({
      command: `stat -c %a ${dir}/run.sh`,
      waitForCompletion: true,
    });
    expect(mode.stdout.trim()).toBe("755");
  });

  it("writes bytes over 5MB in parts, every byte exact", async () => {
    const dir = await testDir();
    // Three parts, the last one partial, in a pattern that does not line up
    // with the part size, so a part off by any number of bytes shows.
    const bytes = new Uint8Array(12 * 1024 * 1024 + 17).map((_, i) => i % 251);
    await sandbox.fs.writeBytes({ path: `${dir}/big.bin`, content: bytes, permissions: "0755" });
    expect(sameBytes(await sandbox.fs.readBytes({ path: `${dir}/big.bin` }), bytes)).toBe(true);
    const mode = await sandbox.process.exec({
      command: `stat -c %a ${dir}/big.bin`,
      waitForCompletion: true,
    });
    expect(mode.stdout.trim()).toBe("755");
  });

  it("writes text over 5MB in parts", async () => {
    const dir = await testDir();
    // Two bytes each in UTF-8, with a line number so parts out of order show.
    const content = Array.from({ length: 1_000_000 }, (_, i) => `${i} é\n`).join("");
    await sandbox.fs.write({ path: `${dir}/big.txt`, content });
    expect(await sandbox.fs.read({ path: `${dir}/big.txt` })).toBe(content);
  });

  it("makes a directory with the given permissions", async () => {
    const dir = await testDir();
    await sandbox.fs.mkdir({ path: `${dir}/private`, permissions: "0700" });
    const mode = await sandbox.process.exec({
      command: `stat -c %a ${dir}/private`,
      waitForCompletion: true,
    });
    expect(mode.stdout.trim()).toBe("700");
  });

  it("fails reading a directory and listing a file", async () => {
    const dir = await testDir();
    await sandbox.fs.write({ path: `${dir}/f.txt`, content: "f" });
    await expect(sandbox.fs.read({ path: dir })).rejects.toThrow("is a directory");
    await expect(sandbox.fs.readBytes({ path: dir })).rejects.toThrow("is a directory");
    await expect(sandbox.fs.list({ path: `${dir}/f.txt` })).rejects.toThrow("is a file");
  });

  it("makes directories, parents included, and again without error", async () => {
    const dir = await testDir();
    await sandbox.fs.mkdir({ path: `${dir}/x/y/z` });
    await sandbox.fs.mkdir({ path: `${dir}/x/y/z` });
    expect(
      (await sandbox.fs.list({ path: `${dir}/x/y` })).subdirectories.map((d) => d.name),
    ).toEqual(["z"]);
  });

  it("lists a directory's files and subdirectories", async () => {
    const dir = await testDir();
    const before = Date.now();
    await sandbox.fs.write({ path: `${dir}/a.txt`, content: "12345" });
    await sandbox.fs.mkdir({ path: `${dir}/sub` });
    const listing = await sandbox.fs.list({ path: dir });
    expect(listing.path).toBe(dir);
    expect(listing.subdirectories.map((d) => d.name)).toEqual(["sub"]);
    expect(listing.files).toHaveLength(1);
    const file = listing.files[0]!;
    expect(file.name).toBe("a.txt");
    expect(file.path).toBe(`${dir}/a.txt`);
    expect(file.sizeBytes).toBe(5);
    // Allows for clock skew between this machine and the sandbox.
    expect(Math.abs(file.lastModified.getTime() - before)).toBeLessThan(10 * 60_000);
  });

  it("removes files, and non-empty directories only recursively", async () => {
    const dir = await testDir();
    await sandbox.fs.write({ path: `${dir}/f.txt`, content: "f" });
    await sandbox.fs.remove({ path: `${dir}/f.txt` });
    await expect(sandbox.fs.read({ path: `${dir}/f.txt` })).rejects.toMatchObject({ status: 404 });

    await sandbox.fs.write({ path: `${dir}/d/g.txt`, content: "g" });
    await expect(sandbox.fs.remove({ path: `${dir}/d` })).rejects.toBeInstanceOf(SandboxApiError);
    await sandbox.fs.remove({ path: `${dir}/d`, recursive: true });
    await expect(sandbox.fs.list({ path: `${dir}/d` })).rejects.toMatchObject({ status: 404 });
  });

  it("finds entries by pattern and type", async () => {
    const dir = await testDir();
    await sandbox.fs.writeTree({
      path: dir,
      files: { "a.ts": "a", "b.js": "b", "sub/c.ts": "c" },
    });
    const ts = await sandbox.fs.find({ path: dir, patterns: ["*.ts"] });
    // Match paths are relative to the searched path, as observed from the
    // server (the spec only shows a relative example).
    expect(ts.matches.map((m) => m.path).sort()).toEqual(["a.ts", "sub/c.ts"]);
    expect(ts.total).toBe(2);
    const dirs = await sandbox.fs.find({ path: dir, type: "directory" });
    expect(dirs.matches.map((m) => m.path)).toContain("sub");
    expect(dirs.matches.every((m) => m.type === "directory")).toBe(true);
  });

  it("greps file contents", async () => {
    const dir = await testDir();
    await sandbox.fs.writeTree({
      path: dir,
      files: { "a.txt": "one\nfind Needle here\nthree\n", "b.txt": "nothing\n" },
    });
    const found = await sandbox.fs.grep({ path: dir, query: "needle" });
    expect(found.total).toBe(1);
    // Match paths are relative to the searched path, as observed from the
    // server (the spec only shows a relative example).
    expect(found.matches[0]).toMatchObject({
      path: "a.txt",
      line: 2,
      text: "find Needle here",
    });
    expect(found.matches[0]!.context).toBeUndefined();
    const withContext = await sandbox.fs.grep({ path: dir, query: "needle", contextLines: 1 });
    expect(withContext.matches[0]!.context).toBe("one\nfind Needle here\nthree");
    const exact = await sandbox.fs.grep({ path: dir, query: "needle", caseSensitive: true });
    expect(exact.total).toBe(0);
  });

  it("copies files and directories", async () => {
    const dir = await testDir();
    await sandbox.fs.write({ path: `${dir}/it's.txt`, content: "quoted" });
    await sandbox.fs.copy({ source: `${dir}/it's.txt`, destination: `${dir}/copy.txt` });
    expect(await sandbox.fs.read({ path: `${dir}/copy.txt` })).toBe("quoted");

    await sandbox.fs.writeTree({ path: `${dir}/src`, files: { "a.txt": "a", "d/b.txt": "b" } });
    await sandbox.fs.copy({ source: `${dir}/src`, destination: `${dir}/dst` });
    expect(await sandbox.fs.read({ path: `${dir}/dst/d/b.txt` })).toBe("b");
  });

  it("fails copying a missing source", async () => {
    const dir = await testDir();
    const err = await sandbox.fs
      .copy({ source: `${dir}/missing`, destination: `${dir}/x` })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxFileSystemCopyError);
    expect((err as SandboxFileSystemCopyError).process.stderr).toContain("missing");
  });

  it("writes a tree without touching other files", async () => {
    const dir = await testDir();
    await sandbox.fs.write({ path: `${dir}/keep.txt`, content: "keep" });
    await sandbox.fs.writeTree({ path: dir, files: { "a.txt": "a", "d/e/b.txt": "b" } });
    expect(await sandbox.fs.read({ path: `${dir}/a.txt` })).toBe("a");
    expect(await sandbox.fs.read({ path: `${dir}/d/e/b.txt` })).toBe("b");
    expect(await sandbox.fs.read({ path: `${dir}/keep.txt` })).toBe("keep");
  });

  // Watches with the request and writes path until the watch reports an
  // event for it.
  async function watchUntilWritten(
    request: { path: string; recursive?: boolean },
    path: string,
  ): Promise<void> {
    const abort = new AbortController();
    const events = sandbox.fs.watch({ ...request, callOptions: { signal: abort.signal } });
    const unmatched: SandboxFileSystemWatchEvent[] = [];
    try {
      // The server's watch starts at some unknown point after the request, so
      // a change made too early is missed. Rather than sleeping, this repeats
      // the change, each attempt a full round trip, until its event arrives.
      let pending = events.next();
      // Aborting at the end rejects whatever next() is still pending.
      pending.catch(() => undefined);
      let event: SandboxFileSystemWatchEvent | undefined;
      for (let attempt = 0; attempt < 20 && event === undefined; attempt++) {
        const written = sandbox.fs.write({ path, content: String(attempt) });
        const settled = await Promise.race([pending, written.then(() => undefined)]);
        if (settled === undefined) continue;
        if (settled.done) throw new Error("the watch ended before an event for the file");
        if (settled.value.path === path) {
          event = settled.value;
        } else {
          unmatched.push(settled.value);
          pending = events.next();
          pending.catch(() => undefined);
        }
      }
      expect(event, `no event for ${path}, only ${JSON.stringify(unmatched)}`).toBeDefined();
      expect(event!.ops.some((op) => op === "CREATE" || op === "WRITE")).toBe(true);
    } finally {
      // Aborting rather than calling return(), which would wait behind a
      // pending next() forever.
      abort.abort();
    }
  }

  // The watch covers only the directory itself: in an earlier run, 20 writes
  // to a file in a subdirectory produced no event for it.
  it("watches changes in a directory", async () => {
    const dir = await testDir();
    await watchUntilWritten({ path: dir }, `${dir}/top.txt`);
  });

  it("watches changes in subdirectories recursively", async () => {
    const dir = await testDir();
    // The subdirectory exists before the watch, so the event shows the watch
    // covers it.
    await sandbox.fs.write({ path: `${dir}/sub/existing.txt`, content: "existing" });
    await watchUntilWritten({ path: dir, recursive: true }, `${dir}/sub/nested.txt`);
  });
});

// Compared in a loop, since a deep equality failure on megabytes is unreadable.
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
