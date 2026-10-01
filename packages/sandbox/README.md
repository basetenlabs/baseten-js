# @basetenlabs/sandbox

JS/TS SDK for Baseten sandboxes.

⚠️ Under active development. Nothing should be considered stable at this time.

## Install

```bash
npm install @basetenlabs/sandbox
```

On Node, also install `undici`, which is strongly recommended. Before Node 26 it enables HTTP/2, and on every version it speeds up large downloads:

```bash
npm install undici
```

## Usage

```typescript
import { SandboxClient } from "@basetenlabs/sandbox";

const client = new SandboxClient({ apiKey: "my-api-key" });
const sandbox = await client.create();
try {
  await sandbox.fs.write({ path: "/tmp/hello.txt", content: "hello" });
  const result = await sandbox.process.exec({
    command: "cat /tmp/hello.txt",
    waitForCompletion: true,
  });
  console.log(result.stdout);
} finally {
  await client.delete({ name: sandbox.name });
}
```

Operations the SDK does not wrap are available on the generated clients, through `client.rawApi` for the control plane and `sandbox.rawApi` for a sandbox.
