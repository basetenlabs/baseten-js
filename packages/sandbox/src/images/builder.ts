import { addDirectoryZipEntries, nodeFileSystem } from "./images";
import type { ZipEntry } from "./zip";

const DEFAULT_SANDBOX_API_IMAGE = "ghcr.io/blaxel-ai/sandbox:latest";
const SANDBOX_API_PATH = "/usr/local/bin/sandbox-api";

// Names the build itself reads at the root of its context, so a context entry
// must never take them.
const RESERVED_CONTEXT_NAMES = new Set(["Dockerfile", ".dockerignore"]);

// Characters a package manager argument may have and still be passed to the
// shell unquoted.
const SHELL_SAFE = /^[A-Za-z0-9._\-+=:/@~^*]+$/;

/** Options for {@link ImageBuilder.fromRegistry}. */
export interface ImageBuilderFromRegistryOptions {
  /**
   * Image to copy the sandbox API binary from, when the Dockerfile does not
   * bring it in itself. Defaults to `ghcr.io/blaxel-ai/sandbox:latest`.
   */
  sandboxApiImage?: string;
}

/** Options for {@link ImageBuilder.addLocalFile} and {@link ImageBuilder.addLocalDir}. */
export interface ImageBuilderAddLocalOptions {
  /**
   * Name in the build context. Defaults to the source's basename, with a
   * suffix such as ` (1)` if another entry already has that name.
   */
  contextName?: string;
}

/** Options for {@link ImageBuilder.addFile}. */
export interface ImageBuilderAddFileOptions {
  /**
   * Name in the build context. Defaults to the destination's basename, with
   * a suffix such as ` (1)` if another entry already has that name.
   */
  contextName?: string;

  /** Unix permission bits of the file in the image. Defaults to 0o644. */
  mode?: number;
}

type ContextEntry =
  | { kind: "content"; name: string; content: string | Uint8Array | Blob; mode: number }
  | { kind: "file" | "directory"; name: string; sourcePath: string };

interface ImageBuilderState {
  baseImage: string;
  sandboxApiImage: string;
  instructions: readonly string[];
  context: readonly ContextEntry[];
}

/**
 * Describes an image as a Dockerfile and the files it copies in, to push with
 * {@link ImageClient.push}. Start one with {@link ImageBuilder.fromRegistry}.
 *
 * A builder never changes: each method returns a new builder with the
 * instruction appended, so one builder can safely be the base of several.
 *
 * The Dockerfile it pushes ends by copying in the sandbox API binary and
 * making it the entrypoint, unless the builder already did either, since a
 * sandbox needs it running to be reached. {@link dockerfile} shows the
 * Dockerfile exactly as pushed.
 */
export class ImageBuilder {
  readonly #state: ImageBuilderState;

  private constructor(state: ImageBuilderState) {
    this.#state = state;
  }

  /** Starts a builder from a registry image, as `FROM <baseImage>`. */
  static fromRegistry(
    baseImage: string,
    options: ImageBuilderFromRegistryOptions = {},
  ): ImageBuilder {
    return new ImageBuilder({
      baseImage: singleLine("baseImage", baseImage),
      sandboxApiImage: singleLine(
        "sandboxApiImage",
        options.sandboxApiImage ?? DEFAULT_SANDBOX_API_IMAGE,
      ),
      instructions: Object.freeze([]),
      context: Object.freeze([]),
    });
  }

  /** The image this builder starts from. */
  get baseImage(): string {
    return this.#state.baseImage;
  }

  /** The Dockerfile, exactly as it is pushed. */
  dockerfile(): string {
    const { baseImage, sandboxApiImage, instructions } = this.#state;
    const lines = [`FROM ${baseImage}`, ...instructions];
    const text = lines.join("\n");
    if (!text.includes("sandbox-api") && !text.includes("blaxel-ai/sandbox")) {
      lines.push(`COPY --from=${sandboxApiImage} /sandbox-api ${SANDBOX_API_PATH}`);
    }
    // Read from the lines rather than tracked by entrypoint(), so one written
    // with dockerfileLines() counts too.
    const hasEntrypoint = instructions.some((instruction) =>
      instruction.split("\n").some((line) => /^\s*ENTRYPOINT\b/i.test(line)),
    );
    if (!hasEntrypoint) lines.push(`ENTRYPOINT ${JSON.stringify([SANDBOX_API_PATH])}`);
    return `${lines.join("\n")}\n`;
  }

