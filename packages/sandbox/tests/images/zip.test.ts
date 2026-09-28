import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { crc32, createZip, zipEntryPaths } from "../../src/images/zip";

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

  it.runIf(hasCommand("python3"))("is read back identically by Python's zipfile", async () => {
    const path = writeTempZip(await zipBytes(sampleEntries()));
    const script = [
      "import json, sys, zipfile",
      "z = zipfile.ZipFile(sys.argv[1])",
      "assert z.testzip() is None",
      "print(json.dumps({i.filename: [list(z.read(i)), i.external_attr >> 16] for i in z.infolist()}))",
    ].join("\n");
    const read = JSON.parse(
      execFileSync("python3", ["-c", script, path], { encoding: "utf8" }),
    ) as Record<string, [number[], number]>;
    for (const entry of sampleEntries()) {
      const name = entry.data === undefined ? `${entry.path}/` : entry.path;
      const [data, mode] = read[name]!;
      expect(new Uint8Array(data)).toEqual(entry.data ?? new Uint8Array());
      expect(mode & 0o7777).toBe(entry.mode);
    }
  });

  it("rejects more entries than a zip without ZIP64 holds", async () => {
    const entries = Array.from({ length: 0x10000 }, (_, i) => ({ path: `d${i}`, mode: 0o755 }));
    await expect(createZip(entries)).rejects.toThrow(/at most 65535 entries/);
  });
});

describe("zipEntryPaths", () => {
  it("lists entries of a zip written by fflate", async () => {
    const zip = zipSync({
      Dockerfile: encoder.encode("FROM scratch"),
      "src/main.py": encoder.encode("print(1)"),
    });
    expect(await zipEntryPaths(new Blob([zip as BlobPart]))).toEqual(["Dockerfile", "src/main.py"]);
  });

  it("lists entries of a zip with a trailing comment", async () => {
    const zip = zipSync({ Dockerfile: encoder.encode("FROM scratch") }, { comment: "hello" });
    expect(await zipEntryPaths(new Blob([zip as BlobPart]))).toEqual(["Dockerfile"]);
  });

  it("lists entries of a zip written here", async () => {
    const paths = await zipEntryPaths(await createZip(sampleEntries()));
    expect(paths).toContain("Dockerfile");
    expect(paths).toContain("bin/");
    expect(paths).toContain("ünïcode/名前.txt");
  });

  it("rejects something that is not a zip", async () => {
    await expect(zipEntryPaths(new Blob([encoder.encode("not a zip at all")]))).rejects.toThrow(
      /not a zip archive/,
    );
    await expect(zipEntryPaths(new Blob([]))).rejects.toThrow(/not a zip archive/);
  });

  it("decodes names written by fflate as UTF-8", async () => {
    const zip = zipSync({ "名前.txt": encoder.encode("x") });
    expect(await zipEntryPaths(new Blob([zip as BlobPart]))).toEqual(["名前.txt"]);
  });
});
