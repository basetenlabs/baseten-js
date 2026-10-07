/** Options that decide which fetch requests are sent with. */
export interface TransportOptions {
  fetch?: typeof fetch;
  nodeUndici?: boolean;
}

/**
 * The fetch a client and its clones send every request with, chosen on the
 * first request: the caller's fetch when given, otherwise the global fetch,
 * with HTTP/2 added on Node when possible.
 */
export class Transport {
  private readonly options: TransportOptions;
  private selected?: Promise<typeof fetch>;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    this.selected ??= this.select();
    return (await this.selected)(input, init);
  };

  private async select(): Promise<typeof fetch> {
    if (this.options.fetch !== undefined) return this.options.fetch;
    // Resolved per call so a fetch replaced after construction is still used.
    const globalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
    if (this.options.nodeUndici === false || !isNode()) return globalFetch;
    const undici = undiciForNodeHttp2();
    if (typeof undici === "string") {
      if (this.options.nodeUndici === true) {
        throw new Error(`nodeUndici is true, but undici cannot be used: ${undici}`);
      }
      return globalFetch;
    }
    // Never closed, same as Node's own default Agent, which neither undici nor
    // Node ever closes: idle connections close after undici's 4s keep-alive
    // and never keep the process alive.
    const dispatcher = new undici.Agent({
      allowH2: true,
      initialWindowSize: HTTP2_STREAM_WINDOW_BYTES,
      connectionWindowSize: HTTP2_CONNECTION_WINDOW_BYTES,
    });
    // Node's fetch accepts a dispatcher, which its RequestInit type omits.
    return (input, init) => globalThis.fetch(input, { ...init, dispatcher } as RequestInit);
  }
}

// HTTP/2 on Node.
//
// Node's fetch negotiates only HTTP/1.1 while its bundled undici is older than
// 8, and HTTP/2 from 8 on, but with undici's default flow control windows,
// which are small for large transfers. So on Node an HTTP/2-enabled undici
// Agent with larger windows is created per client and passed as the
// dispatcher to Node's own fetch. Without one, requests get whatever Node's
// fetch negotiates, which this SDK cannot change. Constraints: no new dependency, nothing left changed in the process
// for code outside this SDK, no undici internals beyond the shared globals
// below, and no bypassing of how an app has configured its own connections,
// such as a proxy.
//
// The awkward part is that loading undici has a side effect: on first load it
// installs its own Agent as the process-wide dispatcher when there is none yet,
// which would move every fetch in the app onto that copy of undici. That
// install is undone here, which needs the dispatcher's value from before the
// load. undici's getGlobalDispatcher() only exists after loading it, so the
// value is read from the global symbols that every undici copy, Node's own
// included, uses to share the dispatcher. undici 8 keeps it under a new symbol
// and mirrors it to the old one; older copies use only the old one.
//
// Supported undici versions are checked at runtime. undici 8 changed the
// dispatcher API that Node's fetch calls, so it is only used when Node's
// bundled undici is 8 or newer too.
//
// Rejected alternatives:
// - Declaring undici as a peer dependency. npm fails installs on an
//   out-of-range peer, which would break apps over an optional speedup, and
//   pnpm, yarn, and hoisting do not enforce the range anyway.
// - Adapting undici 8's Agent to an older Node fetch with its
//   Dispatcher1Wrapper. The wrapper forces HTTP/1.1.
// - Leaving undici's install in place. Changes fetch for the whole app.
// - A throwaway fetch of a data: URL before loading undici, so Node installs
//   its own default first. Works, but is an obscure trick with its own
//   surprises.
// - Importing undici's Agent module directly by internal path, which skips the
//   install. Relies on undici's private file layout.
// - A fetch written on node:http2. Needs its own pooling, GOAWAY and flow
//   control handling, and cannot see a proxy the app configured.
// - Using undici's own fetch. Mixing it with the global FormData, which the
//   generated clients use for uploads, is unsupported.
// - Leaving HTTP/2 entirely to the app. Most apps would never enable it.

const UNDICI_GLOBAL_DISPATCHER_1 = Symbol.for("undici.globalDispatcher.1");
const UNDICI_GLOBAL_DISPATCHER_2 = Symbol.for("undici.globalDispatcher.2");

// 7.19.0 is the first with the window size options below.
const UNDICI_SUPPORTED_RANGE = ">=7.19.0 <9";

