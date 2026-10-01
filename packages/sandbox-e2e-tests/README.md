# @basetenlabs/sandbox-e2e-tests

End-to-end tests for `@basetenlabs/sandbox`.

It depends on `@basetenlabs/sandbox` via `workspace:*`, so it imports the package through its published `exports` map and built `dist`, as a consumer who installed it from npm would.

## Running

The packages must be built first so their `dist` exists:

```bash
pnpm --filter @basetenlabs/client --filter @basetenlabs/sandbox build
```

The tests run against a live Baseten environment and are skipped automatically when `BASETEN_E2E_TEST_API_KEY` is not set. The key must be a user's API key in an organization with sandboxes enabled.

```bash
BASETEN_E2E_TEST_API_KEY=... \
BASETEN_E2E_TEST_DOMAIN=... \
    pnpm --filter @basetenlabs/sandbox-e2e-tests test
```

`BASETEN_E2E_TEST_DEBUG=1` prints every request and response, with credentials masked.
