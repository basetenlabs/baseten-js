import { VERSION } from "./version";

/** Build the User-Agent header value for outbound Baseten API calls. */
export function userAgentHeader(): string {
  const base = `baseten-js/${VERSION}`;
  const nodeVersion = typeof process !== "undefined" ? process.versions?.node : undefined;
  const platform = typeof process !== "undefined" ? process.platform : undefined;
  if (nodeVersion != null && platform != null) {
    return `${base} (Node/${nodeVersion}; ${platform})`;
  }
  return base;
}

/** Set User-Agent on headers if not already present. */
export function applyUserAgentHeader(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "user-agent") {
      return;
    }
  }
  headers["User-Agent"] = userAgentHeader();
}
