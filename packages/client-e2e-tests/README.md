# @basetenlabs/client-e2e-tests

End-to-end tests for `@basetenlabs/client`.

It depends on `@basetenlabs/client` via `workspace:*`, so it imports the client through its published `exports` map and built `dist` — exactly as a consumer who installed it from npm would. This validates that the package's public entry points resolve correctly, in addition to exercising a live Baseten environment.

## Running

The client must be built first so its `dist` exists:

```bash
pnpm --filter @basetenlabs/client build
```

The tests run against a live Baseten environment and are skipped automatically when `BASETEN_E2E_TEST_API_KEY` is not set:

```bash
BASETEN_E2E_TEST_API_KEY=... \
BASETEN_E2E_TEST_DOMAIN=... \
BASETEN_E2E_TEST_MODEL_ID=... \
    pnpm --filter @basetenlabs/client-e2e-tests test
```

To bootstrap the test model, see [baseten-python](https://github.com/basetenlabs/baseten-python)'s contributing guide.
