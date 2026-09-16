/**
 * Generates typed fetch-based API clients from OpenAPI specs.
 *
 * Each operation becomes an async method on an ApiClient class. Types
 * are imported from the generated models.gen.d.ts.
 */

/** Per-API knobs for the generated client. */
export interface ClientOptions {
  /**
   * Name of the params field carrying query parameters. Defaults to `request`,
   * which doubles as the request-body field; an API with an operation taking
   * both must set this to `query` so the two do not collide.
   */
  queryField?: "request" | "query";
}

export function generateClient(specData: Uint8Array, options: ClientOptions = {}): string {
  const spec = JSON.parse(new TextDecoder().decode(specData));
  const queryField = options.queryField ?? "request";
  const ops = extractOperations(spec, queryField);
  return renderClient(ops, queryField);
}

const JSON_CONTENT = "application/json";

const PATH_PARAM_RE = /\{(\w+)\}/g;
const PATH_PARAM_FULL_RE = /^\{(\w+)\}$/;

interface Operation {
  name: string;
  httpMethod: string;
  path: string;
  pathParams: string[];
  hasBody: boolean;
  /** Declared request body content type. Empty when the operation has no body. */
  bodyContentType: string;
  hasQuery: boolean;
  queryRequired: boolean;
  /** Model name for a JSON request body. Empty for non-JSON bodies. */
  reqBodyRef: string;
  /** Typed JSON success responses, ascending by status code. */
  jsonResponses: { code: number; ref: string }[];
  /** Non-JSON 2xx content types, e.g. text/plain or application/octet-stream. */
  rawAccepts: string[];
  successCodes: number[];
  errorCodes: Map<number, string> | null;
  summary: string;
}

/**
 * Maps each (path, httpMethod) to its resolved client method name. Names are
 * derived from method and path, using a trailing path parameter only where
 * needed to disambiguate collisions. Shared with preprocessing so the injected
 * query-parameter schema for an operation can be named to match its method.
 */
export function resolveMethodNames(spec: Record<string, unknown>): Map<string, string> {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
  const raw: { path: string; httpMethod: string; opData: Record<string, unknown> }[] = [];
  const shortNames = new Map<string, number>();
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const [httpMethod, opData] of Object.entries(pathItem)) {
      if (httpMethod === "parameters" || typeof opData !== "object" || opData === null) continue;
      raw.push({ path, httpMethod, opData: opData as Record<string, unknown> });
      const name = deriveMethodName(httpMethod, path, opData as Record<string, unknown>, false);
      shortNames.set(name, (shortNames.get(name) ?? 0) + 1);
    }
  }
  const result = new Map<string, string>();
  for (const { path, httpMethod, opData } of raw) {
    const short = deriveMethodName(httpMethod, path, opData, false);
    const name =
      (shortNames.get(short) ?? 0) > 1 ? deriveMethodName(httpMethod, path, opData, true) : short;
    result.set(`${httpMethod}\0${path}`, name);
  }
  return result;
}

/**
 * Model name for an operation's injected query-parameter schema. Named after
 * the params field it lands on, so `query` gets `...Query` while the default
 * shared `request` field keeps `...Request`.
 */
export function queryTypeName(methodName: string, queryField: string): string {
  const suffix = queryField === "query" ? "Query" : "Request";
  return methodName.charAt(0).toUpperCase() + methodName.slice(1) + suffix;
}

/** Model name for an operation's hoisted inline JSON response schema. */
export function responseTypeName(methodName: string): string {
  return methodName.charAt(0).toUpperCase() + methodName.slice(1) + "Response";
}

