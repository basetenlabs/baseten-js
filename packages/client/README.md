# @basetenlabs/client

JS/TS SDK for Baseten.

⚠️ Under active development. Nothing should be considered stable at this time.

## Install

```bash
npm install @basetenlabs/client
```

## Usage

```typescript
import { ManagementClient } from "@basetenlabs/client";

const client = new ManagementClient({ apiKey: "my-api-key" });
for (const model of (await client.api.getModels()).models) {
  console.log(model.name);
}
```

Generated API types and error classes are available under subpath exports:

```typescript
import { ResponseError } from "@basetenlabs/client/managementapi";
```

The `@basetenlabs/client/inferenceapi` and `@basetenlabs/client/modelconfig` subpaths are exported the same way.
