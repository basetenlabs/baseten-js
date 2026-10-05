import type { NodeFsPromises, NodePath } from "./images";

/** @internal */
export const DOCKERIGNORE_FILE_NAME = ".dockerignore";

/**
 * Passed to an {@link ImageIgnoreFileFunc} for each candidate path in a
 * directory being pushed.
 */
export interface ImageIgnoreFileOptions {
  /** Path relative to the directory's root, with forward slashes on all platforms. */
  relPath: string;

  /** Whether the path is a directory, not a link to one. */
  isDirectory: boolean;
}

/**
 * Reports whether a path should be left out of a pushed build context. When it
 * returns true for a directory, the directory's entire subtree is left out.
 * Throwing fails the push before anything is sent.
 */
export type ImageIgnoreFileFunc = (options: ImageIgnoreFileOptions) => boolean | Promise<boolean>;

/**
 * Passed to {@link ImagePushDirectoryRequest.ignoreFileProcessor} when a
 * `.dockerignore` is found at the root of the directory being pushed.
 */
export interface ImageIgnoreFileProcessorOptions {
  /** Absolute path of the `.dockerignore`. */
  path: string;

  /** Contents of the `.dockerignore`, decoded as UTF-8. */
  contents: string;
}

/**
 * Parses a `.dockerignore` into an {@link ImageIgnoreFileFunc}, which should
 * match Docker's `.dockerignore` semantics.
 */
export type ImageIgnoreFileProcessor = (
  options: ImageIgnoreFileProcessorOptions,
) => ImageIgnoreFileFunc | Promise<ImageIgnoreFileFunc>;

// Left out at any depth by defaultImageIgnoreFile.
const DEFAULT_IGNORED_NAMES = new Set([
  ".blaxel",
  ".env.build",
  ".docker",
  ".git",
  "dist",
  ".venv",
  "venv",
  "node_modules",
  ".env",
  ".next",
  "__pycache__",
]);

/**
 * Reports whether a path is left out of a pushed build context by the default
 * rules, applied when the directory has no `.dockerignore`. Its result is the
 * same as this `.dockerignore`:
 *
 * ```
 * **\/.blaxel
 * **\/.env.build
 * **\/.docker
 * **\/.git
 * **\/dist
 * **\/.venv
 * **\/venv
 * **\/node_modules
 * **\/.env
 * .env*
 * **\/.next
 * **\/__pycache__
 * ```
 *
 * So each of those names is left out at any depth, as a file or as a directory
 * with everything in it, and a name starting with `.env` is left out at the
 * root. To extend the defaults, copy them into a `.dockerignore`.
 */
export function defaultImageIgnoreFile(options: ImageIgnoreFileOptions): boolean {
  const components = options.relPath.split("/");
  // Any component, so a path under an ignored directory is ignored even when
  // its directory was not pruned first.
  if (components.some((component) => DEFAULT_IGNORED_NAMES.has(component))) return true;
  // .env* has no **/, so it matches at the root only, as Docker reads it.
  return components[0]!.startsWith(".env");
}

/**
 * @internal Determines how a pushed directory is filtered: by its
 * `.dockerignore` through processor, which must then be set, or else by
 * defaultIgnoreFile or {@link defaultImageIgnoreFile}.
 */
export async function resolveImageIgnoreFile(
  node: { fs: NodeFsPromises; path: NodePath },
  directory: string,
  processor: ImageIgnoreFileProcessor | undefined,
  defaultIgnoreFile: ImageIgnoreFileFunc | undefined,
): Promise<ImageIgnoreFileFunc> {
  const ignorePath = node.path.resolve(directory, DOCKERIGNORE_FILE_NAME);
  let contents: Uint8Array;
  try {
    contents = await node.fs.readFile(ignorePath);
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") throw err;
    return defaultIgnoreFile ?? defaultImageIgnoreFile;
  }
  // Failing, rather than pushing everything, keeps files the caller meant to
  // leave out, such as secrets, from being uploaded.
  if (processor === undefined) {
    throw new Error(`${ignorePath} exists but ignoreFileProcessor is not set`);
  }
  return processor({ path: ignorePath, contents: new TextDecoder().decode(contents) });
}
