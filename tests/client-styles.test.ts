import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {styles} from '../src/client/styles.ts';
import {PROJECT_SCROLL_SURFACE_SELECTORS} from '../src/client/scrollbar-auto-hide.ts';

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

test('plugin scroll surfaces fade their themed scrollbar while idle', () => {
  assert.match(styles, /@property --project-scrollbar-alpha\{syntax:"<number>";inherits:true;initial-value:0\}/);
  assert.match(styles, /\[data-project-scrolling\]\{--project-scrollbar-alpha:1;transition-duration:0s\}/);
  assert.match(styles, /::-webkit-scrollbar-thumb\{background:color-mix\(in srgb,var\(--dsh-scrollbar-thumb\) calc\(var\(--project-scrollbar-alpha\) \* 100%\),transparent\)\}/);
  assert.match(styles, /::-webkit-scrollbar-thumb:hover\{background:color-mix\(in srgb,var\(--dsh-scrollbar-thumb-hover\) calc\(var\(--project-scrollbar-alpha\) \* 100%\),transparent\)\}/);
  assert.match(styles, /::-webkit-scrollbar-thumb:active\{background:var\(--dsh-scrollbar-thumb-hover\)\}/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)\{[^{}]*\{transition:none\}\}/);
});

test('every stable scrollbar gutter is registered with the idle fade', () => {
  const gutters = [...styles.matchAll(/([^\n{}]+)\{[^\n{}]*scrollbar-gutter:stable[^\n{}]*\}/g)]
    .map(match => match[1]!.trim());
  const registered = PROJECT_SCROLL_SURFACE_SELECTORS as readonly string[];
  assert.equal(gutters.length, registered.length);
  for (const selector of [...gutters, ...registered]) {
    assert.ok(registered.includes(selector) && gutters.includes(selector),
      `scrollbar surface and stable gutter drifted apart: ${selector}`);
  }
});

test('long dialogs share the official settings scrolling adapter', () => {
  const controls = readFileSync(new URL('../src/client/ProjectControls.tsx', import.meta.url), 'utf8');
  assert.match(controls, /className="project-settings-dialog" contentClassName="project-settings-dialog-content"/);
  for (const file of ['McpPanel.tsx', 'ResourcesPanel.tsx', 'ToolsPanel.tsx']) {
    const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8');
    assert.match(source, /<ProjectScrollableModal/);
  }
});
