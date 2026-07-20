/**
 * Preprocesses input schemas for code generation.
 *
 * preprocessSpec (OpenAPI):
 * - Hoists inline schemas from components/responses and components/requestBodies
 *   into components/schemas so they get generated as named types.
 * - Strips V1 suffixes from management API schema names.
 * - Injects a named object schema per operation with query parameters so
 *   openapi-typescript emits a typed model the client can reference by name.
 *
 * preprocessConfigSchema (Truss config JSON Schema):
 * - Asserts no required+nullable properties (would lose nullability on collapse).
 * - Renames Truss*-prefixed $defs keys, $refs, and root title to Model*.
 * - Strips property-level titles so json-schema-to-typescript only emits named
 *   types for $defs entries (not for every described property).
 */

import { queryRequestTypeName, resolveMethodNames } from "./clientgen.ts";

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

  // Prune before injecting: enums used only by inline query parameters stay
  // reachable through the operations, orphaned request/response models are
  // dropped, and the query schemas we add next are never at risk.
  pruneUnusedSchemas(doc);

  // Strip defaults from request-body schemas so defaulted-but-optional fields
  // are optional for callers rather than required. See stripRequestBodyDefaults.
  stripRequestBodyDefaults(doc);

  // Run after the V1 rename so the copied parameter schemas already reference
  // the renamed enum/sub-model names.
  injectQuerySchemas(doc);

  return new TextEncoder().encode(JSON.stringify(doc, null, 2));
}

const SCHEMA_REF_PATTERN = /^#\/components\/schemas\/(\w+)$/;

/**
 * Removes component schemas not reachable from any operation. Reachability roots
 * are every schema $ref outside components/schemas (paths and the other
 * component sections); each reachable schema's own $refs are then followed
 * transitively.
 */
function pruneUnusedSchemas(doc: Record<string, unknown>): void {
  const components = (doc.components ?? {}) as Record<string, unknown>;
  const schemas = (components.schemas ?? {}) as Record<string, unknown>;

  // Roots: refs from paths and from component sections other than schemas.
  const roots = new Set<string>();
  collectSchemaRefs(doc.paths, roots);
  for (const [section, value] of Object.entries(components)) {
    if (section !== "schemas") collectSchemaRefs(value, roots);
  }

  const reachable = new Set<string>();
  const queue = [...roots].filter((name) => name in schemas);
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const refs = new Set<string>();
    collectSchemaRefs(schemas[name], refs);
    for (const ref of refs) {
      if (!reachable.has(ref) && ref in schemas) queue.push(ref);
    }
  }

  for (const name of Object.keys(schemas)) {
    if (!reachable.has(name)) delete schemas[name];
  }
}

function collectSchemaRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectSchemaRefs(child, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const m = SCHEMA_REF_PATTERN.exec(obj.$ref);
    if (m) out.add(m[1]!);
  }
  // Discriminator mapping values are schema refs but not under a $ref key.
  const mapping = obj.mapping as Record<string, unknown> | undefined;
  if (obj.propertyName !== undefined && mapping && typeof mapping === "object") {
    for (const value of Object.values(mapping)) {
      if (typeof value === "string") {
        const m = SCHEMA_REF_PATTERN.exec(value);
        if (m) out.add(m[1]!);
      }
    }
  }
  for (const child of Object.values(obj)) collectSchemaRefs(child, out);
}

/**
 * Injects a named object schema into components/schemas for each operation with
 * query parameters, assembled from the operation's own `parameters`. This lets
 * openapi-typescript emit a typed model that the client references by name,
 * instead of the client having to map JSON schema to TypeScript itself. The
 * schema name matches the client method name (e.g. getAuditLogs ->
 * GetAuditLogsRequest).
 */
