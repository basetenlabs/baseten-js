/**
 * Code generator for Baseten JS SDK.
 *
 * Usage:
 *   pnpm generate-api
 *   pnpm generate-api --update-specs
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateClient } from "./clientgen.ts";
import { postprocessDts } from "./postprocess.ts";
import { preprocessConfigSchema, preprocessSpec } from "./preprocess.ts";

const execFileAsync = promisify(execFile);

const MANAGEMENT_SPEC_URL = "https://api.baseten.co/v1/spec";
const INFERENCE_SPEC_URL = "https://api.baseten.co/inference-spec";
const TRUSS_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/basetenlabs/truss/main/truss/config.schema.json";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = resolve(SCRIPT_DIR, "specs");
const CLIENT_SRC_DIR = resolve(SCRIPT_DIR, "../../src");

await main();

async function main(): Promise<void> {
  const updateSpecs = process.argv.includes("--update-specs");

  if (updateSpecs) {
    console.log("Updating specs from remote URLs...");
    await downloadSpec(MANAGEMENT_SPEC_URL, resolve(SPECS_DIR, "management.json"));
    await downloadSpec(INFERENCE_SPEC_URL, resolve(SPECS_DIR, "inference.json"));
    await downloadSpec(TRUSS_CONFIG_SCHEMA_URL, resolve(SPECS_DIR, "config.schema.json"));
  }

  await generateApi(
    resolve(SPECS_DIR, "management.json"),
    resolve(CLIENT_SRC_DIR, "managementapi"),
  );
  await generateApi(resolve(SPECS_DIR, "inference.json"), resolve(CLIENT_SRC_DIR, "inferenceapi"));
  await generateModelConfig(
    resolve(SPECS_DIR, "config.schema.json"),
    resolve(CLIENT_SRC_DIR, "modelconfig"),
  );
}

// Generates the modelconfig package (Baseten model config, also known as
// Truss config) from the upstream Truss config JSON Schema.
async function generateModelConfig(specFile: string, outDir: string): Promise<void> {
  console.log(`Generating ${outDir} from ${specFile}`);
  await mkdir(outDir, { recursive: true });

  const raw = await readFile(specFile);
  const preprocessed = preprocessConfigSchema(raw);
  const tmpSpec = resolve(outDir, "_spec.tmp.json");
  await writeFile(tmpSpec, preprocessed);

  const modelsFile = resolve(outDir, "models.gen.d.ts");
  await execFileAsync(
    "json2ts",
    ["--input", tmpSpec, "--output", modelsFile, "--no-additionalProperties"],
    { shell: true },
  );
  console.log(`  -> ${modelsFile}`);

  await execFileAsync("oxfmt", ["--write", modelsFile], { shell: true });
  await rm(tmpSpec);
}

async function downloadSpec(url: string, dest: string): Promise<void> {
  console.log(`  ${url} -> ${dest}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const data = new Uint8Array(await resp.arrayBuffer());
  await writeFile(dest, data);
}

async function generateApi(specFile: string, outDir: string): Promise<void> {
  console.log(`Generating ${outDir} from ${specFile}`);
  await mkdir(outDir, { recursive: true });

  const raw = await readFile(specFile);
  const preprocessed = preprocessSpec(raw);

  // Write preprocessed spec to a temp file for openapi-typescript CLI
  const tmpSpec = resolve(outDir, "_spec.tmp.json");
  await writeFile(tmpSpec, preprocessed);

  // Generate models
  const modelsFile = resolve(outDir, "models.gen.d.ts");
  await execFileAsync(
    "openapi-typescript",
    [
      tmpSpec,
      "-o",
      modelsFile,
      "--export-type",
      "--empty-objects-unknown",
      "--root-types",
      "--root-types-no-schema-prefix",
    ],
    { shell: true },
  );
  const dts = await readFile(modelsFile, "utf-8");
  await writeFile(modelsFile, postprocessDts(dts));
  console.log(`  -> ${modelsFile}`);

  // Generate client
  const clientFile = resolve(outDir, "client.gen.ts");
  await writeFile(clientFile, generateClient(preprocessed));
  console.log(`  -> ${clientFile}`);

  // Format generated files
  await execFileAsync("oxfmt", ["--write", modelsFile, clientFile], { shell: true });

  await rm(tmpSpec);
}
