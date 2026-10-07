import { describe, expect, it } from "vitest";
import { defaultImageIgnoreFile } from "../../src/index";

describe("defaultImageIgnoreFile", () => {
  const cases: [string, boolean][] = [
    [".git", true],
    [".git/config", true],
    ["app/node_modules", true],
    ["app/node_modules/x/y.js", true],
    ["a/b/__pycache__", true],
    ["dist", true],
    ["src/dist", true],
    [".env", true],
    ["app/.env", true],
    [".env.local", true],
    [".envrc", true],
    [".blaxel", true],
    [".env.build", true],
    ["app/.env.build", true],
    // .env* matches at the root only.
    ["app/.env.local", false],
    ["distribution", false],
    ["main.py", false],
    ["src/app.ts", false],
    ["Dockerfile", false],
    ["git", false],
  ];
  for (const [relPath, ignored] of cases) {
    it(`${ignored ? "ignores" : "keeps"} ${relPath}`, () => {
      expect(defaultImageIgnoreFile({ relPath, isDirectory: false })).toBe(ignored);
    });
  }
});
