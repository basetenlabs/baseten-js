/**
 * Preprocesses input schemas for code generation.
 *
 * preprocessSpec (OpenAPI):
 * - Hoists inline schemas from components/responses and components/requestBodies
 *   into components/schemas so they get generated as named types.
 * - Strips V1 suffixes from management API schema names.
 *
 * preprocessConfigSchema (Truss config JSON Schema):
 * - Asserts no required+nullable properties (would lose nullability on collapse).
 * - Renames Truss*-prefixed $defs keys, $refs, and root title to Model*.
 * - Strips property-level titles so json-schema-to-typescript only emits named
 *   types for $defs entries (not for every described property).
 */

const TRUSS_PREFIX = "Truss";
const MODEL_PREFIX = "Model";

export function preprocessConfigSchema(data: Uint8Array): Uint8Array {
  const doc = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;

  assertNoRequiredNullable(doc);

  const defs = (doc.$defs as Record<string, unknown> | undefined) ?? {};
  const renames = new Map<string, string>();
  for (const name of Object.keys(defs)) {
    if (name.startsWith(TRUSS_PREFIX)) {
      renames.set(name, MODEL_PREFIX + name.slice(TRUSS_PREFIX.length));
    }
  }
  if (typeof doc.title === "string" && doc.title.startsWith(TRUSS_PREFIX)) {
    doc.title = MODEL_PREFIX + doc.title.slice(TRUSS_PREFIX.length);
  }
  renameConfigRefsAndTitles(doc, renames);
  for (const [oldName, newName] of renames) {
    defs[newName] = defs[oldName];
    delete defs[oldName];
  }

  // Strip property-level titles so json-schema-to-typescript doesn't emit a
  // top-level named type for every described property. Keep titles on the
  // root and on $defs entries (those are the named types we want).
  stripPropertyTitles(doc);
  for (const def of Object.values(defs)) {
    if (def && typeof def === "object") stripPropertyTitles(def);
  }

  return new TextEncoder().encode(JSON.stringify(doc, null, 2));
}

function assertNoRequiredNullable(node: unknown, path: string[] = []): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertNoRequiredNullable(child, [...path, String(i)]));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const required = Array.isArray(obj.required) ? (obj.required as string[]) : null;
  const properties = obj.properties as Record<string, unknown> | undefined;
  if (required && properties) {
    for (const key of required) {
      const prop = properties[key];
      if (prop && typeof prop === "object" && isNullableShape(prop as Record<string, unknown>)) {
        throw new Error(
          `Required property ${[...path, "properties", key].join("/")} has nullable shape; ` +
            "preprocess does not handle this case",
        );
      }
    }
  }
  for (const [k, v] of Object.entries(obj)) assertNoRequiredNullable(v, [...path, k]);
}

function isNullableShape(prop: Record<string, unknown>): boolean {
  if (Array.isArray(prop.type) && prop.type.includes("null")) return true;
  if (Array.isArray(prop.anyOf)) {
    for (const variant of prop.anyOf as Array<Record<string, unknown>>) {
      if (variant && variant.type === "null") return true;
    }
  }
  return false;
}

function stripPropertyTitles(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) stripPropertyTitles(child);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const properties = obj.properties as Record<string, unknown> | undefined;
  if (properties) {
    for (const prop of Object.values(properties)) {
      if (prop && typeof prop === "object") {
        delete (prop as Record<string, unknown>).title;
        stripPropertyTitles(prop);
      }
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "properties") stripPropertyTitles(v);
  }
}

const CONFIG_REF_PATTERN = /^#\/\$defs\/(\w+)$/;

function renameConfigRefsAndTitles(node: unknown, renames: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (const child of node) renameConfigRefsAndTitles(child, renames);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const m = CONFIG_REF_PATTERN.exec(obj.$ref);
    if (m && renames.has(m[1]!)) {
      obj.$ref = `#/$defs/${renames.get(m[1]!)}`;
    }
  }
  if (typeof obj.title === "string" && renames.has(obj.title)) {
    obj.title = renames.get(obj.title)!;
  }
  for (const child of Object.values(obj)) renameConfigRefsAndTitles(child, renames);
}

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
