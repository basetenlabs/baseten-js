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
  reqBodyRef: string;
  respRef: string;
  successCode: number;
  errorCodes: Map<number, string> | null;
  summary: string;
}

function extractOperations(spec: Record<string, unknown>): Operation[] {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;

  // Collect raw operation data with short names to detect collisions.
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

  // Build operations, using trailing param only where needed to disambiguate.
  const ops: Operation[] = [];
  for (const { path, httpMethod, opData } of raw) {
    const short = deriveMethodName(httpMethod, path, opData, false);
    const name =
      (shortNames.get(short) ?? 0) > 1 ? deriveMethodName(httpMethod, path, opData, true) : short;
    ops.push({
      name,
      httpMethod: httpMethod.toUpperCase(),
      path,
      pathParams: [...path.matchAll(PATH_PARAM_RE)].map((m) => m[1]!),
      hasBody: "requestBody" in opData,
      reqBodyRef: bodySchemaRef(spec, opData),
      respRef: responseSchemaRef(spec, opData),
      successCode: extractSuccessCode(opData, httpMethod, path),
      errorCodes: errorCodeMap(spec, opData),
      summary: (opData.summary as string) ?? "",
    });
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
    const path = request.pathFmt.replace(
      /\\{\\}/g,
      (() => {
        let i = 0;
        return () => encodeURIComponent(request.pathArgs[i++]!);
      })(),
    );
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
  const hasParams = op.pathParams.length > 0 || op.hasBody;

  let paramsType = "";
  if (hasParams) {
    const fields: string[] = [];
    for (const p of op.pathParams) {
      fields.push(`${p}: string`);
    }
    if (op.hasBody) {
      const bodyType = op.reqBodyRef || "unknown";
      fields.push(`body: ${bodyType}`);
    }
    paramsType = `{ ${fields.join("; ")} }`;
  }

  const paramSig = hasParams ? `params: ${paramsType}` : "";
  const retType = op.respRef ? `Promise<${op.respRef}>` : "Promise<void>";

  const pathArgs =
    op.pathParams.length > 0 ? `[${op.pathParams.map((p) => `params.${p}`).join(", ")}]` : "[]";
  const bodyArg = op.hasBody ? "params.body" : "null";

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

  const req = `{ method: "${op.httpMethod}", pathFmt: "${pathFmt(op.path)}", pathArgs: ${pathArgs}, body: ${bodyArg}, successCode: ${op.successCode}, errorCodes: ${errorExpr} }`;

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
 * e.g. APIKey -> ApiKey, LLMModel -> LlmModel, AWSCredentials -> AwsCredentials
 */
function rootTypeName(name: string): string {
  return name.replace(
    /([A-Z]+)([A-Z][a-z])/g,
    (_, p1: string, p2: string) => p1.charAt(0) + p1.slice(1).toLowerCase() + p2,
  );
}
