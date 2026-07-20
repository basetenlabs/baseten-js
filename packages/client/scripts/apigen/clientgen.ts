/**
 * Generates typed fetch-based API clients from OpenAPI specs.
 *
 * Each operation becomes an async method on an ApiClient class. Types
 * are imported from the generated models.gen.d.ts.
 */

export function generateClient(specData: Uint8Array): string {
  const spec = JSON.parse(new TextDecoder().decode(specData));
  const ops = extractOperations(spec);
  return renderClient(ops);
}

const PATH_PARAM_RE = /\{(\w+)\}/g;
const PATH_PARAM_FULL_RE = /^\{(\w+)\}$/;

interface Operation {
  name: string;
  httpMethod: string;
  path: string;
  pathParams: string[];
  hasBody: boolean;
  hasQuery: boolean;
  queryRequired: boolean;
  reqBodyRef: string;
  respRef: string;
  successCode: number;
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

/** Model name for an operation's injected query-parameter schema. */
export function queryRequestTypeName(methodName: string): string {
  return methodName.charAt(0).toUpperCase() + methodName.slice(1) + "Request";
}

function extractOperations(spec: Record<string, unknown>): Operation[] {
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
      if (hasBody && queryParams.length > 0) {
        throw new Error(
          `${httpMethod.toUpperCase()} ${path} has both a request body and query parameters; ` +
            "the generated `request` field cannot represent both",
        );
      }
      ops.push({
        name,
        httpMethod: httpMethod.toUpperCase(),
        path,
        pathParams: [...path.matchAll(PATH_PARAM_RE)].map((m) => m[1]!),
        hasBody,
        hasQuery: queryParams.length > 0,
        queryRequired: queryParams.some((p) => p.required === true),
        reqBodyRef: bodySchemaRef(spec, opData),
        respRef: responseSchemaRef(spec, opData),
        successCode: extractSuccessCode(opData, httpMethod, path),
        errorCodes: errorCodeMap(spec, opData),
        summary: (opData.summary as string) ?? "",
      });
    }
  }
  ops.sort((a, b) => a.name.localeCompare(b.name));
  return ops;
}

function extractSuccessCode(op: Record<string, unknown>, httpMethod: string, path: string): number {
  const responses = (op.responses ?? {}) as Record<string, unknown>;
  const codes = Object.keys(responses)
    .filter((c) => /^\d+$/.test(c) && Number(c) >= 200 && Number(c) < 300)
    .map(Number);
  if (codes.length !== 1) {
    throw new Error(
      `expected exactly one 2xx response for ${httpMethod.toUpperCase()} ${path}, got [${codes}]`,
    );
  }
  return codes[0]!;
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

function responseSchemaRef(spec: Record<string, unknown>, op: Record<string, unknown>): string {
  const responses = (op.responses ?? {}) as Record<string, Record<string, unknown>>;
  for (const code of ["200", "201", "202"]) {
    const respNode = responses[code];
    if (!respNode) continue;
    const resolved = resolveRef(spec, respNode);
    const ref = jsonContentSchemaRef(resolved);
    if (ref) return ref;
    // If the response was a $ref and has JSON content, use the component name.
    if (respNode.$ref && hasJsonContent(resolved)) {
      const name = (respNode.$ref as string).split("/").pop();
      if (name) return rootTypeName(name);
    }
  }
  return "";
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

function renderClient(ops: Operation[]): string {
  const hasTypedResp = ops.some((op) => op.respRef);
  const hasNoResp = ops.some((op) => !op.respRef);

  const errorRefs = [...new Set(ops.flatMap((op) => [...(op.errorCodes?.values() ?? [])]))].sort();

  const modelImports = new Set<string>();
  for (const op of ops) {
    if (op.reqBodyRef) modelImports.add(op.reqBodyRef);
    if (op.hasQuery) modelImports.add(queryRequestTypeName(op.name));
    if (op.respRef) modelImports.add(op.respRef);
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
  successCode: number;
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
    src += `\n${renderMethod(op)}`;
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
    if (request.body !== null) {
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    const response = await this.fetchImpl(\`\${this.baseUrl}\${path}\`, init);
    if (response.status !== request.successCode) {`;

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
  // TODO(https://github.com/basetenlabs/baseten-js/issues/2): support non-JSON response content types
  private async _doJson<T>(request: ApiRequest): Promise<T> {
    const response = await this._do(request);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new ResponseError(response.status, \`non-JSON response content type not currently supported, got \${contentType}\`);
    }
    return (await response.json()) as T;
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

function renderMethod(op: Operation): string {
  // An operation carries at most one input model on the `request` field: a
  // request body (non-GET) or query parameters (GET). Both are represented as
  // the same field since no operation has both. A body is always required so an
  // empty body still sends `{}`; query params are optional unless the spec
  // marks one required.
  let requestType = "";
  let requestRequired = false;
  if (op.hasBody) {
    requestType = op.reqBodyRef || "unknown";
    requestRequired = true;
  } else if (op.hasQuery) {
    requestType = queryRequestTypeName(op.name);
    requestRequired = op.queryRequired;
  }

  const hasParams = op.pathParams.length > 0 || requestType !== "";
  // The whole params argument is optional when every field it holds is
  // optional, i.e. no path params and an optional request.
  const paramsOptional = op.pathParams.length === 0 && requestType !== "" && !requestRequired;

  let paramsType = "";
  if (hasParams) {
    const fields: string[] = [];
    for (const p of op.pathParams) {
      fields.push(`${p}: string`);
    }
    if (requestType) {
      fields.push(`request${requestRequired ? "" : "?"}: ${requestType}`);
    }
    paramsType = `{ ${fields.join("; ")} }`;
  }

  const paramSig = hasParams ? `params${paramsOptional ? "?" : ""}: ${paramsType}` : "";
  const retType = op.respRef ? `Promise<${op.respRef}>` : "Promise<void>";

  const pathArgs =
    op.pathParams.length > 0 ? `[${op.pathParams.map((p) => `params.${p}`).join(", ")}]` : "[]";
  const paramsRef = paramsOptional ? "params?" : "params";
  const bodyArg = op.hasBody ? "params.request" : "null";
  const queryArg = op.hasQuery ? `${paramsRef}.request ?? null` : "null";

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

  const req = `{ method: "${op.httpMethod}", pathFmt: "${pathFmt(op.path)}", pathArgs: ${pathArgs}, query: ${queryArg}, body: ${bodyArg}, successCode: ${op.successCode}, errorCodes: ${errorExpr} }`;

  let jsdoc = "";
  if (op.summary) {
    jsdoc = `  /** ${op.summary} */\n`;
  }

  if (op.respRef) {
    return `${jsdoc}  async ${op.name}(${paramSig}): ${retType} {\n    return this._doJson<${op.respRef}>(${req});\n  }\n`;
  }
  return `${jsdoc}  async ${op.name}(${paramSig}): ${retType} {\n    await this._doNoResponse(${req});\n  }\n`;
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
