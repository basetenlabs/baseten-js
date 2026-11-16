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

### Authenticating with workload identity federation

Instead of an API key, a workload can exchange its identity provider's token (for example a projected Kubernetes service
account token) for a short-lived Baseten access token under a trust rule. The credentials exchange on first use, cache
the access token, and replace it before it expires:

```typescript
import { ManagementClient, WorkloadIdentityCredentials } from "@basetenlabs/client";

const credentials = new WorkloadIdentityCredentials({
  identityTokenFile: "/var/run/secrets/tokens/baseten",
  trustRuleId: "my-trust-rule-id",
});
const client = new ManagementClient({ credentials });
```

`identityTokenFile` needs Node; elsewhere, pass `identityToken`, a function returning the token.

Generated API types and error classes are available under subpath exports:

```typescript
import { ResponseError } from "@basetenlabs/client/managementapi";
```

The `@basetenlabs/client/inferenceapi` and `@basetenlabs/client/modelconfig` subpaths are exported the same way.
