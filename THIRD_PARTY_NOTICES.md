# Third-party notices

The project's original code has no open-source license grant; see `LICENSE`.
The upstream material identified below retains its original MIT terms. This
notice does not relicense that material under the project's rights-reserved
notice. Installed dependencies also retain their own package licenses.

## DeepSeek Harness adaptations

Source: https://github.com/deepseek-ai/deepseek-harness

`src/vendor/dsh-mcp-client/{connection,tools,transport}.ts` derives from
`deepseek-ai/deepseek-harness` commit `fb2c4b9e698e30edb738bca4cf0618587db7d203`
(`@deepseek-ai/dsh-mcp-client@0.1.5-rc.2`, `packages/mcp/mcp-client/src`).
The plugin adds a structured connection-state observer to the supervisor and
imports the public configuration type. It uses an ES2022-typed close promise
to match this project’s TypeScript setup. Tool/result/attachment conversion and
transport behavior follow that pinned upstream source.

The upstream package has no public lifecycle observer. When upgrading DSH,
compare these files with upstream and re-run lifecycle and rich-result tests;
remove this adapter once a public observer can replace it.

Earlier adapter development also compared Harness commit
`0a15e36e7f82b6ed45af6fa9759f29b40dcd965d` (`0.1.6-alpha.1`) for Desktop 2.0.11
beta. Its MCP implementation moves to the new client SDK, exposes a tool
definition factory and adds server context; connection-state observation is
still private. This plugin retains its explicitly pinned SDK 1.30 bridge.
Current support and acceptance target stable only; beta metadata and adapter
fixtures remain as historical comparison material, not a support commitment.

The Project session browser in `src/client/index.tsx`, `session-browser.ts`,
`session-browser-store.ts`, `sidebar-controls.ts`, `sidebar-counts.ts` and
`styles.ts` adapts the pinned upstream `WorkspaceBrowser` flat-list structure,
search, row composition and ordering behavior from
`packages/client/ui-workspace/src/client`. It removes workspace grouping and
directory operations and enforces the current Project-root boundary. Official
FlatList, Search and SessionNodeItem implementations remain runtime imports.

`ProjectControls.tsx` and `styles.ts` also adapt settings presentation from
the upstream LanguageRow, ModelsSection and SettingsRoot. Inputs, menus,
buttons, switches and modals compose public primitives; textarea, radio and
checkbox presentation use minimal adaptations where no public primitive is
exported by the pinned version.

The reconnect settings card in `src/client/ProjectControls.tsx` and
`src/client/styles.ts` adapts the private `PluginCard` presentation from the
same pinned upstream commit (`packages/client/ui-settings-plugins/src/client`).
It composes the public Button and icon primitives, keeps collapsed fields
mounted, and leaves saving to the enclosing MCP form.

The tool cards in `src/client/ToolsPanel.tsx` and `src/client/styles.ts` adapt
the private `AgentPresetSection` card presentation from the same upstream
commit (`packages/client/ui-agent-preset/src/client`). They retain its grid,
card geometry and bounded descriptions, using public Button and Modal
primitives to read a tool's complete description.

MCP service cards in `src/client/McpPanel.tsx` share that `AgentPresetSection`
grid and card presentation, including the separated footer and compact action
buttons, composed with public Switch, Button and Tooltip primitives. Tool names
remain visible in a bounded list to keep the grid height stable.

The 0.1.6-alpha.1 comparison retains the public Modal, Menu, Button, Switch and
DisclosureRow APIs, SettingsRoot insets, PluginCard chrome, and preset card
geometry used here. Textarea/Radio/Checkbox are still not public primitive
exports. WorkspaceBrowser refactors ordering helpers internally; this plugin
retains its Project-root boundary and existing flat-list ordering tests. These
adaptations do not import the new private helpers from the beta source tree.

The Task preview adapter in `src/client/task-preview.tsx` rehosts the installed
official TextPreview and document component objects via the public SlotRegistry.
It adapts their scope, independent declarative stores and read faces; it does
not copy viewer implementations. `TaskFileSidebar.tsx` also rehosts the installed
RightbarSeat and ExpandButton through their Slot registrations, retaining the
official DockSurface, FloatLayer, animation and fullscreen behavior. The frame
owns column sizing and its resize handle. `task-sidebar-controller.ts` clones
the official Sidebar store declaration into root scope and supplies task-only
file identities and tab lifetimes, independently of Session services. Check
these bridges against the pinned stable runtime and remove them when standalone
preview and Sidebar entry points become public.

### DeepSeek license

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## DSH Desktop adaptations

Source: https://github.com/anywhere-labs/dsh-desktop

`src/client/ProjectControls.tsx` (`ProjectSwitch` / `ProjectToggleRow`) and
`src/client/styles.ts` adapt the private `DesktopSettingsSection.ToggleRow`
switch presentation from Desktop commit
`01fa59e6688d82fa34b59fc507e3a6f5d695fa17` (2.0.11). Interaction, state and
accessibility remain owned by the official public Switch primitive. The
adapter retains the Desktop dimensions and theme variables inside the
plugin's shared settings rows. The development setup reads the same pinned
Desktop commit to obtain stable Harness runtime archives; those dependencies
are generated locally and are not committed to this repository.

### Anywhere Labs license

MIT License

Copyright (c) 2026 Anywhere Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
