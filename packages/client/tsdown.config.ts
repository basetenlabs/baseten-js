import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    managementapi: "src/managementapi/index.ts",
    inferenceapi: "src/inferenceapi/index.ts",
    modelconfig: "src/modelconfig/index.ts",
  },
  platform: "neutral",
  dts: true,
});
