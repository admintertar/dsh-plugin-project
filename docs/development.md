# Development

Use the versions recorded in `upstream.json`. The current target is stable only.

| Command | Purpose |
| --- | --- |
| `yarn install --immutable` | Install the root lockfile dependencies |
| `yarn run setup -- --desktop /path/to/deepseek-harness` | Verify the pinned official checkout and link its built development packages |
| `yarn run typecheck` | Type-check source, tests and TypeScript scripts |
| `yarn run test` | Run the automated suite with temporary project fixtures |
| `node --import tsx --test --test-concurrency=1 tests/*.test.ts` | Run the same suite serially on resource-constrained machines |
| `yarn run build` | Build Host and browser bundles in `lib/` |
| `yarn run check` | Type-check, test and build |
| `yarn start -- /path/to/example.agent-project 43191` | Start an isolated local Web Host |

The official checkout must be at the exact pinned commit, with a clean tracked tree. Run `pnpm install --frozen-lockfile` and `pnpm run build:official` there before setup. Setup checks the commit, release tag, Desktop tree, lockfile blob, package versions and required build outputs, then links the official workspace packages. The checkout must remain available for local Web development. Re-running setup uses the saved source path unless explicitly overridden. This link is a development convenience; package provenance and clean-build closure still require separate verification before release.

Local Web Profiles live under `.dev/projects/<official-commit>/`. The commit segment prevents an older Profile's package links from loading a different DSH version. Existing development data under the previous `.dev/projects/<project-key>/` layout is left untouched.

The examples are fixtures. Copy them outside this repository for interactive changes you intend to keep. The test suite creates temporary files, Git repositories, local HTTP/SSH fixtures and child processes; it does not call a model. macOS is the current acceptance platform. Running the same suite on Windows or Linux is not a substitute for validating native desktop behavior there.

## Optional desktop integration

The current Shell still uses the community Desktop source. `--shell`, desktop launch and compatibility checks cannot be used with it. After the Shell lock and build move to the same official commit, restore those workflows and verify the native behavior separately.

The older `desktop-development.ts`, Electron harnesses and `tests/desktop.integration.ts` remain adapter regression material. They are not the supported native launch workflow or a beta support promise.

## Maintainer boundaries

Before UI work, read the required [frontend guidelines](frontend-guidelines.md) for official component reuse, shared controls, layout, scrolling and native acceptance.

Host logic lives in `src/`, UI composition in `src/client/`, and attributed upstream MCP adaptations in `src/vendor/`. Reuse pinned official primitives, locale, theme and preview components. Keep shared project records separate from machine-local configuration. Never alter a live Profile while preparing dependencies. Read [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) when updating adapted upstream material.
