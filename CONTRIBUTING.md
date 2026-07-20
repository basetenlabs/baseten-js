# Contributing

## Setup

```bash
pnpm install
```

## Tasks

Run from the repo root:

- `pnpm run generate-api` - Regenerate API clients and models from OpenAPI specs (pass `--update-specs` to download latest specs first)
- `pnpm run build` - Build all packages
- `pnpm run format` - Format code and auto-fix lint issues
- `pnpm run lint` - Check formatting, lint, and type-check
- `pnpm test` - Run tests

`lint` and `test` cover the e2e package, which type-checks and runs against the built `dist`, so run `pnpm run build` first.

## End-to-end tests

See [packages/client-e2e-tests](packages/client-e2e-tests/README.md).

## Releasing

Bump the `version` in the package's `package.json`, then create a GitHub release. The [release workflow](.github/workflows/release.yml) builds and publishes each public package to npm via npm trusted publishing (OIDC).

The first publish of a new package must be done once manually (`pnpm --filter <pkg> publish --access public`), after which a trusted publisher can be configured on npmjs.com for tokenless releases.
