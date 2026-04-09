# Baseten JS SDK

JS/TS SDK for Baseten.

⚠️ Under active development. Nothing should be considered stable at this time.

## Usage

Current SDK only has barebones client. Here is usage example of the barebones underlying client in TypeScript:

```typescript
import { ManagementClient } from "baseten/client";

const client = new ManagementClient({ apiKey: "my-api-key" });
for (const model of (await client.api.getModels()).models) {
  console.log(model.name);
}
```
