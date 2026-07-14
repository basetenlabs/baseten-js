/**
 * Writes src/version.ts from the package.json version so the runtime VERSION
 * constant always matches the published version. Run automatically by `build`.
 *
 * Usage:
 *   npx tsx scripts/sync-version.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");

const pkg = JSON.parse(await readFile(resolve(PACKAGE_DIR, "package.json"), "utf-8")) as {
  version: string;
};

const out = resolve(PACKAGE_DIR, "src/version.ts");
const contents = `// Generated from package.json by scripts/sync-version.ts. Do not edit.
export const VERSION = ${JSON.stringify(pkg.version)};
`;

await writeFile(out, contents);
console.log(`version.ts -> ${pkg.version}`);
