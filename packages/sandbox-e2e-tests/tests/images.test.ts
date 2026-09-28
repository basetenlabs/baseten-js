import { ImageBuilder, SandboxApiError, type SandboxClient } from "@basetenlabs/sandbox";
import { describe, expect, it } from "vitest";
import { E2E_LABELS, e2eEnabled, sandboxClient, uniqueName, waitDeployed } from "./harness";

// Every push starts a build on the server, and this suite runs on every CI
// push, so the whole file pushes exactly one image and keeps its build small.
describe.runIf(e2eEnabled())("ImageClient", () => {
  it(
    "pushes a build context and creates a sandbox from it",
    async () => {
      const client = sandboxClient();
      const imageName = uniqueName();
      const sandboxName = uniqueName();
      let sandboxCreated = false;
      let failure: { error: unknown } | undefined;
      try {
        // A pullable base, since the default sandbox image name only resolves
        // on sandbox create, not in a build. The builder adds the sandbox API
        // binary and entrypoint itself.
        const builder = ImageBuilder.fromRegistry("debian:bookworm-slim")
          .addFile("/hello.txt", "hello from the image")
          .runCommands("echo built by RUN > /run.txt");
        expect(builder.dockerfile()).toMatch(
          /\nCOPY --from=ghcr\.io\/blaxel-ai\/sandbox:latest \/sandbox-api \/usr\/local\/bin\/sandbox-api\nENTRYPOINT \["\/usr\/local\/bin\/sandbox-api"\]\n$/,
        );
        const pushed = await client.images.push({ name: imageName, builder });
        expect(pushed.name).toBe(imageName);
        expect(pushed.status).toBe("BUILT");

        expect((await client.images.getInfo({ name: imageName })).status).toBe("BUILT");
        const listed = [];
        for await (const image of client.images.list({ namePrefix: imageName })) {
          listed.push(image.name);
        }
        expect(listed).toEqual([imageName]);
        const tags = [];
        for await (const tag of client.images.listTags({ name: imageName })) tags.push(tag.name);
        expect(tags.length).toBeGreaterThan(0);

        sandboxCreated = true;
        await client.create({
          name: sandboxName,
          image: `${imageName}:latest`,
          // TODO: Same temporary region pin as the shared sandbox.
          region: "us-was-1",
          labels: E2E_LABELS,
        });
        await waitDeployed(client, sandboxName);
        const sandbox = await client.get({ name: sandboxName });
        expect(await sandbox.fs.read({ path: "/hello.txt" })).toBe("hello from the image");
        expect(await sandbox.fs.read({ path: "/run.txt" })).toBe("built by RUN\n");
        // The injected binary is where the copy put it, and runs as the
        // entrypoint, which is what answers these calls at all.
        const binary = await sandbox.process.exec({
          command: "test -x /usr/local/bin/sandbox-api",
          waitForCompletion: true,
        });
        expect(binary.exitCode).toBe(0);
        const entrypoint = await sandbox.process.exec({
          command: "tr '\\0' ' ' < /proc/1/cmdline",
          waitForCompletion: true,
        });
        expect(entrypoint.stdout).toMatch(/^\/usr\/local\/bin\/sandbox-api\b/);
      } catch (err) {
        failure = { error: err };
      }
      // A cleanup failure is thrown only when the test itself passed, so it
      // never hides the test's own failure.
      try {
        // The image cannot be deleted while a sandbox uses it.
        if (sandboxCreated) await deleteSandboxAndWait(client, sandboxName);
        await client.images.delete({ name: imageName }).catch((err: unknown) => {
          if (!(err instanceof SandboxApiError && err.status === 404)) throw err;
        });
      } catch (cleanupErr) {
        if (failure === undefined) throw cleanupErr;
        console.log(`cleanup of ${imageName} or ${sandboxName} failed too`, cleanupErr);
      }
      if (failure !== undefined) throw failure.error;
    },
    15 * 60_000,
  );
});

async function deleteSandboxAndWait(client: SandboxClient, name: string): Promise<void> {
  try {
    await client.delete({ name });
  } catch (err) {
    if (err instanceof SandboxApiError && err.status === 404) return;
    throw err;
  }
  const deadline = Date.now() + 120_000;
  for (;;) {
    let status: string;
    try {
      status = (await client.getInfo({ name })).status;
    } catch (err) {
      if (err instanceof SandboxApiError && err.status === 404) return;
      throw err;
    }
    // A deleted sandbox stays listed as TERMINATED rather than disappearing.
    if (status === "TERMINATED") return;
    if (Date.now() > deadline) throw new Error(`sandbox ${name} is still ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
