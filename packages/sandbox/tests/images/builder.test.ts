import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { ImageBuilder, SandboxClient } from "../../src/index";

const INJECTED = [
  "COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api",
  'ENTRYPOINT ["/usr/local/bin/sandbox-api"]',
];

// The Dockerfile a builder from base pushes with lines, injection included.
function expected(lines: string[], base = "debian:bookworm-slim"): string {
  return `${[`FROM ${base}`, ...lines, ...INJECTED].join("\n")}\n`;
}

function base(): ImageBuilder {
  return ImageBuilder.fromRegistry("debian:bookworm-slim");
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-builder-test-"));
  tempDirs.push(dir);
  return dir;
}

// Windows reads every file as 0666 and has no exec bits to keep.
const keepsModes = process.platform !== "win32";

describe("ImageBuilder", () => {
  it("writes each core instruction, then injects the sandbox API", () => {
    const builder = base()
      .workdir("/app")
      .runCommands("echo one", "echo two")
      .env({ A: "1", B: "two words" })
      .copy("src dir", "/app/src")
      .expose(8080, 9090)
      .user("app")
      .label({ team: "infra" })
      .arg("VERSION")
      .arg("CHANNEL", "stable");
    expect(builder.baseImage).toBe("debian:bookworm-slim");
    expect(builder.dockerfile()).toBe(
      expected([
        "WORKDIR /app",
        "RUN echo one",
        "RUN echo two",
        'ENV A="1"',
        'ENV B="two words"',
        'COPY ["src dir","/app/src"]',
        "EXPOSE 8080",
        "EXPOSE 9090",
        "USER app",
        'LABEL team="infra"',
        "ARG VERSION",
        'ARG CHANNEL="stable"',
      ]),
    );
  });

  it("escapes quotes and backslashes in values, leaving $ for the build", () => {
    const builder = base()
      .env({ PATH: "/opt/bin:$PATH", QUOTE: 'say "hi" \\ bye' })
      .label({ note: 'a "b"' })
      .arg("X", 'c"d');
    expect(builder.dockerfile()).toBe(
      expected([
        'ENV PATH="/opt/bin:$PATH"',
        'ENV QUOTE="say \\"hi\\" \\\\ bye"',
        'LABEL note="a \\"b\\""',
        'ARG X="c\\"d"',
      ]),
    );
  });

  it("throws on a newline anywhere but raw lines", () => {
    expect(() => ImageBuilder.fromRegistry("a\nb")).toThrow("baseImage must not contain a newline");
    expect(() => base().workdir("/a\n/b")).toThrow("path must not contain a newline");
    expect(() => base().runCommands("a\nb")).toThrow("command must not contain a newline");
    expect(() => base().env({ A: "1\r\n2" })).toThrow("env value must not contain a newline");
    expect(() => base().copy("a\n", "/b")).toThrow("source must not contain a newline");
    expect(() => base().entrypoint("a\nb")).toThrow(
      "entrypoint argument must not contain a newline",
    );
    expect(() => base().pipInstall("a\nb")).toThrow("argument must not contain a newline");
  });

  it("throws on an env, label, or arg name that cannot be written unquoted", () => {
    expect(() => base().env({ "A B": "1" })).toThrow('env name "A B"');
    expect(() => base().label({ "a=b": "1" })).toThrow('label key "a=b"');
    expect(() => base().arg("")).toThrow('arg name ""');
  });

  it("rejects ports that are not between 1 and 65535", () => {
    expect(() => base().expose(0)).toThrow("port 0 is not between 1 and 65535");
    expect(() => base().expose(65536)).toThrow("port 65536");
    expect(() => base().expose(80.5)).toThrow("port 80.5");
  });

  it("appends raw lines verbatim, newlines included", () => {
    const heredoc = "RUN <<EOF\necho one\necho two\nEOF";
    const builder = base().dockerfileLines("# a comment", heredoc);
    expect(builder.dockerfile()).toBe(expected(["# a comment", heredoc]));
  });

  it("writes an entrypoint in exec form instead of the default one", () => {
    const builder = base().entrypoint("/bin/sh", "-c", 'echo "hi"');
    expect(builder.dockerfile()).toBe(
      `${[
        "FROM debian:bookworm-slim",
        'ENTRYPOINT ["/bin/sh","-c","echo \\"hi\\""]',
        INJECTED[0],
      ].join("\n")}\n`,
    );
    expect(base().entrypoint().dockerfile()).toBe(expected([]));
  });

  it("counts an entrypoint in raw lines, in any case, but not in a comment", () => {
    expect(base().dockerfileLines('entrypoint ["/run"]').dockerfile()).not.toContain(INJECTED[1]);
    expect(base().dockerfileLines('# ENTRYPOINT ["/run"]').dockerfile()).toContain(INJECTED[1]);
  });

  it("skips copying the sandbox API when the Dockerfile already brings it in", () => {
    expect(
      base().runCommands("curl -o /usr/local/bin/sandbox-api https://x").dockerfile(),
    ).not.toContain(INJECTED[0]);
    expect(ImageBuilder.fromRegistry("ghcr.io/blaxel-ai/sandbox:v1").dockerfile()).not.toContain(
      INJECTED[0],
    );
  });

  it("copies the sandbox API from the given image", () => {
    const builder = ImageBuilder.fromRegistry("debian:bookworm-slim", {
      sandboxApiImage: "registry.example/sandbox:v2",
    });
    expect(builder.dockerfile()).toContain(
      "COPY --from=registry.example/sandbox:v2 /sandbox-api /usr/local/bin/sandbox-api",
    );
  });

  it("never changes: each call returns a new builder", () => {
    const shared = base().pipInstall("numpy");
    const withTorch = shared.pipInstall("torch");
    const withJax = shared.pipInstall("jax");
    expect(shared.dockerfile()).toBe(expected(["RUN pip install numpy"]));
    expect(withTorch.dockerfile()).toBe(
      expected(["RUN pip install numpy", "RUN pip install torch"]),
    );
    expect(withJax.dockerfile()).toBe(expected(["RUN pip install numpy", "RUN pip install jax"]));
  });

  it("writes each package manager's command, quoting arguments that need it", () => {
    const builder = base()
      .pipInstall("--pre", "numpy>=2", "it's")
      .aptInstall("git", "curl")
      .apkAdd("git")
      .npmInstall("-g", "typescript@5")
      .npmInstall()
      .gemInstall("rails")
      .cargoInstall("--locked", "ripgrep")
      .goInstall("golang.org/x/tools/gopls@latest", "example.com/cmd@v1")
      .composerInstall("laravel/framework")
      .uvInstall("ruff")
      .pipxInstall("black", "httpie");
    expect(builder.dockerfile()).toBe(
      expected([
        "RUN pip install --pre 'numpy>=2' 'it'\\''s'",
        "RUN apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*",
        "RUN apk add --no-cache git",
        "RUN npm install -g typescript@5",
        "RUN npm install",
        "RUN gem install --no-document rails",
        "RUN cargo install --locked ripgrep",
        "RUN go install golang.org/x/tools/gopls@latest && go install example.com/cmd@v1",
        "RUN composer require laravel/framework",
        "RUN uv pip install --system ruff",
        "RUN pipx install black && pipx install httpie",
      ]),
    );
  });

  it("appends nothing for a package manager without arguments, except npm", () => {
    const builder = base()
      .pipInstall()
      .aptInstall()
      .apkAdd()
      .gemInstall()
      .cargoInstall()
      .goInstall()
      .composerInstall()
      .uvInstall()
      .pipxInstall()
      .runCommands()
      .env({})
      .expose();
    expect(builder.dockerfile()).toBe(expected([]));
  });

  it("names context entries by basename, suffixing repeats and reserved names", () => {
    const builder = base()
      .addFile("/etc/a/config.json", "1")
      .addFile("/etc/b/config.json", "2")
      .addFile("/etc/c/config.json", "3")
      .addFile("/srv/Makefile", "4")
      .addFile("/opt/Makefile", "5")
      .addFile("/x/Dockerfile", "6")
      .addFile("/x/.dockerignore", "7");
    expect(builder.dockerfile()).toBe(
      expected([
        'COPY ["config.json","/etc/a/config.json"]',
        'COPY ["config (1).json","/etc/b/config.json"]',
        'COPY ["config (2).json","/etc/c/config.json"]',
        'COPY ["Makefile","/srv/Makefile"]',
        'COPY ["Makefile (1)","/opt/Makefile"]',
        'COPY ["Dockerfile (1)","/x/Dockerfile"]',
        'COPY [".dockerignore (1)","/x/.dockerignore"]',
      ]),
    );
  });

  it("uses an explicit context name exactly, throwing if it is taken or reserved", () => {
    const builder = base().addFile("/app/run.sh", "x", { contextName: "start.sh" });
    expect(builder.dockerfile()).toContain('COPY ["start.sh","/app/run.sh"]');
    expect(() => builder.addFile("/b", "y", { contextName: "start.sh" })).toThrow(
      "context name start.sh is reserved or already used",
    );
    expect(() => base().addFile("/b", "y", { contextName: "Dockerfile" })).toThrow(
      "context name Dockerfile is reserved or already used",
    );
    expect(() => base().addFile("/b", "y", { contextName: "a/b" })).toThrow(
      'context name "a/b" must be one path segment',
    );
  });

  it("needs a context name to add a file to a destination ending in a slash", () => {
    expect(() => base().addFile("/app/", "x")).toThrow(
      "destination /app/ has no file name; set contextName",
    );
    expect(base().addFile("/app/", "x", { contextName: "x.txt" }).dockerfile()).toContain(
      'COPY ["x.txt","/app/"]',
    );
  });

  it("zips the Dockerfile and every entry with its mode, reading local files at push", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "tool.sh"), "before");
    chmodSync(join(dir, "tool.sh"), 0o755);
    mkdirSync(join(dir, "conf", "nested"), { recursive: true });
    writeFileSync(join(dir, "conf", "nested", "a.txt"), "a");
    const builder = base()
      .addFile("/etc/text.txt", "text")
      .addFile("/etc/bytes.bin", new Uint8Array([0, 255]))
      .addFile("/usr/local/bin/run", new Blob(["#!/bin/sh"]), { mode: 0o755 })
      .addLocalFile(join(dir, "tool.sh"), "/usr/local/bin/tool")
      .addLocalDir(join(dir, "conf"), "/etc/conf");
    const entries = await builder.zipEntries();
    // Read when zipped, not when added or listed.
    writeFileSync(join(dir, "tool.sh"), "after");

    const decoder = new TextDecoder();
    const byPath = new Map(
      await Promise.all(
        entries.map(async (entry) => {
          const data = entry.data ?? (await entry.read?.());
          return [entry.path, { data, mode: entry.mode }] as const;
        }),
      ),
    );
    expect([...byPath.keys()]).toEqual([
      "Dockerfile",
      "text.txt",
      "bytes.bin",
      "run",
      "tool.sh",
      "conf",
      "conf/nested",
      "conf/nested/a.txt",
    ]);
    expect(decoder.decode(byPath.get("Dockerfile")!.data)).toBe(builder.dockerfile());
    expect(byPath.get("Dockerfile")!.mode).toBe(0o644);
    expect(decoder.decode(byPath.get("text.txt")!.data)).toBe("text");
    expect(byPath.get("text.txt")!.mode).toBe(0o644);
    expect(byPath.get("bytes.bin")!.data).toEqual(new Uint8Array([0, 255]));
    expect(decoder.decode(byPath.get("run")!.data)).toBe("#!/bin/sh");
    expect(byPath.get("run")!.mode).toBe(0o755);
    expect(decoder.decode(byPath.get("tool.sh")!.data)).toBe("after");
    expect(byPath.get("conf")!.data).toBeUndefined();
    expect(decoder.decode(byPath.get("conf/nested/a.txt")!.data)).toBe("a");
    if (keepsModes) expect(byPath.get("tool.sh")!.mode & 0o777).toBe(0o755);
    expect(builder.dockerfile()).toContain('COPY ["tool.sh","/usr/local/bin/tool"]');
    expect(builder.dockerfile()).toContain('COPY ["conf","/etc/conf"]');
  });

  it("fails at push when a local file or directory is gone", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "gone.txt"), "x");
    const fileBuilder = base().addLocalFile(join(dir, "gone.txt"), "/gone.txt");
    rmSync(join(dir, "gone.txt"));
    await expect(fileBuilder.zipEntries()).rejects.toThrow(
      `local file ${join(dir, "gone.txt")} is not a file`,
    );
    await expect(base().addLocalDir(join(dir, "missing"), "/m").zipEntries()).rejects.toThrow(
      `local directory ${join(dir, "missing")} is not a directory`,
    );
  });

  it("adds everything in a local directory, with no ignore rules", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref");
    writeFileSync(join(dir, ".dockerignore"), "*\n");
    writeFileSync(join(dir, ".env"), "SECRET=1");
    const entries = await base().addLocalDir(dir, "/app", { contextName: "app" }).zipEntries();
    expect(entries.map((entry) => entry.path)).toEqual([
      "Dockerfile",
      "app",
      "app/.dockerignore",
      "app/.env",
      "app/.git",
      "app/.git/HEAD",
    ]);
  });

  it("pushes as a zip of its Dockerfile and files", async () => {
    let uploaded: Uint8Array | undefined;
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
      if (url.host === "uploads.example") {
        uploaded = new Uint8Array(await request.arrayBuffer());
        return new Response(null, { status: 200 });
      }
      return Response.json(
        { name: "app", status: "UPLOADING", upload_url: "https://uploads.example/zip" },
        { status: 202 },
      );
    };
    const client = new SandboxClient({ apiKey: "test-key", fetch: fetchImpl as typeof fetch });
    const builder = base().addFile("/hello.txt", "hello");
    await client.images.push({ name: "app", builder, wait: false });
    const files = unzipSync(uploaded!);
    expect(Object.keys(files).sort()).toEqual(["Dockerfile", "hello.txt"]);
    expect(new TextDecoder().decode(files.Dockerfile)).toBe(builder.dockerfile());
  });

  it("rejects a push with a builder and another source", async () => {
    const client = new SandboxClient({ apiKey: "test-key" });
    await expect(
      // @ts-expect-error Two sources do not type check either.
      client.images.push({ name: "app", builder: base(), files: { Dockerfile: "FROM x\n" } }),
    ).rejects.toThrow("got builder, files");
  });
});
