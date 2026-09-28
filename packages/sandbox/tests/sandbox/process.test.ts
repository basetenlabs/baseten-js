import { describe, expect, it } from "vitest";
import {
  Sandbox,
  SandboxApiError,
  SandboxGatewayError,
  SandboxProcessWaitTimeoutError,
} from "../../src/index";

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: Uint8Array;
}

// A sandbox whose every request goes to route, recorded first.
function fakeSandbox(route: (request: Recorded, index: number) => Response) {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const recorded: Recorded = {
      method: request.method,
      path: new URL(request.url).pathname,
      headers: request.headers,
      body: new Uint8Array(await request.arrayBuffer()),
    };
    requests.push(recorded);
    return route(recorded, requests.length - 1);
  };
  const sandbox = new Sandbox({
    name: "sbx",
    url: "https://sbx.example",
    tokenProvider: async () => "token",
    fetch: fetchImpl as typeof fetch,
  });
  return { sandbox, requests };
}

function jsonBody(request: Recorded): unknown {
  return JSON.parse(new TextDecoder().decode(request.body));
}

function apiProcess(extra: Record<string, unknown> = {}) {
  return {
    pid: "123",
    name: "proc",
    command: "echo hi",
    status: "running",
    exitCode: 0,
    stdout: "",
    stderr: "",
    logs: "",
    workingDir: "",
    startedAt: "2026-09-30T10:00:00Z",
    completedAt: "",
    ...extra,
  };
}

// A streamed body sending each chunk as is, noting whether it was cancelled.
function streamed(chunks: string[]): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body), cancelled: () => cancelled };
}

function gateway(): Response {
  return new Response("bad gateway", { status: 502 });
}

