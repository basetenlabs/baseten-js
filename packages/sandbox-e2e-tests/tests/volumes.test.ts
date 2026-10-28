import { SandboxApiError, type Sandbox, type VolumeInfo } from "@basetenlabs/sandbox";
import { describe, expect, it } from "vitest";
import {
  E2E_LABELS,
  E2E_REGION,
  e2eEnabled,
  sandboxClient,
  uniqueName,
  waitDeployed,
} from "./harness";

// Bound on each volume state change the test waits for: deploying, resizing,
// becoming deletable once unmounted. Each has taken about 3s.
const VOLUME_WAIT_MS = 30_000;
const VOLUME_POLL_MS = 200;

describe.runIf(e2eEnabled())("VolumeClient", () => {
  // Walks one volume through its life: CRUD, then mounted in a sandbox and
  // grown there.
  it("creates, updates, mounts, grows, and deletes a volume", async () => {
    const client = sandboxClient();
    const volumes = client.volumes;
    const started = Date.now();
    const volumeName = uniqueName();
    const sandboxName = uniqueName();
    console.log(`volume ${volumeName}, sandbox ${sandboxName}`);
    // Each is marked live before creating, so even a partial create is
    // removed.
    let volumeLive = false;
    let sandboxLive = false;
    let deleted: VolumeInfo | undefined;
    const deletable = async () => {
      // Fails until the deleted sandbox has let go of the volume.
      try {
        deleted = await volumes.delete({ name: volumeName });
        return true;
      } catch (err) {
        if (err instanceof SandboxApiError && err.status === 409) return false;
        throw err;
      }
    };
    let failure: { error: unknown } | undefined;
    try {
      volumeLive = true;
      let labels = { ...E2E_LABELS, step: "create" };
      const created = await volumes.create({
        name: volumeName,
        size: 512,
        region: E2E_REGION,
        labels,
      });
      expect([created.name, created.region]).toEqual([volumeName, E2E_REGION]);
      // The server normalizes either size form to a size string.
      expect(created.size).toBe("512Mi");
      expect(created.attachedTo).toBeUndefined();
      expect(created.createdBy).toBeTruthy();
      expectWithinRun(started, created.createdAt);
      let elapsed = await eventually("volume deployed", async () => {
        const info = await volumes.getInfo({ name: volumeName });
        expect(info.status).not.toBe("FAILED");
        return info.status === "DEPLOYED";
      });
      console.log(`volume deployed ${elapsed}ms after create`);
      expect((await volumes.getInfo({ name: volumeName })).labels).toEqual(labels);

      const listed: VolumeInfo[] = [];
      for await (const volume of volumes.list({ query: volumeName })) listed.push(volume);
      // List omits labels.
      expect(listed.filter((v) => v.name === volumeName).map((v) => v.labels)).toEqual([undefined]);
      labels = { ...E2E_LABELS, step: "update" };
      const updated = await volumes.update({ name: volumeName, labels });
      expect([updated.size, updated.labels]).toEqual(["512Mi", labels]);
      const shrunk = await volumes.update({ name: volumeName, size: 256 }).catch((err) => err);
      expect(shrunk).toBeInstanceOf(SandboxApiError);
      expect((shrunk as SandboxApiError).status).toBe(400);

      const mount = { name: volumeName, mountPath: "/data" };
      sandboxLive = true;
      const sandbox = await client.create({
        name: sandboxName,
        region: E2E_REGION,
        labels: E2E_LABELS,
        volumes: [mount],
      });
      expect(sandbox.info.volumes).toEqual([{ ...mount, readOnly: false }]);
      await waitDeployed(client, sandboxName);
      expect((await volumes.getInfo({ name: volumeName })).attachedTo).toBe(sandboxName);
      await sandbox.fs.write({ path: "/data/written.txt", content: "written" });
      expect(await sandbox.fs.read({ path: "/data/written.txt" })).toBe("written");
      const initial = await volumeMegabytes(sandbox);
      console.log(`df reports ${initial} MB for a 512 MB volume`);

      const mounted = await volumes.delete({ name: volumeName }).catch((err) => err);
      expect(mounted).toBeInstanceOf(SandboxApiError);
      expect((mounted as SandboxApiError).status).toBe(409);

      expect((await volumes.update({ name: volumeName, size: "1Gi" })).size).toBe("1Gi");
      elapsed = await eventually(
        "sandbox sees the grown volume",
        async () => (await volumeMegabytes(sandbox)) > initial,
      );
      console.log(`sandbox saw the grown volume ${elapsed}ms after update`);

      await client.delete({ name: sandboxName });
      sandboxLive = false;
      elapsed = await eventually("volume deletable", deletable);
      volumeLive = false;
      console.log(`volume deletable ${elapsed}ms after sandbox delete`);
      expect(deleted?.status).toBe("DELETING");
    } catch (err) {
      failure = { error: err };
    }
    // The sandbox goes first, since a mounted volume cannot be deleted. A
    // cleanup failure is thrown only when the test itself passed, so it never
    // hides the test's own failure.
    try {
      if (sandboxLive) {
        await client.delete({ name: sandboxName }).catch((err: unknown) => {
          if (!(err instanceof SandboxApiError && err.status === 404)) throw err;
        });
      }
      if (volumeLive) {
        await eventually("volume deletable in cleanup", deletable).catch((err: unknown) => {
          if (!(err instanceof SandboxApiError && err.status === 404)) throw err;
        });
      }
    } catch (cleanupErr) {
      if (failure === undefined) throw cleanupErr;
      console.log(`cleanup of ${volumeName} or ${sandboxName} failed too`, cleanupErr);
    }
    if (failure !== undefined) throw failure.error;
  });
});

// Polls until check passes, within VOLUME_WAIT_MS; any error check throws ends
// the wait. Returns how long it took in milliseconds.
async function eventually(what: string, check: () => Promise<boolean>): Promise<number> {
  const begun = Date.now();
  while (!(await check())) {
    if (Date.now() - begun > VOLUME_WAIT_MS) throw new Error(`${what}: not within 30s`);
    await new Promise((resolve) => setTimeout(resolve, VOLUME_POLL_MS));
  }
  return Date.now() - begun;
}

async function volumeMegabytes(sandbox: Sandbox): Promise<number> {
  const process = await sandbox.process.exec({
    command: "sh -c 'df -m /data | tail -n 1'",
    waitForCompletion: true,
  });
  expect(process.exitCode).toBe(0);
  return Number(process.stdout.trim().split(/\s+/)[1]);
}

// Catches timestamp format and zone mistakes, allowing for clock skew.
function expectWithinRun(since: number, timestamp: Date | undefined): void {
  const skew = 5 * 60_000;
  expect(timestamp).toBeDefined();
  expect(timestamp!.getTime()).toBeGreaterThanOrEqual(since - skew);
  expect(timestamp!.getTime()).toBeLessThanOrEqual(Date.now() + skew);
}
