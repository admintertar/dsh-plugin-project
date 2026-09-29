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

This migration branch targets DeepSeek's official Desktop / Harness **0.2.0-rc.2**. The exact commit and source tree are in [upstream.json](upstream.json). The companion Shell is still being migrated, so this branch is not a publishable Stable release.

This independently maintained project is not an official DeepSeek or Anywhere Labs product. Original project code currently has **no open-source license grant**.

## Local development

Requires Node.js `^22.19.0 || >=24.0.0`, Corepack, Git and pnpm 11.7.0. First install and build the pinned official source, then run setup in this repository:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness
git -C ../deepseek-harness checkout 639ed015397290b3745d163aafe02ffee4aa3f84
cd ../deepseek-harness && pnpm install --frozen-lockfile && pnpm run build:official
cd ../dsh-plugin-project && yarn install --immutable
yarn run setup -- --desktop ../deepseek-harness
yarn run check
yarn start
```

Setup checks the official checkout HEAD, tag, Desktop tree and `pnpm-lock.yaml`, rejects tracked local edits, and links development packages from that workspace. It does not launch the desktop app. Install and build the official source first; run setup after `yarn install --immutable` to obtain matching development types.

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
# Run desktop compatibility checks after the Shell adopts the official source.
```

See [development notes](docs/development.md) for checks, boundaries and platform limitations.

UI work must follow the [frontend guidelines](docs/frontend-guidelines.md) (detailed requirements in Chinese), covering official component reuse, forms, modals, stable scrolling and acceptance.

## Rights and third-party code

Original code is currently **publicly readable, with all other rights reserved**; there is no general grant to use, modify or redistribute it. See [LICENSE](LICENSE). Rights under applicable law, hosting platform terms and third-party licenses are unaffected. `private: true` prevents accidental npm publication; it does not require a private Git repository.

Adapted DeepSeek Harness and DSH Desktop material retains its MIT terms and copyright notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
