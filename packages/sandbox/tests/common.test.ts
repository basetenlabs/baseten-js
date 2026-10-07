import { describe, expect, it } from "vitest";
import { formatDuration, Limiter, parseDuration, parseTimestamp } from "../src/common";

// A task that runs until finish is called, noting when it started.
function heldTask(name: string, started: string[]) {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  return {
    run: async () => {
      started.push(name);
      await finished;
      return name;
    },
    finish: () => finish(),
  };
}

describe("Limiter", () => {
  it("runs at most its limit at once, the rest in order of arrival", async () => {
    const limiter = new Limiter(2);
    const started: string[] = [];
    const tasks = ["a", "b", "c", "d"].map((name) => heldTask(name, started));
    const results = tasks.map((task) => limiter.run(undefined, task.run));
    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    tasks[1]!.finish();
    await results[1];
    expect(started).toEqual(["a", "b", "c"]);
    tasks[0]!.finish();
    await results[0];
    expect(started).toEqual(["a", "b", "c", "d"]);
    tasks[2]!.finish();
    tasks[3]!.finish();
    expect(await Promise.all(results)).toEqual(["a", "b", "c", "d"]);
  });

  it("frees the slot of a task that fails", async () => {
    const limiter = new Limiter(1);
    await expect(limiter.run(undefined, () => Promise.reject(new Error("failed")))).rejects.toThrow(
      "failed",
    );
    expect(await limiter.run(undefined, async () => "next")).toBe("next");
  });

  it("stops a waiting task when its signal aborts, without taking a slot", async () => {
    const limiter = new Limiter(1);
    const started: string[] = [];
    const first = heldTask("first", started);
    const firstResult = limiter.run(undefined, first.run);
    const controller = new AbortController();
    const aborted = limiter.run(controller.signal, heldTask("aborted", started).run);
    const last = limiter.run(undefined, async () => "last");
    controller.abort(new Error("stopped"));
    await expect(aborted).rejects.toThrow("stopped");
    first.finish();
    expect(await firstResult).toBe("first");
    expect(await last).toBe("last");
    expect(started).toEqual(["first"]);
  });

  it("does not run a task whose signal already aborted", async () => {
    const limiter = new Limiter(1);
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    let ran = false;
    await expect(
      limiter.run(controller.signal, async () => {
        ran = true;
      }),
    ).rejects.toThrow("stopped");
    expect(ran).toBe(false);
  });
});

describe("parseDuration", () => {
  it.each([
    ["0", 0],
    ["+0", 0],
    ["-0", 0],
    ["1ns", 1e-6],
    ["1us", 1e-3],
    ["1µs", 1e-3],
    ["1μs", 1e-3],
    ["1ms", 1],
    ["1s", 1000],
    ["1m", 60_000],
    ["1h", 3_600_000],
    ["1d", 86_400_000],
    ["1w", 604_800_000],
    ["0s", 0],
    ["0d", 0],
    ["24h", 86_400_000],
    ["7d", 604_800_000],
    ["2w", 1_209_600_000],
    ["30m", 1_800_000],
    ["90m", 5_400_000],
    ["1h30m", 5_400_000],
    ["1h30m0s", 5_400_000],
    ["2h45m30s", 9_930_000],
    ["1m1ms", 60_001],
    ["1ms1s", 1001],
    ["1s1s", 2000],
    ["1.5s", 1500],
    ["1.5h", 5_400_000],
    [".5s", 500],
    ["5.s", 5000],
    ["0.25ms", 0.25],
    ["1500ms", 1500],
    ["007s", 7000],
    ["1000000h", 3_600_000_000_000],
    ["+5m", 300_000],
    ["-5m", -300_000],
    ["-1h30m", -5_400_000],
    ["-7d", -604_800_000],
  ])("parses %s", (value, ms) => {
    expect(parseDuration(value, "test")).toBeCloseTo(ms, 9);
  });

  it.each([
    "",
    "+",
    "-",
    "1",
    "10",
    "s",
    "1x",
    "1 s",
    " 1s",
    "1s ",
    "1S",
    "1H",
    "1sec",
    "1min",
    "1hr",
    "1day",
    "1d12h",
    "12h1d",
    "1w1d",
    "1.5d",
    "1.5w",
    ".d",
    "--1s",
    "+-1s",
    "1s-1s",
    "1e3s",
    "1,5s",
    ".s",
    "1..5s",
    "00",
    "P1D",
    "PT1H",
  ])("rejects %j", (value) => {
    expect(() => parseDuration(value, "test value")).toThrow(
      `test value is not a valid duration: ${JSON.stringify(value)}`,
    );
  });

  it("names the value in errors", () => {
    expect(() => parseDuration("soon", "lifecycle terminated retention")).toThrow(
      'lifecycle terminated retention is not a valid duration: "soon"',
    );
  });
});

describe("parseTimestamp", () => {
  // Each format the exec plane has been seen to send.
  it.each(["2026-09-30T10:00:00Z", "Wed, 30 Sep 2026 10:00:00 GMT", "2026-09-30 10:00:00+00:00"])(
    "parses %s",
    (value) => {
      expect(parseTimestamp(value, "startedAt")).toEqual(new Date("2026-09-30T10:00:00Z"));
    },
  );

  it("names the value in errors", () => {
    expect(() => parseTimestamp("yesterday", "process startedAt")).toThrow(
      'process startedAt is not a valid timestamp: "yesterday"',
    );
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [1, "1ms"],
    [1500, "1500ms"],
    [604_800_000, "604800000ms"],
    [0.4, "0ms"],
    [0.5, "1ms"],
    [1.6, "2ms"],
    [-300_000, "-300000ms"],
  ])("formats %d", (ms, value) => {
    expect(formatDuration(ms)).toBe(value);
  });

  it.each([0, 1, 1500, 5_400_000, 604_800_000])("round-trips %d", (ms) => {
    expect(parseDuration(formatDuration(ms), "test")).toBe(ms);
  });
});