function injectQuerySchemas(doc: Record<string, unknown>): void {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  const schemas = (doc.components as Record<string, unknown>).schemas as Record<string, unknown>;
  const names = resolveMethodNames(doc);

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const [httpMethod, opRaw] of Object.entries(pathItem)) {
      if (httpMethod === "parameters" || typeof opRaw !== "object" || opRaw === null) continue;
      const op = opRaw as Record<string, unknown>;
      const queryParams = ((op.parameters as unknown[]) ?? []).filter(
        (p): p is Record<string, unknown> =>
          typeof p === "object" && p !== null && (p as Record<string, unknown>).in === "query",
      );
      if (queryParams.length === 0) continue;

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const param of queryParams) {
        const name = param.name as string;
        const schema = { ...(param.schema as Record<string, unknown> | undefined) };
        // Surface the parameter description on the property so openapi-typescript
        // emits it as a doc comment.
        if (typeof param.description === "string" && schema.description === undefined) {
          schema.description = param.description;
        }
        properties[name] = schema;
        if (param.required === true) required.push(name);
      }

      const schemaName = queryRequestTypeName(names.get(`${httpMethod}\0${path}`)!);
      if (schemaName in schemas) {
        throw new Error(
          `injected query schema ${schemaName} collides with an existing schema name`,
        );
      }
      const objectSchema: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) objectSchema.required = required;
      // A query param is optional based on its `required` flag, not on having a
      // default, so strip defaults the same way request bodies do.
      stripDefaultsDeep(objectSchema);
      schemas[schemaName] = objectSchema;
    }
  }
}

/**
 * Strips `default` from every schema reachable from a request body. Left in,
 * openapi-typescript's default-non-nullable would render defaulted-but-optional
 * body fields as required properties the caller must pass. Runs in place, so a
 * schema shared with a response also loses its defaults there; that only makes
 * those response fields optional (looser, still always sent by the server).
 */
function stripRequestBodyDefaults(doc: Record<string, unknown>): void {
  const components = doc.components as Record<string, unknown>;
  const schemas = components.schemas as Record<string, unknown>;
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;

  const roots = new Set<string>();
  // Inline request bodies reference the schema directly; component request
  // bodies are reached via `$ref: #/components/requestBodies/...`, so also walk
  // the requestBodies section (all of whose entries are request bodies).
  collectSchemaRefs(components.requestBodies, roots);
  for (const pathItem of Object.values(paths)) {
    for (const [httpMethod, op] of Object.entries(pathItem)) {
      if (httpMethod === "parameters" || typeof op !== "object" || op === null) continue;
      collectSchemaRefs((op as Record<string, unknown>).requestBody, roots);
    }
  }

  const reachable = new Set<string>();
  const queue = [...roots].filter((name) => name in schemas);
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const refs = new Set<string>();
    collectSchemaRefs(schemas[name], refs);
    for (const ref of refs) {
      if (!reachable.has(ref) && ref in schemas) queue.push(ref);
    }
  }

  for (const name of reachable) stripDefaultsDeep(schemas[name]);
}

/**
 * Recursively deletes the `default` schema keyword. Values inside `properties`
 * (and similar name-keyed maps) are recursed into as schemas but their keys are
 * left alone, so a property literally named `default` is preserved.
 */
function stripDefaultsDeep(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) stripDefaultsDeep(child);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  delete obj.default;
  for (const [key, value] of Object.entries(obj)) {
    if (key === "properties" || key === "patternProperties" || key === "$defs") {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) stripDefaultsDeep(child);
      }
    } else {
      stripDefaultsDeep(value);
    }
  }
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
    // Discriminator mapping values are ref strings, not under a $ref key, so
    // they need rewriting too when the target schema is renamed.
    const mapping = obj.mapping as Record<string, unknown> | undefined;
    if (obj.propertyName !== undefined && mapping && typeof mapping === "object") {
      for (const [key, value] of Object.entries(mapping)) {
        if (typeof value === "string") {
          const m = REF_PATTERN.exec(value);
          if (m && renames.has(m[1]!)) {
            mapping[key] = `#/components/schemas/${renames.get(m[1]!)}`;
          }
        }
      }
    }
    for (const child of Object.values(obj)) renameRefs(child, renames);
  }
}
