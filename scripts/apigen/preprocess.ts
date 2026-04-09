/**
 * Preprocesses OpenAPI specs for code generation.
 *
 * - Hoists inline schemas from components/responses and components/requestBodies
 *   into components/schemas so they get generated as named types.
 * - Strips V1 suffixes from management API schema names.
 */

export function preprocessSpec(data: Uint8Array): Uint8Array {
  const doc = JSON.parse(new TextDecoder().decode(data));

  hoistComponentSchemas(doc);

  const renames = buildV1Renames(doc);
  if (renames.size > 0) {
    renameRefs(doc, renames);
    const schemas = (doc.components as Record<string, unknown>).schemas as Record<string, unknown>;
    for (const [oldName, newName] of renames) {
      schemas[newName] = schemas[oldName];
      delete schemas[oldName];
    }
  }

  return new TextEncoder().encode(JSON.stringify(doc, null, 2));
}

/**
 * Hoists inline JSON schemas from components/responses and
 * components/requestBodies into components/schemas. Entries that are
 * just a $ref or whose JSON content schema is already a $ref are
 * skipped — they'd only produce wrapper types.
 */
function hoistComponentSchemas(doc: Record<string, unknown>): void {
  const components = (doc.components ?? {}) as Record<string, unknown>;
  const schemas = (components.schemas ?? {}) as Record<string, unknown>;
  components.schemas = schemas;

  for (const section of ["responses", "requestBodies"]) {
    const entries = components[section] as Record<string, Record<string, unknown>> | undefined;
    if (!entries) continue;
    for (const [name, entry] of Object.entries(entries)) {
      if ("$ref" in entry) continue;
      const content = (entry.content as Record<string, Record<string, unknown>>) ?? {};
      const jsonContent = content["application/json"];
      if (!jsonContent) continue;
      const schema = jsonContent.schema as Record<string, unknown> | undefined;
      if (!schema) continue;
      if (
        schema.$ref &&
        typeof schema.$ref === "string" &&
        schema.$ref.startsWith("#/components/schemas/")
      ) {
        continue;
      }
      schemas[name] = schema;
      jsonContent.schema = { $ref: `#/components/schemas/${name}` };
    }
  }
}

const REF_PATTERN = /^#\/components\/schemas\/(\w+)$/;

function buildV1Renames(doc: Record<string, unknown>): Map<string, string> {
  const schemas = (doc.components as Record<string, unknown>)?.schemas as
    | Record<string, unknown>
    | undefined;
  if (!schemas) return new Map();
  const renames = new Map<string, string>();
  for (const name of Object.keys(schemas)) {
    if (name.endsWith("V1")) {
      renames.set(name, name.slice(0, -2));
    }
  }
  return renames;
}

function renameRefs(node: unknown, renames: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (const child of node) renameRefs(child, renames);
  } else if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const m = REF_PATTERN.exec(obj.$ref);
      if (m && renames.has(m[1]!)) {
        obj.$ref = `#/components/schemas/${renames.get(m[1]!)}`;
      }
    }
    for (const child of Object.values(obj)) renameRefs(child, renames);
  }
}
