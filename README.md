# Baseten JS SDK

[![npm](https://img.shields.io/npm/v/@basetenlabs/client.svg)](https://www.npmjs.com/package/@basetenlabs/client)

JS/TS SDK for Baseten.

⚠️ SDK may change in incompatible ways between releases until the SDK reaches 1.0.

## Install

```bash
npm install @basetenlabs/client
```

## Usage

Current SDK only has barebones client. Here is usage example of the barebones underlying client in TypeScript:

```typescript
import { ManagementClient } from "@basetenlabs/client";

const client = new ManagementClient({ apiKey: "my-api-key" });
for (const model of (await client.api.getModels()).models) {
  console.log(model.name);
}
```

## Packages

- [`@basetenlabs/client`](packages/client) — the Baseten JS/TS SDK.
