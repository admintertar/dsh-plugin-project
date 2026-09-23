import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {styles} from '../src/client/styles.ts';

test('project styles leave the enhanced sidebar material under Desktop ownership', () => {
  assert.doesNotMatch(styles, /\.dshDesktopSidebarSurface/);
  assert.doesNotMatch(styles, /--project-sidebar-fill/);
});

test('project panel navigation restores Desktop and document geometry without transitions', () => {
  assert.match(styles, /html\[data-project-panel-switching\] \.dshDesktopFrame/);
  assert.match(styles, /html\[data-project-panel-switching\] \.dshDesktopResizeHandle/);
  assert.match(styles, /html\[data-project-panel-switching\] \[data-sidebar-right-panel\]\{transition:none!important\}/);
});

test('memory styles provide a responsive Markdown source editor', () => {
  assert.match(styles, /\.project-memory-markdown/);
  assert.match(styles, /\.project-memory-editor textarea/);
  assert.match(styles, /min-height:300px/);
  assert.match(styles, /resize:vertical/);
  assert.match(styles, /\.project-memory-actions\{/);
  assert.match(styles, /\.project-memory-create-source\{min-height:220px\}/);
});

test('Skill cards share the compact MCP grid and card chrome', () => {
  assert.match(styles, /\.project-tool-grid,\.project-mcp-grid,\.project-skill-grid\{/);
  assert.match(styles, /\.project-tool-card,\.project-mcp-card,\.project-skill-card\{/);
  assert.match(styles, /\.project-skill-grid\{grid-auto-rows:auto\}/);
});

test('scrollbars reserve stable space inside existing right insets', () => {
  assert.match(styles, /\.project-session-list\{[^}]*padding-right:calc\([^}]*scrollbar-gutter:stable/);
  assert.match(styles, /\.project-panel\{[^}]*scrollbar-gutter:stable[^}]*padding-right:calc\(clamp\(20px,4vw,48px\) - var\(--dsh-scrollbar-width,8px\)\)/);
  assert.match(styles, /\.project-mcp-tools\{[^}]*overflow-y:auto;[^}]*scrollbar-gutter:stable/);
  assert.match(styles, /\.project-settings-dialog-content>div:last-child\{[^}]*overflow-y:auto;[^}]*scrollbar-gutter:stable;padding-right:calc\(24px - var\(--dsh-scrollbar-width,8px\)\)/);
  assert.doesNotMatch(styles, /\.project-capability-form\{[^}]*overflow-y:/);
});

test('long dialogs share the official settings scrolling adapter', () => {
  const controls = readFileSync(new URL('../src/client/ProjectControls.tsx', import.meta.url), 'utf8');
  assert.match(controls, /className="project-settings-dialog" contentClassName="project-settings-dialog-content"/);
  for (const file of ['McpPanel.tsx', 'ResourcesPanel.tsx', 'ToolsPanel.tsx']) {
    const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8');
    assert.match(source, /<ProjectScrollableModal/);
  }
});