describe("SandboxProcess", () => {
  it("execs with every field mapped", async () => {
    const { sandbox, requests } = fakeSandbox(() =>
      Response.json(
        apiProcess({
          status: "completed",
          exitCode: 2,
          stdout: "out",
          stderr: "err",
          logs: "outerr",
          workingDir: "/work",
          completedAt: "2026-09-30T10:00:05Z",
          keepAlive: true,
          maxRestarts: 3,
          restartCount: 1,
          restartOnFailure: true,
          stdin: true,
        }),
      ),
    );
    const info = await sandbox.process.exec({
      command: "echo hi",
      workingDir: "/work",
      env: { A: "1" },
      name: "proc",
      // Rounded up to whole seconds on the wire.
      timeoutMs: 29_500,
      keepAlive: true,
      restartOnFailure: true,
      maxRestarts: 3,
      stdin: true,
      waitForPorts: [3000],
      waitForCompletion: true,
    });
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.path).toBe("/process");
    expect(jsonBody(requests[0]!)).toEqual({
      command: "echo hi",
      workingDir: "/work",
      env: { A: "1" },
      name: "proc",
      timeout: 30,
      keepAlive: true,
      restartOnFailure: true,
      maxRestarts: 3,
      stdin: true,
      waitForPorts: [3000],
      waitForCompletion: true,
    });
    expect(info).toEqual({
      pid: "123",
      name: "proc",
      command: "echo hi",
      status: "completed",
      exitCode: 2,
      stdout: "out",
      stderr: "err",
      logs: "outerr",
      workingDir: "/work",
      startedAt: new Date("2026-09-30T10:00:00Z"),
      completedAt: new Date("2026-09-30T10:00:05Z"),
      keepAlive: true,
      maxRestarts: 3,
      restartCount: 1,
      restartOnFailure: true,
      stdin: true,
    });
  });

  it("execs with only the command sent when nothing else is set", async () => {
    const { sandbox, requests } = fakeSandbox(() => Response.json(apiProcess()));
    const info = await sandbox.process.exec({ command: "echo hi" });
    expect(jsonBody(requests[0]!)).toEqual({ command: "echo hi" });
    expect(info.completedAt).toBeUndefined();
  });

  it("leaves completedAt unset when it comes back null", async () => {
    const { sandbox } = fakeSandbox(() => Response.json(apiProcess({ completedAt: null })));
    const info = await sandbox.process.exec({ command: "sleep 1" });
    expect(info.completedAt).toBeUndefined();
  });

  it("does not retry exec on a gateway error", async () => {
    const { sandbox, requests } = fakeSandbox(gateway);
    await expect(sandbox.process.exec({ command: "true" })).rejects.toBeInstanceOf(
      SandboxGatewayError,
    );
    expect(requests).toHaveLength(1);
  });

  it("gets a process by identifier, retrying a gateway error", async () => {
    const { sandbox, requests } = fakeSandbox((_, index) =>
      index === 0 ? gateway() : Response.json(apiProcess()),
    );
    const info = await sandbox.process.get({ identifier: "my proc" });
    expect(info.pid).toBe("123");
    expect(requests.map((r) => r.path)).toEqual(["/process/my%20proc", "/process/my%20proc"]);
  });

  it("lists processes", async () => {
    const { sandbox, requests } = fakeSandbox(() =>
      Response.json([apiProcess({ pid: "1" }), apiProcess({ pid: "2" })]),
    );
    const processes = await sandbox.process.list();
    expect(processes.map((p) => p.pid)).toEqual(["1", "2"]);
    expect(requests[0]!.path).toBe("/process");
  });

  it("stops and kills without retrying", async () => {
    const { sandbox, requests } = fakeSandbox(gateway);
    await expect(sandbox.process.stop({ identifier: "p" })).rejects.toBeInstanceOf(
      SandboxGatewayError,
    );
    await expect(sandbox.process.kill({ identifier: "p" })).rejects.toBeInstanceOf(
      SandboxGatewayError,
    );
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "DELETE /process/p",
      "DELETE /process/p/kill",
    ]);
  });

  it("gets logs", async () => {
    const { sandbox, requests } = fakeSandbox(() =>
      Response.json({ stdout: "o", stderr: "e", logs: "oe" }),
    );
    expect(await sandbox.process.logs({ identifier: "p" })).toEqual({
      stdout: "o",
      stderr: "e",
      logs: "oe",
    });
    expect(requests[0]!.path).toBe("/process/p/logs");
  });

  it("writes stdin verbatim without retrying", async () => {
    const { sandbox, requests } = fakeSandbox((_, index) =>
      index < 2 ? Response.json({ message: "ok" }) : gateway(),
    );
    await sandbox.process.writeStdin({ identifier: "p", data: "héllo\n" });
    await sandbox.process.writeStdin({ identifier: "p", data: new Uint8Array([0, 255]) });
    await expect(
      sandbox.process.writeStdin({ identifier: "p", data: "again" }),
    ).rejects.toBeInstanceOf(SandboxGatewayError);
    expect(requests).toHaveLength(3);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.path).toBe("/process/p/stdin");
    expect(requests[0]!.headers.get("content-type")).toBe("application/octet-stream");
    expect(requests[0]!.body).toEqual(new TextEncoder().encode("héllo\n"));
    expect(requests[1]!.body).toEqual(new Uint8Array([0, 255]));
  });

  it("closes stdin, retrying a gateway error", async () => {
    const { sandbox, requests } = fakeSandbox((_, index) =>
      index === 0 ? gateway() : Response.json({ message: "ok" }),
    );
    await sandbox.process.closeStdin({ identifier: "p" });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "DELETE /process/p/stdin",
      "DELETE /process/p/stdin",
    ]);
  });

  it("streams log lines, split across chunks", async () => {
    const { response } = streamed([
      "stdout:hel",
      "lo\r\n[keepalive]\nstderr:oops\n",
      "plain\nstdout:",
      "\nstdout:last",
    ]);
    const { sandbox, requests } = fakeSandbox(() => response);
    const lines = [];
    for await (const line of sandbox.process.streamLogs({ identifier: "p" })) lines.push(line);
    expect(lines).toEqual([
      { stream: "stdout", text: "hello" },
      { stream: "stderr", text: "oops" },
      { text: "plain" },
      { stream: "stdout", text: "" },
      { stream: "stdout", text: "last" },
    ]);
    expect(requests[0]!.path).toBe("/process/p/logs/stream");
  });

  it("cancels the log stream when iteration ends early", async () => {
    const { response, cancelled } = streamed(["stdout:a\n", "stdout:b\n", "stdout:c\n"]);
    const { sandbox } = fakeSandbox(() => response);
    for await (const line of sandbox.process.streamLogs({ identifier: "p" })) {
      expect(line.text).toBe("a");
      break;
    }
    expect(cancelled()).toBe(true);
  });

  it("fails a log stream for a missing process", async () => {
    const { sandbox } = fakeSandbox(() => new Response("not found", { status: 404 }));
    const lines = sandbox.process.streamLogs({ identifier: "p" });
    await expect(lines.next()).rejects.toMatchObject({ status: 404 });
  });

  it("streams an exec's output chunks as written and then its exit", async () => {
    const result = JSON.stringify(apiProcess({ status: "completed", exitCode: 0 }));
    // Split mid-record, to check records are rejoined before parsing.
    const records = [
      `${JSON.stringify({ type: "stdout", data: "a\n\nb\n" })}\n`,
      `${JSON.stringify({ type: "stdout", data: "Continue? " })}\n`,
      `${JSON.stringify({ type: "stderr", data: "" })}\n`,
      `${JSON.stringify({ type: "result", data: result })}\n`,
    ].join("");
    const { response } = streamed([records.slice(0, 10), records.slice(10)]);
    const { sandbox, requests } = fakeSandbox(() => response);
    const events = [];
    for await (const event of sandbox.process.execStream({ command: "echo hi" })) {
      events.push(event);
    }
    expect(requests[0]!.headers.get("accept")).toBe("text/event-stream");
    expect(jsonBody(requests[0]!)).toEqual({ command: "echo hi", waitForCompletion: true });
    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({ type: "output", stream: "stdout", text: "a\n\nb\n" });
    expect(events[1]).toEqual({ type: "output", stream: "stdout", text: "Continue? " });
    expect(events[2]).toEqual({ type: "output", stream: "stderr", text: "" });
    expect(events[3]).toMatchObject({ type: "exit", process: { status: "completed" } });
  });

  it("fails an exec stream that ends without an exit", async () => {
    const { response } = streamed([`${JSON.stringify({ type: "stdout", data: "hi" })}\n`]);
    const { sandbox } = fakeSandbox(() => response);
    const events = sandbox.process.execStream({ command: "echo hi" });
    expect((await events.next()).value).toMatchObject({ type: "output" });
    await expect(events.next()).rejects.toThrow(/before reporting the process's exit/);
  });

  it("waits through running and retryable errors to a finished process", async () => {
    const replies = [
      () => Response.json(apiProcess()),
      () => new Response("busy", { status: 500 }),
      gateway,
      () => Response.json(apiProcess({ status: "failed", exitCode: 1 })),
    ];
    const { sandbox, requests } = fakeSandbox((_, index) => replies[index]!());
    const info = await sandbox.process.wait({ identifier: "p", pollIntervalMs: 1 });
    expect(info.status).toBe("failed");
    expect(info.exitCode).toBe(1);
    expect(requests).toHaveLength(4);
  });

  it("fails a wait on an unknown status", async () => {
    const { sandbox } = fakeSandbox(() => Response.json(apiProcess({ status: "paused" })));
    await expect(sandbox.process.wait({ identifier: "p" })).rejects.toThrow(
      /unknown status paused/,
    );
  });

  it("fails a wait at once on an error that is not retryable", async () => {
    const { sandbox, requests } = fakeSandbox(() => new Response("gone", { status: 404 }));
    const err = await sandbox.process.wait({ identifier: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxApiError);
    expect((err as SandboxApiError).status).toBe(404);
    expect(requests).toHaveLength(1);
  });

  it("times out a wait, with the last error as its cause", async () => {
    const { sandbox } = fakeSandbox(gateway);
    const err = await sandbox.process
      .wait({ identifier: "p", timeoutMs: 50, pollIntervalMs: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxProcessWaitTimeoutError);
    expect((err as SandboxProcessWaitTimeoutError).identifier).toBe("p");
    expect((err as Error).cause).toBeInstanceOf(SandboxGatewayError);
  });

  it("rethrows the caller's abort rather than a timeout", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped by caller");
    const { sandbox } = fakeSandbox(() => {
      controller.abort(reason);
      return Response.json(apiProcess());
    });
    await expect(
      sandbox.process.wait({
        identifier: "p",
        timeoutMs: Infinity,
        callOptions: { signal: controller.signal },
      }),
    ).rejects.toBe(reason);
  });
});
