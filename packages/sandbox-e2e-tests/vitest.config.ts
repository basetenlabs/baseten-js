import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["tests/global-setup.ts"],
    // Files share one sandbox and are quick, so they run one at a time.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
