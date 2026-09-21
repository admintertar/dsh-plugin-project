# dsh-plugin-project

English · [简体中文](README.md)

Project-scoped resources, tasks, memory, skills and MCP services for DeepSeek Harness.
Organize several independent repositories in one project, give the agent the current resource locations and registered knowledge, and keep tasks and deliverables with the project.

This repository owns the in-project features. The companion **dsh-project-desktop** owns desktop windows, project creation, native menus and recovery. Official Desktop sources remain unchanged.

## Features

- **Resources:** link local directories or Git repositories; clone asynchronously with authentication, cancellation, remote status and synchronization.
- **Tasks:** session-independent records, acceptance criteria, handoffs, Git commit references and document previews.
- **Memory:** maintain knowledge in the root `memory/` directory; only registered documents enter the project context.
- **Skills and MCP:** project-level declarations and enablement, with machine paths, environment values and headers stored separately.
- **Project sessions:** scope session lists, search and context to the project root while reusing official chat and UI components.

## Compatibility and status

Early development; only the `stable` channel is supported: Desktop **2.0.11** and Harness **0.1.5-rc.2**. Exact revisions are in [upstream.json](upstream.json). Stable names a release channel, not a long-term API guarantee. Beta is outside the current support scope.

This independently maintained project is not an official DeepSeek or Anywhere Labs product. Original project code currently has **no open-source license grant**.

## Local development

Requires Node.js `^22.19.0 || >=24.0.0`, Corepack, Git and tar. Run from this repository:

```sh
yarn install --immutable
git clone --filter=blob:none --no-checkout https://github.com/anywhere-labs/dsh-desktop.git ../dsh-desktop-source
yarn run setup -- --desktop ../dsh-desktop-source
yarn run check
yarn start
```

Setup reads the pinned official Git commit, verifies stable metadata and runtime archive SHA-256 checksums, and installs isolated dependencies under `.dev/`. It does not build or launch the official desktop app or use uncommitted source changes. Run setup after `yarn install --immutable` to obtain the complete matching official development types.

Start defaults to the fictional `examples/demo-web` project and prints the local Web development URL. To select a project and port:

```sh
yarn start -- /path/to/example/example.agent-project 43191
```

Configure a model provider through the official settings UI when needed. Tests need no model credentials and make no model calls. Development profiles and dependencies stay in ignored `.dev/`; keep personal configuration out of examples.

## Project layout

```text
example/
├── example.agent-project       # Project definition (YAML)
├── resources/                  # Default location for independent resources
├── memory/                     # Registered long-term knowledge
├── tasks/<task>/               # One directory per task
│   ├── task.md                 # Task record, v3
│   └── artifacts/              # Task deliverables
├── skills/                     # Project skills and enablement index
├── mcp/servers.yaml            # Shared MCP declarations
└── .agent-project/             # Program data; share portable files, ignore local state
```

See [project layout](docs/project-layout.md). Both [examples](examples/) are fictional and contain no real services or remote credentials.

## Desktop integration and checks

The plugin supports independent Web development. The companion `dsh-project-desktop` provides the native application and builds a pinned plugin commit. Plugin edits do not automatically replace running project windows.

```sh
yarn run setup -- --shell ../dsh-project-desktop
yarn run test:compatibility -- ../dsh-project-desktop
```

See [development notes](docs/development.md) for checks, boundaries and platform limitations.

UI work must follow the [frontend guidelines](docs/frontend-guidelines.md) (detailed requirements in Chinese), covering official component reuse, forms, modals, stable scrolling and acceptance.

## Rights and third-party code

Original code is currently **publicly readable, with all other rights reserved**; there is no general grant to use, modify or redistribute it. See [LICENSE](LICENSE). Rights under applicable law, hosting platform terms and third-party licenses are unaffected. `private: true` prevents accidental npm publication; it does not require a private Git repository.

Adapted DeepSeek Harness and DSH Desktop material retains its MIT terms and copyright notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
