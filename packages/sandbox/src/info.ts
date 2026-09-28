import type {
  Sandbox as ApiSandbox,
  SandboxEnv as ApiSandboxEnv,
  SandboxExpirationPolicy as ApiSandboxExpirationPolicy,
  SandboxLifecycle as ApiSandboxLifecycle,
  SandboxNetwork as ApiSandboxNetwork,
  SandboxPort as ApiSandboxPort,
  SandboxProxyTarget as ApiSandboxProxyTarget,
} from "@basetenlabs/client/managementapi";
import { formatDuration, parseDuration } from "./common";

/**
 * Deployment status of a sandbox. Only `DEPLOYED` sandboxes run commands.
 * Other values may be added, so do not treat this list as exhaustive.
 */
export type SandboxStatus =
  | "DEPLOYING"
  | "DEPLOYED"
  | "FAILED"
  | "DEACTIVATING"
  | "DEACTIVATED"
  | "DELETING"
  | "TERMINATED"
  | "ARCHIVING"
  | "ARCHIVED"
  | "UNARCHIVING"
  | "BUILDING"
  | "UPLOADING"
  | (string & {});

/**
 * Whether a deployed sandbox is running or idle in standby. Other values may
 * be added, so do not treat this list as exhaustive.
 */
export type SandboxState = "RUNNING" | "STANDBY" | (string & {});

/** Value of an environment variable in a sandbox. */
export interface SandboxEnvValue {
  value: string;

  /** Whether the value is a secret. */
  secret?: boolean;
}

/** When a sandbox is deleted automatically, and how long its record stays after. */
export interface SandboxLifecycle {
  /**
   * Conditions for deleting the sandbox. Whichever is met first applies.
   * Replaces all previous policies when updated.
   */
  expirationPolicies?: SandboxExpirationPolicy[];

  /**
   * Milliseconds the record stays after the sandbox terminates, for log
   * access. The server defaults to 5 minutes.
   */
  terminatedRetentionMs?: number;
}

/**
 * A condition for acting on a sandbox automatically. Durations the server
 * reports in days or weeks convert at 24 hours per day.
 */
export type SandboxExpirationPolicy =
  | {
      /** After `afterMs` milliseconds without activity. */
      type: "TTL_IDLE";
      afterMs: number;
      action?: SandboxExpirationAction;
    }
  | {
      /** `afterMs` milliseconds after creation, regardless of activity. */
      type: "TTL_MAX_AGE";
      afterMs: number;
      action?: SandboxExpirationAction;
    }
  | {
      /** At a fixed time. */
      type: "DATE";
      at: Date;
      action?: SandboxExpirationAction;
    };

/**
 * What an expiration policy does when met. `DELETE` when unset. Other values
 * may be added, so do not treat this list as exhaustive.
 */
export type SandboxExpirationAction = "DELETE" | (string & {});

/** A port the sandbox exposes. */
export interface SandboxPort {
  /** Port number in the sandbox, 1 to 65535. */
  target: number;
  name?: string;
  protocol?: SandboxPortProtocol;
}

/** Protocol of a sandbox port. Other values may be added, so do not treat this list as exhaustive. */
export type SandboxPortProtocol = "HTTP" | "TCP" | "UDP" | "TLS" | (string & {});

/** Network configuration of a sandbox, fixed at creation. */
export interface SandboxNetwork {
  /** Subnet name. The server defaults to `default`. */
  subnet?: string;

  /** Routes the sandbox's HTTP traffic through the platform proxy. */
  proxy?: SandboxNetworkProxy;
}

/** Proxy configuration of a sandbox's network. */
export interface SandboxNetworkProxy {
  /**
   * When set, only these external domains are reachable. Supports wildcards
   * such as `*.example.com`. Takes precedence over `forbiddenDomains`.
   */
  allowedDomains?: string[];

  /** When set, every external domain except these is reachable. Supports wildcards. */
  forbiddenDomains?: string[];

  /**
   * Domains reached directly rather than through the proxy. Supports
   * wildcards. Local and private addresses always bypass it.
   */
  bypass?: string[];

  /** Rules injecting headers and body fields into matching requests. */
  routing?: SandboxNetworkProxyRoute[];
}

/** A proxy rule injecting headers and body fields into requests to its destinations. */
export interface SandboxNetworkProxyRoute {
  /** Destination domains the rule applies to. `["*"]` matches all. */
  destinations?: string[];

  /** Headers to inject. Values may reference `{{SECRET:name}}` from `secrets`. */
  headers?: Record<string, string>;

  /** Body fields to inject. Values may reference `{{SECRET:name}}` from `secrets`. */
  body?: Record<string, string>;

  /** Named secret values for this rule. Write-only, so always unset on {@link SandboxInfo}. */
  secrets?: Record<string, string>;
}

/** A sandbox as last reported by the control plane. */
export interface SandboxInfo {
  /** Unique name of the sandbox, assigned by the server when not given at creation. */
  name: string;

  /** Base URL of the sandbox's execution API, once it has one. */
  url?: string;

  status: SandboxStatus;
  state?: SandboxState;

  /** Image reference, including its tag. */
  image?: string;

  /** Memory in megabytes, which also sets the CPU allocation. */
  memory?: number;

  region?: string;

  /** False when the sandbox is disabled and accepts no connections. */
  enabled: boolean;

  /**
   * Environment variables, by name. Values are masked, so passing these back
   * to an update overwrites the real values with the masks.
   */
  envs: Record<string, SandboxEnvValue>;
  labels: Record<string, string>;
  displayName?: string;

  /** Caller-owned identifier for external lookups. */
  externalId?: string;

  lifecycle?: SandboxLifecycle;
  ports: SandboxPort[];
  network?: SandboxNetwork;

