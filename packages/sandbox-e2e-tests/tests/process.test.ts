import {
  type Sandbox,
  SandboxApiError,
  type SandboxProcessExecEvent,
  type SandboxProcessLogLine,
  SandboxProcessWaitTimeoutError,
} from "@basetenlabs/sandbox";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { SHARED_ENVS, e2eEnabled, sandboxClient, uniqueName } from "./harness";

describe.runIf(e2eEnabled())("SandboxProcess", () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await sandboxClient().get({ name: inject("sandboxName") });
  });

  it("runs a command to completion", async () => {
    const process = await sandbox.process.exec({
      command: "sh -c 'echo out; echo err >&2; exit 3'",
      waitForCompletion: true,
    });
    expect(process.exitCode).toBe(3);
    expect(process.stdout.trim()).toBe("out");
    expect(process.stderr.trim()).toBe("err");
    expect(process.completedAt).toBeInstanceOf(Date);
  });

  it("runs in the given working directory", async () => {
    const process = await sandbox.process.exec({
      command: "pwd",
      workingDir: "/tmp",
      waitForCompletion: true,
    });
    expect(process.stdout.trim()).toBe("/tmp");
  });

  it("sees the sandbox's env, secrets included", async () => {
    const process = await sandbox.process.exec({
      command: "sh -c 'echo $E2E_PLAIN; echo $E2E_SECRET'",
      waitForCompletion: true,
    });
    expect(process.stdout.trim().split("\n")).toEqual([
      SHARED_ENVS.E2E_PLAIN.value,
      SHARED_ENVS.E2E_SECRET.value,
    ]);
  });

  it("sees env given to the command", async () => {
    const process = await sandbox.process.exec({
      command: "sh -c 'echo $E2E_EXEC'",
      env: { E2E_EXEC: "exec-value" },
      waitForCompletion: true,
    });
    expect(process.stdout.trim()).toBe("exec-value");
  });

  it("gets, lists, and waits for a background process", async () => {
    const name = uniqueName();
    const started = await sandbox.process.exec({ command: "sh -c 'sleep 1; echo done'", name });
    expect(started.name).toBe(name);
    expect(started.status).toBe("running");

    const got = await sandbox.process.get({ identifier: name });
    expect(got.pid).toBe(started.pid);
    const listed = await sandbox.process.list();
    expect(listed.map((p) => p.name)).toContain(name);

    const finished = await sandbox.process.wait({ identifier: name });
    expect(finished.status).toBe("completed");
    expect(finished.exitCode).toBe(0);
    const logs = await sandbox.process.logs({ identifier: started.pid });
    expect(logs.stdout.trim()).toBe("done");
  });

  it("stops and kills processes", async () => {
    const stopped = uniqueName();
    const killed = uniqueName();
    await sandbox.process.exec({ command: "sleep 300", name: stopped });
    await sandbox.process.exec({ command: "sleep 300", name: killed });
    try {
      await sandbox.process.stop({ identifier: stopped });
      await sandbox.process.kill({ identifier: killed });
      expect((await sandbox.process.wait({ identifier: stopped })).status).toBe("stopped");
      expect((await sandbox.process.wait({ identifier: killed })).status).toBe("killed");
    } finally {
      await killQuietly(sandbox, stopped);
      await killQuietly(sandbox, killed);
    }
  });

  it("writes to and closes stdin", async () => {
    const name = uniqueName();
    const started = await sandbox.process.exec({ command: "cat", name, stdin: true });
    expect(started.stdin).toBe(true);
    try {
      await sandbox.process.writeStdin({ identifier: name, data: "hello\n" });
      await sandbox.process.writeStdin({
        identifier: name,
        data: new TextEncoder().encode("bytes\n"),
      });
      await sandbox.process.closeStdin({ identifier: name });
      const finished = await sandbox.process.wait({ identifier: name });
      expect(finished.status).toBe("completed");
      expect(finished.stdout).toBe("hello\nbytes\n");
    } finally {
      await killQuietly(sandbox, name);
    }
  });

  it("fails to write stdin to a process without it", async () => {
    const name = uniqueName();
    await sandbox.process.exec({ command: "sleep 300", name });
    try {
      const err = await sandbox.process
        .writeStdin({ identifier: name, data: "hello\n" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SandboxApiError);
      expect((err as SandboxApiError).status).toBe(409);
    } finally {
      await killQuietly(sandbox, name);
    }
  });

  it("streams a running process's output", async () => {
    const name = uniqueName();
    await sandbox.process.exec({
      command: "sh -c 'sleep 1; echo a; echo b >&2; echo c'",
      name,
    });
    const lines: SandboxProcessLogLine[] = [];
    for await (const line of sandbox.process.streamLogs({ identifier: name })) lines.push(line);
    // Order holds within each stream, not between them.
    expect(lines.filter((l) => l.stream === "stdout").map((l) => l.text)).toEqual(["a", "c"]);
    expect(lines.filter((l) => l.stream === "stderr").map((l) => l.text)).toEqual(["b"]);
    expect(lines).toHaveLength(3);
  });

  it("streams a finished process's output from the start", async () => {
    const name = uniqueName();
    await sandbox.process.exec({ command: "sh -c 'echo a; echo b'", name });
    await sandbox.process.wait({ identifier: name });
    const lines: SandboxProcessLogLine[] = [];
    for await (const line of sandbox.process.streamLogs({ identifier: name })) lines.push(line);
    expect(lines).toEqual([
      { stream: "stdout", text: "a" },
      { stream: "stdout", text: "b" },
    ]);
  });

  it("streams an exec's output and then its exit", async () => {
    const events: SandboxProcessExecEvent[] = [];
    for await (const event of sandbox.process.execStream({
      command: "sh -c 'printf \"a\\n\\nb\\n\"; echo e >&2; exit 2'",
    })) {
      events.push(event);
    }
    const exit = events.at(-1);
    expect(exit?.type).toBe("exit");
    expect(exit?.type === "exit" && exit.process.exitCode).toBe(2);
    // Chunks follow the process's writes, so only what they join to is fixed.
    const joined = (stream: string) =>
      events.map((e) => (e.type === "output" && e.stream === stream ? e.text : "")).join("");
    expect(joined("stdout")).toBe("a\n\nb\n");
    expect(joined("stderr")).toBe("e\n");
  });

  it("streams an exec's prompt before it has a newline", async () => {
    const name = uniqueName();
    let stdout = "";
    try {
      for await (const event of sandbox.process.execStream({
        command: 'sh -c \'printf "Continue? "; read answer; echo "got $answer"\'',
        name,
        stdin: true,
      })) {
        if (event.type === "exit") {
          expect(event.process.exitCode).toBe(0);
          break;
        }
        if (event.stream !== "stdout") continue;
        stdout += event.text;
        // The process blocks on the read, so this only happens if the prompt
        // arrived without its line being finished.
        if (stdout === "Continue? ") {
          await sandbox.process.writeStdin({ identifier: name, data: "yes\n" });
        }
      }
      expect(stdout).toBe("Continue? got yes\n");
    } finally {
      await killQuietly(sandbox, name);
    }
  });

  it("times out a wait without stopping the process", async () => {
    const name = uniqueName();
    await sandbox.process.exec({ command: "sleep 300", name });
    try {
      await expect(
        sandbox.process.wait({ identifier: name, timeoutMs: 1000 }),
      ).rejects.toBeInstanceOf(SandboxProcessWaitTimeoutError);
      expect((await sandbox.process.get({ identifier: name })).status).toBe("running");
    } finally {
      await killQuietly(sandbox, name);
    }
  });

  it("fails to get an unknown process", async () => {
    const err = await sandbox.process.get({ identifier: uniqueName() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxApiError);
    expect((err as SandboxApiError).status).toBe(404);
  });
});

// Kills a process the test may already have ended, so cleanup never masks
// the test's own failure.
async function killQuietly(sandbox: Sandbox, identifier: string): Promise<void> {
  await sandbox.process.kill({ identifier }).catch(() => {});
}