// Node's defaults of 64KB cap a single download at one window per round
// trip, so large reads are bound by latency instead of bandwidth.
const HTTP2_STREAM_WINDOW_BYTES = 16 * 1024 * 1024;
const HTTP2_CONNECTION_WINDOW_BYTES = 32 * 1024 * 1024;

// The parts of undici used here, declared locally since undici is optional
// and its types may not be installed.
interface Undici {
  Agent: new (options: object) => object;
}

function isNode(): boolean {
  const versions = typeof process === "undefined" ? undefined : process.versions;
  // Bun and Deno also report a Node version, for compatibility.
  return versions?.node !== undefined && versions.bun === undefined && versions.deno === undefined;
}

/** Returns undici when requests may use it for HTTP/2 on Node, otherwise why not. */
function undiciForNodeHttp2(): Undici | string {
  loadedUndici ??= loadUndici();
  const undici = loadedUndici;
  if (typeof undici === "string") return undici;
  // Anything but a plain Agent, such as a proxy or a mock, means the app has
  // configured how fetch connects, which must not be bypassed. Node's own
  // default Agent comes from its bundled copy of undici, so it is not an
  // instance of this copy's Agent and is recognized by name instead.
  const globals = globalThis as Record<symbol, object | undefined>;
  const dispatcher = globals[UNDICI_GLOBAL_DISPATCHER_2] ?? globals[UNDICI_GLOBAL_DISPATCHER_1];
  if (
    dispatcher !== undefined &&
    !(dispatcher instanceof undici.Agent) &&
    dispatcher.constructor.name !== "Agent"
  ) {
    return `the app has set its own global dispatcher (${dispatcher.constructor.name})`;
  }
  return undici;
}

let loadedUndici: Undici | string | undefined;
let requireForTests: ((id: string) => unknown) | undefined;

/** @internal Replaces how undici is required, so tests can pick the copy. */
export function setRequireForTests(require: ((id: string) => unknown) | undefined): void {
  requireForTests = require;
  loadedUndici = undefined;
}

/** Loads undici, or returns why it cannot be used. */
function loadUndici(): Undici | string {
  const require = requireForTests ?? nodeRequire();
  if (require === undefined) return "loading undici needs Node 22.3 or newer";
  // Checked before loading undici itself, so an unsupported copy never runs
  // its install.
  let version: string;
  try {
    version = (require("undici/package.json") as { version: string }).version;
  } catch {
    return "the undici package is not installed";
  }
  if (!isSupportedUndiciVersion(version)) {
    return `undici ${version} is installed, but ${UNDICI_SUPPORTED_RANGE} is required`;
  }
  const nodeUndici = process.versions.undici ?? "0";
  if (undiciMajor(version) >= 8 && undiciMajor(nodeUndici) < 8) {
    return `undici ${version} is installed, but it needs Node's bundled undici to be 8 or newer, and it is ${nodeUndici}`;
  }
  const globals = globalThis as Record<symbol, unknown>;
  const before1 = globals[UNDICI_GLOBAL_DISPATCHER_1];
  const before2 = globals[UNDICI_GLOBAL_DISPATCHER_2];
  // Loaded synchronously, not with an awaited import(), so no other code can
  // run between saving the dispatchers above and restoring them below. Code
  // running in between could set its own dispatcher, which the restore would
  // then undo.
  try {
    return require("undici") as Undici;
  } catch {
    return "the undici package failed to load";
  } finally {
    // Undoes undici's install, described above. The one case this breaks is
    // an app that loads the same undici only later and uses its implicit
    // default before anything has called fetch.
    if (globals[UNDICI_GLOBAL_DISPATCHER_1] !== before1) {
      globals[UNDICI_GLOBAL_DISPATCHER_1] = before1;
    }
    if (globals[UNDICI_GLOBAL_DISPATCHER_2] !== before2) {
      globals[UNDICI_GLOBAL_DISPATCHER_2] = before2;
    }
  }
}

function isSupportedUndiciVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return (major === 7 && minor >= 19) || major === 8;
}

function undiciMajor(version: string): number {
  return Number(version.split(".")[0]);
}

/**
 * Returns Node's require, resolving from this package, or undefined on Node
 * before 22.3. Getting it through getBuiltinModule rather than importing
 * node:module keeps it out of reach of bundlers, including this package's own
 * build, and away from runtimes without it.
 */
function nodeRequire(): ((id: string) => unknown) | undefined {
  const nodeModule = process.getBuiltinModule?.("node:module") as
    | { createRequire(path: string): (id: string) => unknown }
    | undefined;
  return nodeModule?.createRequire(import.meta.url);
}
