export interface CapturedRequest {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Creates a fake fetch that returns a fixed response and captures the last request.
 */
export function fakeFetch(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; capture: () => CapturedRequest } {
  let captured: CapturedRequest | null = null;

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) {
        headers[k.toLowerCase()] = v;
      }
    }
    let reqBody: unknown = null;
    if (init?.body) {
      reqBody = JSON.parse(init.body as string);
    }
    const parsedUrl = new URL(url);
    captured = { url, path: parsedUrl.pathname, method, headers, body: reqBody };

    const responseBody = body !== null ? JSON.stringify(body) : "";
    const responseHeaders: Record<string, string> = {};
    if (body !== null) {
      responseHeaders["content-type"] = "application/json";
    }
    return new Response(responseBody, { status, headers: responseHeaders });
  };

  return {
    fetch: fetchImpl as typeof globalThis.fetch,
    capture: () => {
      if (!captured) throw new Error("no request captured");
      return captured;
    },
  };
}
