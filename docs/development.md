# Development

Use the versions recorded in `upstream.json`. The current target is stable only.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the root lockfile dependencies |
| `npm run setup -- --desktop /path/to/official-source` | Export the pinned official runtime and install matching development packages |
| `npm run typecheck` | Type-check source, tests and TypeScript scripts |
| `npm test` | Run the automated suite with temporary project fixtures |
| `node --import tsx --test --test-concurrency=1 tests/*.test.ts` | Run the same suite serially on resource-constrained machines |
| `npm run build` | Build Host and browser bundles in `lib/` |
| `npm run check` | Type-check, test and build |
| `npm start -- /path/to/example.agent-project 43191` | Start an isolated local Web Host |

The official Git source cache only needs to contain the exact pinned commit; checkout is unnecessary. Setup does not use that cache's working tree. Tarballs, installed dependencies and per-project profiles stay in `.dev/`. After setup and build, the Web Host does not need the source cache. Re-running setup uses the saved source location unless explicitly overridden. This development graph is resolved from pinned first-party archives; generated transitive runtime dependencies are not a separately committed release lock.

The examples are fixtures. Copy them outside this repository for interactive changes you intend to keep. The test suite creates temporary files, Git repositories, local HTTP/SSH fixtures and child processes; it does not call a model. macOS is the current acceptance platform. Running the same suite on Windows or Linux is not a substitute for validating native desktop behavior there.

## Optional desktop integration

`npm run setup -- --shell /path/to/dsh-project-desktop` reads a prepared Shell's verified immutable sources. `npm run test:compatibility -- /path/to/dsh-project-desktop` validates current plugin source and runs the Shell's checks. The Shell still uses its own pinned plugin snapshot: update its lock explicitly when adopting plugin changes. `npm run desktop -- --shell /path/to/dsh-project-desktop` starts that Shell, not a mutable copy of the current plugin.

The older `desktop-development.ts`, Electron harnesses and `tests/desktop.integration.ts` remain adapter regression material. They are not the supported native launch workflow or a beta support promise.

## Maintainer boundaries

Host logic lives in `src/`, UI composition in `src/client/`, and attributed upstream MCP adaptations in `src/vendor/`. Reuse pinned official primitives, locale, theme and preview components. Keep shared project records separate from machine-local configuration. Never alter a live Profile while preparing dependencies. Read [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) when updating adapted upstream material.