function extractOperations(spec: Record<string, unknown>, queryField: string): Operation[] {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
  const names = resolveMethodNames(spec);

  const ops: Operation[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const [httpMethod, opDataRaw] of Object.entries(pathItem)) {
      if (httpMethod === "parameters" || typeof opDataRaw !== "object" || opDataRaw === null)
        continue;
      const opData = opDataRaw as Record<string, unknown>;
      const name = names.get(`${httpMethod}\0${path}`)!;
      const queryParams = ((opData.parameters as unknown[]) ?? []).filter(
        (p): p is Record<string, unknown> =>
          typeof p === "object" && p !== null && (p as Record<string, unknown>).in === "query",
      );
      const hasBody = "requestBody" in opData;
      if (hasBody && queryParams.length > 0 && queryField === "request") {
        throw new Error(
          `${httpMethod.toUpperCase()} ${path} has both a request body and query parameters; ` +
            'set the queryField option to "query" for this API so the two do not collide',
        );
      }
      const successCodes = extractSuccessCodes(opData, httpMethod, path);
      ops.push({
        name,
        httpMethod: httpMethod.toUpperCase(),
        path,
        pathParams: [...path.matchAll(PATH_PARAM_RE)].map((m) => m[1]!),
        hasBody,
        bodyContentType: bodyContentType(spec, opData),
        hasQuery: queryParams.length > 0,
        queryRequired: queryParams.some((p) => p.required === true),
        reqBodyRef: bodySchemaRef(spec, opData),
        jsonResponses: jsonResponseRefs(spec, opData, successCodes),
        rawAccepts: rawResponseAccepts(spec, opData, successCodes),
        successCodes,
        errorCodes: errorCodeMap(spec, opData),
        summary: (opData.summary as string) ?? "",
      });
    }
  }
  ops.sort((a, b) => a.name.localeCompare(b.name));
  return ops;
}

function extractSuccessCodes(
  op: Record<string, unknown>,
  httpMethod: string,
  path: string,
): number[] {
  const responses = (op.responses ?? {}) as Record<string, unknown>;
  const codes = Object.keys(responses)
    .filter((c) => /^\d+$/.test(c) && Number(c) >= 200 && Number(c) < 300)
    .map(Number)
    .sort((a, b) => a - b);
  if (codes.length === 0) {
    throw new Error(`expected at least one 2xx response for ${httpMethod.toUpperCase()} ${path}`);
  }
  return codes;
}

/** Typed JSON success responses, one per 2xx code that declares a JSON body. */
function jsonResponseRefs(
  spec: Record<string, unknown>,
  op: Record<string, unknown>,
  successCodes: number[],
): { code: number; ref: string }[] {
  const responses = (op.responses ?? {}) as Record<string, Record<string, unknown>>;
  const result: { code: number; ref: string }[] = [];
  for (const code of successCodes) {
    const respNode = responses[String(code)];
    if (!respNode) continue;
    const resolved = resolveRef(spec, respNode);
    let ref = jsonContentSchemaRef(resolved);
    // A response that is itself a $ref with JSON content names the component.
    if (!ref && respNode.$ref && hasJsonContent(resolved)) {
      ref = rootTypeName((respNode.$ref as string).split("/").pop()!);
    }
    if (ref) result.push({ code, ref });
  }
  return result;
}

/** Non-JSON content types declared on 2xx responses, deduplicated. */
function rawResponseAccepts(
  spec: Record<string, unknown>,
  op: Record<string, unknown>,
  successCodes: number[],
): string[] {
  const responses = (op.responses ?? {}) as Record<string, Record<string, unknown>>;
  const accepts = new Set<string>();
  for (const code of successCodes) {
    const respNode = responses[String(code)];
    if (!respNode) continue;
    const resolved = resolveRef(spec, respNode);
    const content = (resolved?.content ?? {}) as Record<string, unknown>;
    for (const contentType of Object.keys(content)) {
      if (contentType !== JSON_CONTENT) accepts.add(contentType);
    }
  }
  return [...accepts].sort();
}

