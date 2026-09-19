# Validation

Local acceptance baseline: macOS x64, Node.js 22.23.1, Desktop 2.0.11 and
Harness 0.1.5-rc.2 (stable), 2026-09-19.

- Independent `npm ci` and setup from the pinned official Git objects completed.
- TypeScript checks and Host/browser builds passed.
- All 238 automated tests passed using serial file execution.
- An isolated fictional Demo Web project started through the documented Web
  entry point; authenticated project snapshot and browser module loading passed.
- Development Profile staging retains LICENSE, third-party notices and the
  private npm package flag.

The manual resource-authentication fixture performs real Git preflight work;
its polling deadline allows ten seconds on busy machines. Assertions and
production authentication behavior are unchanged.

Tests use generated fixtures and local services without model calls. Windows,
Linux, beta runtime and native desktop UI are not newly certified by this
plugin-only acceptance. Native composition belongs to the companion Shell's
separate checks. No repository or package was published by validation.
