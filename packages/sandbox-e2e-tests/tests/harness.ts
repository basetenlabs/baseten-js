import { randomUUID } from "node:crypto";
import { SandboxClient, type SandboxInfo } from "@basetenlabs/sandbox";

const API_KEY = process.env.BASETEN_E2E_TEST_API_KEY ?? "";
const DOMAIN = process.env.BASETEN_E2E_TEST_DOMAIN ?? "";

// Set to dump every request and response, for spotting server-side anomalies.
// Credentials are masked. Requests then go through the global fetch, so over
// HTTP/1.1, except in clients that drop this fetch.
const DEBUG = process.env.BASETEN_E2E_TEST_DEBUG === "1";

/** Whether the e2e env is set, so the suite runs. */
export function e2eEnabled(): boolean {
  if (!API_KEY) return false;
  if (!DOMAIN) {
    throw new Error("BASETEN_E2E_TEST_API_KEY is set but BASETEN_E2E_TEST_DOMAIN is missing");
  }
  return true;
}

// Logs each request and its response as one entry, once the response body is
// done. The body is not held back from the caller, so streams still stream.
const debugFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const headers = Object.fromEntries(request.headers);
  if (headers.authorization !== undefined) headers.authorization = "<masked>";
  // The token exchange's response body is the minted token.
  const masksBody = new URL(request.url).pathname === "/v1/token";
  const logged = { headers, body: init?.body };
  const started = Date.now();
  try {
    const response = await fetch(input, init);
    const ms = Date.now() - started;
    const log = (body: unknown) =>
      console.log(request.method, request.url, {
        request: logged,
        response: {
          status: response.status,
          ms,
          headers: Object.fromEntries(response.headers),
          body,
        },
      });
    if (masksBody) {
      log("<masked>");
    } else {
      void response
        .clone()
        .text()
        .then(log, (err: unknown) => log({ unreadable: String(err) }));
    }
    return response;
  } catch (err) {
    console.log(request.method, request.url, {
      request: logged,
      failedAfterMs: Date.now() - started,
      err,
    });
    throw err;
  }
};

/** A client for the e2e env. */
export function sandboxClient(): SandboxClient {
  return new SandboxClient({
    apiKey: API_KEY,
    baseUrlOverride: `https://api.${DOMAIN}`,
    fetch: DEBUG ? debugFetch : undefined,
  });
}

/** A fresh sandbox name, so concurrent runs never clash. */
export function uniqueName(): string {
  return `js-e2e-${randomUUID().slice(0, 8)}`;
}

/** Labels on every sandbox the suite creates. */
export const E2E_LABELS = { created_by: "e2e" };

/** Env on the shared sandbox, by name. */
export const SHARED_ENVS = {
  E2E_PLAIN: { value: "plain-value", secret: false },
  E2E_SECRET: { value: "secret-value", secret: true },
  // Left to the server's default, which is secret.
  E2E_DEFAULT: { value: "default-value" },
};

/** Polls until the sandbox is deployed, failing fast if it cannot be. */
export async function waitDeployed(client: SandboxClient, name: string): Promise<SandboxInfo> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const info = await client.getInfo({ name });
    if (info.status === "DEPLOYED") return info;
    if (info.status !== "DEPLOYING") {
      throw new Error(`sandbox ${name} is ${info.status}, not deploying`);
    }
    if (Date.now() > deadline) throw new Error(`sandbox ${name} is still deploying`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