function bodyContentType(spec: Record<string, unknown>, op: Record<string, unknown>): string {
  const rb = resolveRef(spec, (op.requestBody as Record<string, unknown>) ?? null);
  if (!rb) return "";
  const content = (rb.content ?? {}) as Record<string, unknown>;
  const types = Object.keys(content);
  if (types.length === 0) return "";
  // Prefer JSON when an operation declares several body encodings.
  return types.includes(JSON_CONTENT) ? JSON_CONTENT : types[0]!;
}

function deriveMethodName(
  httpMethod: string,
  path: string,
  op: Record<string, unknown>,
  keepTrailingParam: boolean,
): string {
  const opId = op.operationId as string | undefined;
  if (opId) return snakeToCamel(opId);
  const segments = path
    .replace(/^\/v1\//, "")
    .replace(/^\/+|\/+$/g, "")
    .split("/");
  const result: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const m = PATH_PARAM_FULL_RE.exec(seg);
    if (m) {
      if (keepTrailingParam && i === segments.length - 1) {
        result.push(m[1]!);
      }
    } else {
      result.push(seg);
    }
  }
  return snakeToCamel(`${httpMethod.toLowerCase()}_${result.join("_").replace(/-/g, "_")}`);
}

function snakeToCamel(input: string): string {
  const lowered = input.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return lowered.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function resolveRef(
  spec: Record<string, unknown>,
  node: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!node) return null;
  const ref = node.$ref as string | undefined;
  if (!ref) return node;
  let cur: unknown = spec;
  for (const p of ref.replace(/^#\//, "").split("/")) {
    if (typeof cur !== "object" || cur === null) return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === "object" && cur !== null ? (cur as Record<string, unknown>) : null;
}

function jsonContentSchemaRef(node: Record<string, unknown> | null): string {
  if (!node) return "";
  const content = node.content as Record<string, unknown> | undefined;
  const jsonSchema = (content?.["application/json"] as Record<string, unknown> | undefined)
    ?.schema as Record<string, unknown> | undefined;
  const ref = jsonSchema?.$ref as string | undefined;
  if (!ref) return "";
  const name = ref.split("/").pop();
  return name ? rootTypeName(name) : "";
}

function bodySchemaRef(spec: Record<string, unknown>, op: Record<string, unknown>): string {
  const rb = op.requestBody as Record<string, unknown> | undefined;
  if (!rb) return "";
  return jsonContentSchemaRef(resolveRef(spec, rb));
}

function hasJsonContent(node: Record<string, unknown> | null): boolean {
  if (!node) return false;
  return "application/json" in ((node.content as Record<string, unknown>) ?? {});
}

function errorCodeMap(
  spec: Record<string, unknown>,
  op: Record<string, unknown>,
): Map<number, string> | null {
  const responses = (op.responses ?? {}) as Record<string, Record<string, unknown>>;
  const result = new Map<number, string>();
  for (const [codeStr, respRaw] of Object.entries(responses)) {
    if (!/^\d+$/.test(codeStr)) continue;
    const code = Number(codeStr);
    if (code < 400) continue;
    const resolved = resolveRef(spec, respRaw);
    const ref = jsonContentSchemaRef(resolved);
    if (ref) result.set(code, ref);
  }
  return result.size > 0 ? result : null;
}

function pathFmt(path: string): string {
  return path.replace(PATH_PARAM_RE, "{}");
}

// --- Rendering ---

function renderClient(ops: Operation[], queryField: string): string {
  const hasTypedResp = ops.some((op) => op.jsonResponses.length > 0);
  const hasNoResp = ops.some((op) => op.jsonResponses.length === 0 && op.rawAccepts.length === 0);

  const errorRefs = [...new Set(ops.flatMap((op) => [...(op.errorCodes?.values() ?? [])]))].sort();

  const modelImports = new Set<string>();
  for (const op of ops) {
    if (op.reqBodyRef) modelImports.add(op.reqBodyRef);
    if (op.hasQuery) modelImports.add(queryTypeName(op.name, queryField));
    for (const { ref } of op.jsonResponses) modelImports.add(ref);
    for (const ref of op.errorCodes?.values() ?? []) modelImports.add(ref);
  }

  const importList = [...modelImports].sort().join(",\n  ");

  let src = `// Code generated by apigen/clientgen. DO NOT EDIT.

import type {
  ${importList},
} from "./models.gen";

export class ResponseError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: string,
  ) {
    super(\`baseten API error (HTTP \${statusCode}): \${body}\`);
  }
}
`;

  for (const ref of errorRefs) {
    const fieldName = camelToSnakeField(ref);
    src += `
export class Response${ref} extends Error {
  public readonly ${fieldName}: ${ref};
  constructor(statusCode: number, data: unknown) {
    super(\`baseten API error (HTTP \${statusCode}): \${JSON.stringify(data)}\`);
    this.${fieldName} = data as ${ref};
  }
}
`;
  }

  if (errorRefs.length > 0) {
    const entries = errorRefs.map((ref) => `  "${ref}": Response${ref},`).join("\n");
    src += `
const ERROR_TYPES: Record<string, new (statusCode: number, data: unknown) => Error> = {
${entries}
};
`;
  }

  src += `
interface ApiRequest {
  method: string;
  pathFmt: string;
  pathArgs: string[];
  query: Record<string, unknown> | null;
  body: unknown;
  /** Request body encoding. Defaults to application/json. */
  bodyContentType?: string;
  /** Accept header to send. Omitted when the response is JSON. */
  accept?: string;
  /** Accepted success statuses. Defaults to [200]. */
  successCodes?: number[];
  errorCodes: Record<number, string> | null;
}

export class ApiClient {
  /**
   * Generated HTTP client for the Baseten API.
   *
   * Methods on this client are generated from the OpenAPI specification
   * and are NOT covered by any stability or compatibility guarantees.
   * They may change without notice between versions.
   */
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl: string; headers: Record<string, string>; fetch?: typeof fetch }) {
    this.baseUrl = options.baseUrl;
    this.headers = options.headers;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
`;

  for (const op of ops) {
    // An operation with no JSON success body returns the response directly;
    // there is nothing to deserialize into.
    const rawOnly = op.jsonResponses.length === 0 && op.rawAccepts.length > 0;
    src += `\n${renderMethod(op, queryField, rawOnly)}`;
    // A content-negotiated operation also gets a sibling returning the raw
    // response, since Accept changes the body's type entirely.
    if (op.jsonResponses.length > 0 && op.rawAccepts.length > 0) {
      src += `\n${renderMethod(op, queryField, true)}`;
    }
  }

  src += `
  private async _do(request: ApiRequest): Promise<Response> {
    let path = request.pathFmt.replace(
      /\\{\\}/g,
      (() => {
        let i = 0;
        return () => encodeURIComponent(request.pathArgs[i++]!);
      })(),
    );
    if (request.query !== null) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(request.query)) {
        // Unset params are omitted so the server applies its default. Arrays
        // are exploded into one repeated param per element; enums and other
        // scalars are stringified as-is.
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) search.append(key, String(item));
        } else {
          search.append(key, String(value));
        }
      }
      const qs = search.toString();
      if (qs) path += \`?\${qs}\`;
    }
    const init: RequestInit = {
      method: request.method,
      headers: { ...this.headers },
    };
    const headers = init.headers as Record<string, string>;
    if (request.accept !== undefined) {
      headers["Accept"] = request.accept;
    }
    if (request.body !== null) {
      const contentType = request.bodyContentType ?? "application/json";
      if (contentType === "application/json") {
        headers["Content-Type"] = contentType;
        init.body = JSON.stringify(request.body);
      } else if (contentType === "multipart/form-data") {
        // Deliberately unset: fetch derives it from the FormData, including the
        // boundary, which cannot be computed here.
        init.body = request.body as BodyInit;
      } else {
        headers["Content-Type"] = contentType;
        init.body = request.body as BodyInit;
      }
    }
    const response = await this.fetchImpl(\`\${this.baseUrl}\${path}\`, init);
    if (!(request.successCodes ?? [200]).includes(response.status)) {`;

  if (errorRefs.length > 0) {
    src += `
      if (request.errorCodes?.[response.status]) {
        const ErrorClass = ERROR_TYPES[request.errorCodes[response.status]!];
        if (ErrorClass) {
          try {
            const data = await response.json();
            throw new ErrorClass(response.status, data);
          } catch (e) {
            if (Object.values(ERROR_TYPES).some((cls) => e instanceof cls)) throw e;
          }
        }
      }`;
  }

  src += `
      throw new ResponseError(response.status, await response.text());
    }
    return response;
  }
`;

  if (hasTypedResp) {
    src += `
  private async _doJson<T>(request: ApiRequest): Promise<T> {
    const response = await this._do(request);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new ResponseError(response.status, \`expected a JSON response, got \${contentType}\`);
    }
    return (await response.json()) as T;
  }
`;
  }

  if (ops.some((op) => op.jsonResponses.length > 1)) {
    src += `
  /**
   * Reads a JSON body and pairs it with the status, for operations whose
   * success statuses return different types.
   */
  private async _doJsonWithStatus<T>(request: ApiRequest): Promise<{ status: number; data: T }> {
    const response = await this._do(request);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new ResponseError(response.status, \`expected a JSON response, got \${contentType}\`);
    }
    return { status: response.status, data: (await response.json()) as T };
  }
`;
  }

  if (hasNoResp) {
    src += `
  private async _doNoResponse(request: ApiRequest): Promise<void> {
    await this._do(request);
  }
`;
  }

  src += "}\n";
  return src;
}

/**
 * Renders one method. With `raw`, renders the content-negotiated sibling
 * instead: it takes an `accept` argument and returns the response untouched.
 */
function renderMethod(op: Operation, queryField: string, raw = false): string {
  // A request body is always required so an empty body still sends `{}`; query
  // params are optional unless the spec marks one required. When queryField is
  // "request" the two share a field, which is why an operation with both is
  // rejected for those APIs.
  let bodyType = "";
  if (op.hasBody) {
    bodyType = op.reqBodyRef || bodyTypeForContent(op.bodyContentType);
  }
  const queryType = op.hasQuery ? queryTypeName(op.name, queryField) : "";
  const queryOptional = op.hasQuery && !op.queryRequired;
  const sharedField = queryField === "request";

  // Every content type the success responses can produce. More than one means
  // the caller has to say which it wants.
  const contentTypes = [...(op.jsonResponses.length > 0 ? [JSON_CONTENT] : []), ...op.rawAccepts];
  const needsAcceptParam = raw && contentTypes.length > 1;

  const fields: string[] = [];
  for (const p of op.pathParams) fields.push(`${p}: string`);
  if (needsAcceptParam) {
    fields.push(`accept: ${contentTypes.map((c) => `"${c}"`).join(" | ")}`);
  }
  if (queryType && !sharedField)
    fields.push(`${queryField}${queryOptional ? "?" : ""}: ${queryType}`);
  if (bodyType) fields.push(`request: ${bodyType}`);
  if (queryType && sharedField) fields.push(`request${queryOptional ? "?" : ""}: ${queryType}`);

  const hasParams = fields.length > 0;
  // The whole params argument is optional only when every field it holds is.
  const paramsOptional = hasParams && fields.every((f) => f.includes("?:"));
  const paramSig = hasParams ? `params${paramsOptional ? "?" : ""}: { ${fields.join("; ")} }` : "";

  const pathArgs =
    op.pathParams.length > 0 ? `[${op.pathParams.map((p) => `params.${p}`).join(", ")}]` : "[]";
  const paramsRef = paramsOptional ? "params?" : "params";
  const bodyArg = bodyType ? "params.request" : "null";
  const queryArg = queryType
    ? `${paramsRef}.${sharedField ? "request" : queryField} ?? null`
    : "null";

  let errorExpr: string;
  if (op.errorCodes) {
    const entries = [...op.errorCodes.entries()]
      .sort(([a], [b]) => a - b)
      .map(([code, ref]) => `${code}: "${ref}"`)
      .join(", ");
    errorExpr = `{ ${entries} }`;
  } else {
    errorExpr = "null";
  }

  const parts = [
    `method: "${op.httpMethod}"`,
    `pathFmt: "${pathFmt(op.path)}"`,
    `pathArgs: ${pathArgs}`,
    `query: ${queryArg}`,
    `body: ${bodyArg}`,
  ];
  if (op.bodyContentType && op.bodyContentType !== JSON_CONTENT) {
    parts.push(`bodyContentType: "${op.bodyContentType}"`);
  }
  if (needsAcceptParam) {
    parts.push("accept: params.accept");
  } else if (raw) {
    parts.push(`accept: "${contentTypes[0]}"`);
  }
  // Defaulted in _do, so only emitted when it is not exactly [200].
  if (op.successCodes.length !== 1 || op.successCodes[0] !== 200) {
    parts.push(`successCodes: [${op.successCodes.join(", ")}]`);
  }
  parts.push(`errorCodes: ${errorExpr}`);
  const req = `{ ${parts.join(", ")} }`;

  // The suffix marks the sibling of a JSON method, so a raw-only operation,
  // having no sibling to be confused with, keeps the plain name.
  const isSibling = raw && op.jsonResponses.length > 0;
  const name = isSibling ? `${op.name}Raw` : op.name;
  let jsdoc = "";
  if (op.summary) {
    jsdoc = isSibling
      ? `  /** ${op.summary}. Returns the response unread, in the requested content type. */\n`
      : `  /** ${op.summary} */\n`;
  }

  if (raw) {
    return `${jsdoc}  async ${name}(${paramSig}): Promise<Response> {\n    return this._do(${req});\n  }\n`;
  }
  if (op.jsonResponses.length > 1) {
    const union = op.jsonResponses
      .map(({ code, ref }) => `{ status: ${code}; data: ${ref} }`)
      .join(" | ");
    const dataUnion = op.jsonResponses.map(({ ref }) => ref).join(" | ");
    return `${jsdoc}  async ${name}(${paramSig}): Promise<${union}> {\n    return (await this._doJsonWithStatus<${dataUnion}>(${req})) as ${union};\n  }\n`;
  }
  if (op.jsonResponses.length === 1) {
    const ref = op.jsonResponses[0]!.ref;
    return `${jsdoc}  async ${name}(${paramSig}): Promise<${ref}> {\n    return this._doJson<${ref}>(${req});\n  }\n`;
  }
  return `${jsdoc}  async ${name}(${paramSig}): Promise<void> {\n    await this._doNoResponse(${req});\n  }\n`;
}

/** TypeScript type accepted for a non-JSON request body. */
function bodyTypeForContent(contentType: string): string {
  if (contentType === "multipart/form-data") return "FormData";
  if (contentType === "application/octet-stream") return "BodyInit";
  return "unknown";
}

function camelToSnakeField(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Transforms schema names to match openapi-typescript --root-types-no-schema-prefix casing.
 * An uppercase run keeps its first letter and lowercases the rest, whether it is
 * followed by a word (APIKey -> ApiKey, LLMModel -> LlmModel, AWSCredentials ->
 * AwsCredentials) or trails the name (ModelAPI -> ModelApi).
 */
function rootTypeName(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, (_, p1: string, p2: string) => {
      return p1.charAt(0) + p1.slice(1).toLowerCase() + p2;
    })
    .replace(/([A-Z])([A-Z]+)$/, (_, p1: string, p2: string) => p1 + p2.toLowerCase());
}
