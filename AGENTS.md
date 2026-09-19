# Development guidelines

- Repository migration is complete as of 2026-09-19. All further development, fixes, builds and verification must use the public `dsh-plugin-project` and companion `dsh-project-desktop` repositories in their shared public workspace.
- Previous private repositories and the old Desktop fork are archival references only. Earlier instructions to develop or push there are superseded; do not copy private history, local configuration or private examples into the public repositories.
- Target only the stable versions pinned in `upstream.json`; beta metadata is historical regression material.
- Keep plugin features in this repository and window/application ownership in `dsh-project-desktop`. Official source snapshots remain unmodified.
- Reuse official UI primitives, locale, theme, FlatList/session rows and document preview slots. Record private-source adaptations and preserve third-party notices.
- Before any frontend change, read and follow [Frontend guidelines](docs/frontend-guidelines.md), the shared component, layout, interaction and acceptance requirements for the plugin and companion Shell.
- Keep the Project-root session/context boundary. Tasks use only `tasks/<name>/task.md` v3, explicit task IDs and task-local `artifacts/`; task identity must not depend on a session.
- Memory lives under root `memory/` and loads only declared files. Share `.agent-project/` metadata but ignore local bindings, provenance and recovery journals precisely.
- Reuse `ProjectControls.tsx` for controls. Settings use label/description left, controls right; long editors use full width. Long modals use one body scroll region with fixed title/actions. Preserve stable scrollbar gutters and narrow-window behavior.
- Verify English/Chinese text, theme states and keyboard behavior when changing UI. Tests/build do not replace native visual acceptance.
- Preserve existing work. Run `npm run check` for source changes; never rewrite a running Profile, publish a repository, change visibility or push to an upstream without an explicit request.
- Original code has no open-source license grant. Respect `LICENSE` and `THIRD_PARTY_NOTICES.md`; do not silently relicense it.
