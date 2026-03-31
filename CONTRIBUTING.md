# Contributing

## Setup

```bash
pnpm install
```

## Tasks

- `pnpm run generate-api` - Regenerate API clients and models from OpenAPI specs (pass `--update-specs` to download latest specs first)
- `pnpm run build` - Build the package
- `pnpm run format` - Format code and auto-fix lint issues
- `pnpm run lint` - Check formatting, lint, and type-check
- `pnpm test` - Run tests

## End-to-End Tests

E2e tests in `tests/e2e.test.ts` run against a live Baseten environment. They are skipped automatically when `BASETEN_E2E_TEST_API_KEY` is not set.

To bootstrap the test model, see [baseten-python](https://github.com/basetenlabs/baseten-python)'s contributing guide.

### Running

```bash
BASETEN_E2E_TEST_API_KEY=... \
BASETEN_E2E_TEST_DOMAIN=... \
BASETEN_E2E_TEST_MODEL_ID=... \
    pnpm test
```
