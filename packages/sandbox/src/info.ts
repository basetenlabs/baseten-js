import type {
  Sandbox as ApiSandbox,
  SandboxEnv as ApiSandboxEnv,
  SandboxExpirationPolicy as ApiSandboxExpirationPolicy,
  SandboxFilesystem as ApiSandboxFilesystem,
  SandboxLifecycle as ApiSandboxLifecycle,
  SandboxPort as ApiSandboxPort,
  SandboxVolumeAttachment as ApiSandboxVolumeAttachment,
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

/** Value of an environment variable in a sandbox. */
export interface SandboxEnvValue {
  value: string;

  /**
   * Whether the value is a secret. Defaults to true. Secret values come back
   * masked as `"****"`, unless read with
   * {@link SandboxGetInfoRequest.showSecrets}.
   */
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

/**
 * Filesystem configuration of a sandbox, fixed at creation. The filesystem is
 * held in memory, so files written count against the sandbox's memory.
 */
export interface SandboxFileSystemOptions {
  /**
   * Maximum memory the filesystem can use. A percentage of the sandbox's
   * memory such as `"80%"`, a size such as `"2Gi"`, or a number of megabytes.
   * The server defaults to 50%.
   */
  maxMemoryUsage?: string | number;
}

/** A persistent volume mounted in a sandbox, fixed at creation. */
export interface SandboxVolumeMount {
  /** Name of the volume. */
  name: string;

  /** Absolute path the volume is mounted at. */
  mountPath: string;

  /** Whether the volume is mounted read-only. Defaults to false. */
  readOnly?: boolean;
}

/** A sandbox as last reported by the control plane. */
export interface SandboxInfo {
  /** Unique name of the sandbox, assigned by the server when not given at creation. */
  name: string;

  /** Base URL of the sandbox's execution API, once it has one. */
  url?: string;

  status: SandboxStatus;

  /** Image reference, including its tag. */
  image?: string;

  /** Memory in megabytes. */
  memory?: number;

  /** Number of vCPUs the sandbox runs with. */
  cpu?: number;

  region?: string;

  /**
   * Environment variables, by name. Secret values are masked, so passing
   * these back to an update overwrites their real values with the masks.
   */
  envs: Record<string, SandboxEnvValue>;
  labels: Record<string, string>;

  /** Caller-owned identifier for external lookups. */
  externalId?: string;

  lifecycle?: SandboxLifecycle;
  ports: SandboxPort[];
  filesystem?: SandboxFileSystemOptions;

  /** Persistent volumes mounted in the sandbox. */
  volumes: SandboxVolumeMount[];

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
    image: sandbox.image,
    memory: sandbox.memory,
    cpu: sandbox.cpu,
    region: sandbox.region,
    envs: sandboxEnvsFromApi(sandbox.envs),
    labels: { ...sandbox.labels },
    externalId: sandbox.external_id,
    lifecycle:
      sandbox.lifecycle === undefined ? undefined : sandboxLifecycleFromApi(sandbox.lifecycle),
    ports: sandboxPortsFromApi(sandbox.ports),
    filesystem:
      sandbox.filesystem === undefined
        ? undefined
        : { maxMemoryUsage: sandbox.filesystem.max_memory_usage },
    volumes: (sandbox.volumes ?? []).map((volume) => ({
      name: volume.name,
      mountPath: volume.mount_path,
      readOnly: volume.read_only,
    })),
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

/** Converts a filesystem configuration to the control plane's form. */
export function sandboxFileSystemToApi(filesystem: SandboxFileSystemOptions): ApiSandboxFilesystem {
  return { max_memory_usage: filesystem.maxMemoryUsage };
}

/** Converts volume mounts to the control plane's form. */
export function sandboxVolumesToApi(volumes: SandboxVolumeMount[]): ApiSandboxVolumeAttachment[] {
  return volumes.map((volume) => ({
    name: volume.name,
    mount_path: volume.mountPath,
    read_only: volume.readOnly,
  }));
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

export function sandboxPortsFromApi(ports: ApiSandboxPort[] | undefined): SandboxPort[] {
  return (ports ?? []).map(({ target, name, protocol }) => ({ target, name, protocol }));
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
