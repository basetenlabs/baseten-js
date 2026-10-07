import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { crc32, createZip, zipEntryInfos } from "../../src/images/zip";

const encoder = new TextEncoder();

// Compressible, incompressible, empty, and multi-byte-name content, so both
// the deflate and the stored paths are covered.
function sampleEntries() {
  const random = new Uint8Array(4096);
  for (let i = 0; i < random.length; i++) random[i] = (i * 2654435761) >>> 24;
  return [
    { path: "Dockerfile", data: encoder.encode("FROM scratch\nCOPY . /app\n"), mode: 0o644 },
    { path: "bin", mode: 0o755 },
    { path: "bin/run.sh", data: encoder.encode("#!/bin/sh\necho hi\n".repeat(200)), mode: 0o755 },
    { path: "data/random.bin", data: random, mode: 0o600 },
    { path: "empty.txt", data: new Uint8Array(), mode: 0o644 },
    { path: "ünïcode/名前.txt", data: encoder.encode("utf-8 names"), mode: 0o644 },
  ];
}

async function zipBytes(entries: Parameters<typeof createZip>[0]): Promise<Uint8Array> {
  return new Uint8Array(await (await createZip(entries)).arrayBuffer());
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function writeTempZip(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-zip-test-"));
  tempDirs.push(dir);
  const path = join(dir, "test.zip");
  writeFileSync(path, bytes);
  return path;
}

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("createZip", () => {
  it("is read back identically by fflate", async () => {
    const files = unzipSync(await zipBytes(sampleEntries()));
    for (const entry of sampleEntries()) {
      if (entry.data === undefined) {
        expect(files[`${entry.path}/`]).toEqual(new Uint8Array());
      } else {
        expect(files[entry.path]).toEqual(entry.data);
      }
    }
    expect(Object.keys(files).sort()).toEqual(
      sampleEntries()
        .map((e) => (e.data === undefined ? `${e.path}/` : e.path))
        .sort(),
    );
  });

  it("makes the same bytes for the same entries", async () => {
    expect(await zipBytes(sampleEntries())).toEqual(await zipBytes(sampleEntries()));
  });

  it("stores content that deflate would grow", async () => {
    const bytes = await zipBytes([{ path: "tiny", data: encoder.encode("x"), mode: 0o644 }]);
    // Compression method in the local header: 0 is stored, 8 is deflate.
    expect(new DataView(bytes.buffer).getUint16(8, true)).toBe(0);
  });

  it.runIf(hasCommand("unzip"))("passes unzip's integrity test and keeps modes", async () => {
    const path = writeTempZip(await zipBytes(sampleEntries()));
    const test = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
    expect(test).toContain("No errors detected");
    // zipinfo lists Unix permissions, which unzip applies on extraction.
    const listing = execFileSync("unzip", ["-Z", path], { encoding: "utf8" });
    expect(listing).toMatch(/-rwxr-xr-x .* bin\/run\.sh/);
    expect(listing).toMatch(/-rw------- .* data\/random\.bin/);
    expect(listing).toMatch(/drwxr-xr-x .* bin\//);
  });

  it("rejects more entries than a zip without ZIP64 holds", async () => {
    const entries = Array.from({ length: 0x10000 }, (_, i) => ({ path: `d${i}`, mode: 0o755 }));
    await expect(createZip(entries)).rejects.toThrow(/at most 65535 entries/);
  });
});

describe("zipEntryInfos", () => {
  async function paths(zip: Blob): Promise<string[]> {
    return (await zipEntryInfos(zip)).map((entry) => entry.path);
  }

  it("lists entries of a zip written by fflate", async () => {
    const zip = zipSync({
      Dockerfile: encoder.encode("FROM scratch"),
      "src/main.py": encoder.encode("print(1)"),
    });
    expect(await zipEntryInfos(new Blob([zip as BlobPart]))).toEqual([
      { path: "Dockerfile", regularFile: true },
      { path: "src/main.py", regularFile: true },
    ]);
  });

  it("lists entries of a zip with a trailing comment", async () => {
    const zip = zipSync({ Dockerfile: encoder.encode("FROM scratch") }, { comment: "hello" });
    expect(await paths(new Blob([zip as BlobPart]))).toEqual(["Dockerfile"]);
  });

  it("lists entries of a zip written here", async () => {
    const entries = await zipEntryInfos(await createZip(sampleEntries()));
    expect(entries).toContainEqual({ path: "Dockerfile", regularFile: true });
    expect(entries).toContainEqual({ path: "bin/", regularFile: false });
    expect(entries).toContainEqual({ path: "ünïcode/名前.txt", regularFile: true });
  });

  it("tells regular files from links and directories by creator system", async () => {
    const x = encoder.encode("x");
    const zip = zipSync({
      "unix-file": [x, { os: 3, attrs: 0o100644 << 16 }],
      "unix-link": [encoder.encode("target"), { os: 3, attrs: 0o120777 << 16 }],
      "unix-untyped": [x, { os: 3, attrs: 0o644 << 16 }],
      "macos-link": [encoder.encode("target"), { os: 19, attrs: 0o120777 << 16 }],
      "dos-file": [x, { os: 0, attrs: 0x20 }],
      "dos-dir": [new Uint8Array(), { os: 0, attrs: 0x10 }],
      "ntfs-dir": [new Uint8Array(), { os: 11, attrs: 0x10 }],
      "other-system": [x, { os: 6, attrs: 0x10 }],
      "slash/": [new Uint8Array(), { os: 3, attrs: 0o100644 << 16 }],
    });
    expect(await zipEntryInfos(new Blob([zip as BlobPart]))).toEqual([
      { path: "unix-file", regularFile: true },
      { path: "unix-link", regularFile: false },
      { path: "unix-untyped", regularFile: true },
      { path: "macos-link", regularFile: false },
      { path: "dos-file", regularFile: true },
      { path: "dos-dir", regularFile: false },
      { path: "ntfs-dir", regularFile: false },
      { path: "other-system", regularFile: true },
      { path: "slash/", regularFile: false },
    ]);
  });

  it("rejects something that is not a zip", async () => {
    await expect(zipEntryInfos(new Blob([encoder.encode("not a zip at all")]))).rejects.toThrow(
      /not a zip archive/,
    );
    await expect(zipEntryInfos(new Blob([]))).rejects.toThrow(/not a zip archive/);
  });

  it("decodes names written by fflate as UTF-8", async () => {
    const zip = zipSync({ "名前.txt": encoder.encode("x") });
    expect(await paths(new Blob([zip as BlobPart]))).toEqual(["名前.txt"]);
  });
});