  createdAt: Date;
  updatedAt?: Date;
  createdBy?: string;
  updatedBy?: string;
  lastUsedAt?: Date;

  /** Milliseconds left before automatic deletion, when expiration is configured. */
  expiresInMs?: number;
}

/** Converts the control plane's sandbox record. */
export function sandboxInfoFromApi(sandbox: ApiSandbox): SandboxInfo {
  return {
    name: sandbox.name,
    url: sandbox.url,
    status: sandbox.status,
    state: sandbox.state,
    image: sandbox.image,
    memory: sandbox.memory,
    region: sandbox.region,
    enabled: sandbox.enabled,
    envs: sandboxEnvsFromApi(sandbox.envs),
    labels: { ...sandbox.labels },
    displayName: sandbox.display_name,
    externalId: sandbox.external_id,
    lifecycle:
      sandbox.lifecycle === undefined ? undefined : sandboxLifecycleFromApi(sandbox.lifecycle),
    ports: sandboxPortsFromApi(sandbox.ports),
    network: sandbox.network === undefined ? undefined : sandboxNetworkFromApi(sandbox.network),
    createdAt: new Date(sandbox.created_at),
    updatedAt: optionalDate(sandbox.updated_at),
    createdBy: sandbox.created_by,
    updatedBy: sandbox.updated_by,
    lastUsedAt: optionalDate(sandbox.last_used_at),
    expiresInMs: sandbox.expires_in === undefined ? undefined : sandbox.expires_in * 1000,
  };
}

/** Converts environment variables to the control plane's form. */
export function sandboxEnvsToApi(envs: Record<string, SandboxEnvValue>): ApiSandboxEnv[] {
  return Object.entries(envs).map(([name, { value, secret }]) => ({ name, value, secret }));
}

/** Converts a lifecycle to the control plane's form. */
export function sandboxLifecycleToApi(lifecycle: SandboxLifecycle): ApiSandboxLifecycle {
  return {
    expiration_policies: lifecycle.expirationPolicies?.map(expirationPolicyToApi),
    terminated_retention:
      lifecycle.terminatedRetentionMs === undefined
        ? undefined
        : formatDuration(lifecycle.terminatedRetentionMs),
  };
}

/** Converts ports to the control plane's form. */
export function sandboxPortsToApi(ports: SandboxPort[]): ApiSandboxPort[] {
  // The generated type lists only the known protocols; others pass through.
  return ports.map(({ target, name, protocol }) => ({
    target,
    name,
    protocol: protocol as ApiSandboxPort["protocol"],
  }));
}

/** Converts a network configuration to the control plane's form. */
export function sandboxNetworkToApi(network: SandboxNetwork): ApiSandboxNetwork {
  const proxy = network.proxy;
  return {
    subnet: network.subnet,
    proxy:
      proxy === undefined
        ? undefined
        : {
            allowed_domains: proxy.allowedDomains,
            forbidden_domains: proxy.forbiddenDomains,
            bypass: proxy.bypass,
            routing: proxy.routing?.map((route): ApiSandboxProxyTarget => ({
              destinations: route.destinations,
              headers: route.headers,
              body: route.body,
              secrets: route.secrets,
            })),
          },
  };
}

function expirationPolicyToApi(policy: SandboxExpirationPolicy): ApiSandboxExpirationPolicy {
  // The generated type allows only DELETE; other actions pass through.
  const action = (policy.action ?? "DELETE") as "DELETE";
  if (policy.type === "DATE") {
    return { type: "DATE", action, value: policy.at.toISOString() };
  }
  return { type: policy.type, action, value: formatDuration(policy.afterMs) };
}

function sandboxLifecycleFromApi(lifecycle: ApiSandboxLifecycle): SandboxLifecycle {
  const retention = lifecycle.terminated_retention;
  return {
    expirationPolicies: lifecycle.expiration_policies?.map(expirationPolicyFromApi),
    terminatedRetentionMs:
      retention === undefined || retention === ""
        ? undefined
        : parseDuration(retention, "lifecycle terminated retention"),
  };
}

function expirationPolicyFromApi(policy: ApiSandboxExpirationPolicy): SandboxExpirationPolicy {
  if (policy.type === "DATE") {
    return { type: "DATE", at: new Date(policy.value), action: policy.action };
  }
  return {
    type: policy.type,
    afterMs: parseDuration(policy.value, `${policy.type} expiration policy`),
    action: policy.action,
  };
}

function sandboxPortsFromApi(ports: ApiSandboxPort[] | undefined): SandboxPort[] {
  return (ports ?? []).map(({ target, name, protocol }) => ({ target, name, protocol }));
}

function sandboxNetworkFromApi(network: ApiSandboxNetwork): SandboxNetwork {
  const proxy = network.proxy;
  return {
    subnet: network.subnet,
    proxy:
      proxy === undefined
        ? undefined
        : {
            allowedDomains: proxy.allowed_domains,
            forbiddenDomains: proxy.forbidden_domains,
            bypass: proxy.bypass,
            routing: proxy.routing?.map((route) => ({
              destinations: route.destinations,
              headers: route.headers,
              body: route.body,
              secrets: route.secrets,
            })),
          },
  };
}

function sandboxEnvsFromApi(envs: ApiSandboxEnv[] | undefined): Record<string, SandboxEnvValue> {
  const result: Record<string, SandboxEnvValue> = {};
  for (const env of envs ?? []) {
    if (env.name === undefined) continue;
    result[env.name] = { value: env.value ?? "", secret: env.secret };
  }
  return result;
}

/** @internal Converts an optional timestamp, which the server may send as empty. */
export function optionalDate(value: string | undefined): Date | undefined {
  return value === undefined || value === "" ? undefined : new Date(value);
}