  /** Appends `WORKDIR <path>`. */
  workdir(path: string): ImageBuilder {
    return this.#append([`WORKDIR ${singleLine("path", path)}`]);
  }

  /** Appends `RUN <command>` for each command, in shell form. */
  runCommands(...commands: string[]): ImageBuilder {
    return this.#append(commands.map((command) => `RUN ${singleLine("command", command)}`));
  }

  /**
   * Appends `ENV <name>="<value>"` for each variable, with `"` and `\` in the
   * value escaped. `$` is left as is, so the build expands variables in it,
   * as in `{ PATH: "/opt/bin:$PATH" }`.
   */
  env(variables: Record<string, string>): ImageBuilder {
    return this.#append(
      Object.entries(variables).map(
        ([name, value]) => `ENV ${keyName("env name", name)}=${quoted("env value", value)}`,
      ),
    );
  }

  /** Appends `COPY ["<source>", "<destination>"]`, copying from the build context. */
  copy(source: string, destination: string): ImageBuilder {
    singleLine("source", source);
    singleLine("destination", destination);
    return this.#append([`COPY ${JSON.stringify([source, destination])}`]);
  }

  /** Appends `EXPOSE <port>` for each port. */
  expose(...ports: number[]): ImageBuilder {
    for (const port of ports) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new RangeError(`port ${port} is not between 1 and 65535`);
      }
    }
    return this.#append(ports.map((port) => `EXPOSE ${port}`));
  }

  /**
   * Appends `ENTRYPOINT ["<arg>", ...]`, in exec form. The image then runs
   * this instead of the sandbox API binary, so it must start that itself for
   * the sandbox to be reachable.
   */
  entrypoint(...args: string[]): ImageBuilder {
    if (args.length === 0) return this;
    for (const arg of args) singleLine("entrypoint argument", arg);
    return this.#append([`ENTRYPOINT ${JSON.stringify(args)}`]);
  }

  /** Appends `USER <user>`. */
  user(user: string): ImageBuilder {
    return this.#append([`USER ${singleLine("user", user)}`]);
  }

  /** Appends `LABEL <key>="<value>"` for each label, escaped as in {@link env}. */
  label(labels: Record<string, string>): ImageBuilder {
    return this.#append(
      Object.entries(labels).map(
        ([key, value]) => `LABEL ${keyName("label key", key)}=${quoted("label value", value)}`,
      ),
    );
  }

  /**
   * Appends `ARG <name>`, or `ARG <name>="<defaultValue>"` with the default
   * escaped as in {@link env}.
   */
  arg(name: string, defaultValue?: string): ImageBuilder {
    const declared = keyName("arg name", name);
    return this.#append([
      defaultValue === undefined
        ? `ARG ${declared}`
        : `ARG ${declared}=${quoted("arg default", defaultValue)}`,
    ]);
  }

  /**
   * Appends each line verbatim, for anything the other methods do not cover,
   * such as comments, `CMD`, or a heredoc. A line may contain newlines, and
   * nothing is checked or escaped.
   */
  dockerfileLines(...lines: string[]): ImageBuilder {
    return this.#append(lines);
  }

  /** Appends `RUN pip install <args>`. */
  pipInstall(...args: string[]): ImageBuilder {
    return this.#run("pip install", args);
  }

  /**
   * Appends `RUN apt-get update && apt-get install -y --no-install-recommends
   * <args> && rm -rf /var/lib/apt/lists/*`, as one step so the package lists
   * add nothing to the image.
   */
  aptInstall(...args: string[]): ImageBuilder {
    if (args.length === 0) return this;
    return this.#append([
      `RUN apt-get update && apt-get install -y --no-install-recommends ${shellArgs(args)} && rm -rf /var/lib/apt/lists/*`,
    ]);
  }

  /** Appends `RUN apk add --no-cache <args>`. */
  apkAdd(...args: string[]): ImageBuilder {
    return this.#run("apk add --no-cache", args);
  }

  /**
   * Appends `RUN npm install <args>`, or `RUN npm install` with no arguments
   * to install from the working directory's `package.json`.
   */
  npmInstall(...args: string[]): ImageBuilder {
    if (args.length === 0) return this.#append(["RUN npm install"]);
    return this.#run("npm install", args);
  }

  /** Appends `RUN gem install --no-document <args>`. */
  gemInstall(...args: string[]): ImageBuilder {
    return this.#run("gem install --no-document", args);
  }

  /** Appends `RUN cargo install <args>`. */
  cargoInstall(...args: string[]): ImageBuilder {
    return this.#run("cargo install", args);
  }

  /**
   * Appends `RUN go install <package> && go install <package> ...`, one
   * `go install` per package, since one call can only install packages from
   * a single module.
   */
  goInstall(...packages: string[]): ImageBuilder {
    return this.#runEach("go install", packages);
  }

  /** Appends `RUN composer require <args>`. */
  composerInstall(...args: string[]): ImageBuilder {
    return this.#run("composer require", args);
  }

  /** Appends `RUN uv pip install --system <args>`. */
  uvInstall(...args: string[]): ImageBuilder {
    return this.#run("uv pip install --system", args);
  }

  /** Appends `RUN pipx install <package> && pipx install <package> ...`, one per package. */
  pipxInstall(...packages: string[]): ImageBuilder {
    return this.#runEach("pipx install", packages);
  }

  /**
   * Adds a local file to the build context and appends `COPY ["<name>",
   * "<destination>"]`, where name is its name in the context. The file is read
   * when pushed, keeping its permissions, and a symbolic link is read as the
   * file it points to.
   *
   * Needs a runtime with Node's filesystem API; elsewhere, use
   * {@link addFile}.
   */
  addLocalFile(
    sourcePath: string,
    destination: string,
    options: ImageBuilderAddLocalOptions = {},
  ): ImageBuilder {
    return this.#addLocal("file", sourcePath, destination, options);
  }

  /**
   * Adds a local directory to the build context and appends `COPY ["<name>",
   * "<destination>"]`, where name is its name in the context. As with any
   * `COPY` of a directory, its contents are copied into the destination, not
   * the directory itself. It is read when pushed, with files keeping their
   * permissions, a link to a file within the directory stored as a copy of
   * the file, a link to a file outside it failing the push, and a link to a
   * directory stored as an empty directory.
   *
   * Needs a runtime with Node's filesystem API.
   */
  addLocalDir(
    sourcePath: string,
    destination: string,
    options: ImageBuilderAddLocalOptions = {},
  ): ImageBuilder {
    return this.#addLocal("directory", sourcePath, destination, options);
  }

  /**
   * Adds a file with the given content to the build context and appends
   * `COPY ["<name>", "<destination>"]`, where name is its name in the context.
   */
  addFile(
    destination: string,
    content: string | Uint8Array | Blob,
    options: ImageBuilderAddFileOptions = {},
  ): ImageBuilder {
    singleLine("destination", destination);
    const defaultName = destination.split("/").pop() ?? "";
    if (options.contextName === undefined && defaultName === "") {
      throw new Error(`destination ${destination} has no file name; set contextName`);
    }
    const name = this.#contextName(options.contextName, defaultName);
    return this.#append([`COPY ${JSON.stringify([name, destination])}`], {
      kind: "content",
      name,
      content,
      mode: options.mode ?? 0o644,
    });
  }

  /** @internal The build context to zip: the Dockerfile, then each added entry. */
  async zipEntries(): Promise<ZipEntry[]> {
    const encoder = new TextEncoder();
    const entries: ZipEntry[] = [
      { path: "Dockerfile", data: encoder.encode(this.dockerfile()), mode: 0o644 },
    ];
    for (const entry of this.#state.context) {
      if (entry.kind === "content") {
        const { content } = entry;
        const data =
          typeof content === "string"
            ? encoder.encode(content)
            : content instanceof Blob
              ? new Uint8Array(await content.arrayBuffer())
              : content;
        entries.push({ path: entry.name, data, mode: entry.mode });
        continue;
      }
      // Checked when the entry was added, so present here.
      const node = nodeFileSystem()!;
      const stat = await node.fs.stat(entry.sourcePath).catch(() => undefined);
      if (entry.kind === "file") {
        if (!stat?.isFile()) throw new Error(`local file ${entry.sourcePath} is not a file`);
        entries.push({
          path: entry.name,
          data: await node.fs.readFile(entry.sourcePath),
          mode: stat.mode,
        });
      } else {
        if (!stat?.isDirectory()) {
          throw new Error(`local directory ${entry.sourcePath} is not a directory`);
        }
        entries.push({ path: entry.name, mode: stat.mode });
        await addDirectoryZipEntries(node, entry.sourcePath, `${entry.name}/`, entries);
      }
    }
    return entries;
  }

  #append(instructions: string[], contextEntry?: ContextEntry): ImageBuilder {
    if (instructions.length === 0) return this;
    const { context } = this.#state;
    return new ImageBuilder({
      ...this.#state,
      instructions: Object.freeze([...this.#state.instructions, ...instructions]),
      context: contextEntry === undefined ? context : Object.freeze([...context, contextEntry]),
    });
  }

  #run(command: string, args: string[]): ImageBuilder {
    if (args.length === 0) return this;
    return this.#append([`RUN ${command} ${shellArgs(args)}`]);
  }

  #runEach(command: string, packages: string[]): ImageBuilder {
    if (packages.length === 0) return this;
    const runs = packages.map((pkg) => `${command} ${shellArgs([pkg])}`);
    return this.#append([`RUN ${runs.join(" && ")}`]);
  }

  #addLocal(
    kind: "file" | "directory",
    sourcePath: string,
    destination: string,
    options: ImageBuilderAddLocalOptions,
  ): ImageBuilder {
    const node = nodeFileSystem();
    if (node === undefined) {
      throw new Error(
        kind === "file"
          ? "addLocalFile needs a runtime with Node's filesystem API; use addFile instead"
          : "addLocalDir needs a runtime with Node's filesystem API",
      );
    }
    singleLine("destination", destination);
    // Resolved now, so a later change of working directory does not change
    // what is pushed.
    const resolved = node.path.resolve(sourcePath);
    const name = this.#contextName(options.contextName, node.path.basename(resolved));
    return this.#append([`COPY ${JSON.stringify([name, destination])}`], {
      kind,
      name,
      sourcePath: resolved,
    });
  }

  // An explicit name is used exactly or throws; a default one is suffixed the
  // way browsers name a repeated download, before any extension.
  #contextName(requested: string | undefined, defaultName: string): string {
    const taken = (name: string) =>
      RESERVED_CONTEXT_NAMES.has(name) || this.#state.context.some((entry) => entry.name === name);
    if (requested !== undefined) {
      contextNameSegment(requested);
      if (taken(requested)) {
        throw new Error(`context name ${requested} is reserved or already used`);
      }
      return requested;
    }
    contextNameSegment(defaultName);
    if (!taken(defaultName)) return defaultName;
    const dot = defaultName.lastIndexOf(".");
    const [stem, extension] =
      dot > 0 ? [defaultName.slice(0, dot), defaultName.slice(dot)] : [defaultName, ""];
    for (let n = 1; ; n++) {
      const candidate = `${stem} (${n})${extension}`;
      if (!taken(candidate)) return candidate;
    }
  }
}

/** Throws if a value would span lines in the Dockerfile, otherwise returns it. */
function singleLine(what: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${what} must not contain a newline`);
  return value;
}

/** Checks an env, label, or arg name, which is written unquoted. */
function keyName(what: string, value: string): string {
  if (value === "" || /[\s="]/.test(value)) {
    throw new Error(`${what} ${JSON.stringify(value)} must be non-empty, without spaces, = or "`);
  }
  return value;
}

/** Double-quotes a value, escaping `"` and `\`. */
function quoted(what: string, value: string): string {
  return `"${singleLine(what, value).replace(/["\\]/g, "\\$&")}"`;
}

function contextNameSegment(name: string): void {
  if (name === "" || name === "." || name === ".." || /[/\\\r\n]/.test(name)) {
    throw new Error(
      `context name ${JSON.stringify(name)} must be one path segment, without slashes or newlines`,
    );
  }
}

/** Joins arguments for the shell, single-quoting any that need it. */
function shellArgs(args: string[]): string {
  return args
    .map((arg) => {
      singleLine("argument", arg);
      return SHELL_SAFE.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
    })
    .join(" ");
}
