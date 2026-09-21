import type {PickSource} from '../api-types.ts';

/** Resolve one directory through the chooser the current environment actually has. */
export type PickDirectory = (source: PickSource | null | undefined) => Promise<string | null>;

interface WorkspacePicker {pickDirectory(): Promise<string | null>}

/** Only these route codes may reach the UI; anything else collapses to the generic failure. */
const pickErrors = new Set(['native-picker-unavailable', 'project-closing', 'unauthorized',
  'same-origin-json-required', 'method-not-allowed', 'body-too-large', 'invalid-json']);

/**
 * `native` keeps the official workspace flow; `desktop` asks the Host to open the
 * Desktop shell's own chooser, which serves Windows where the launcher pins the
 * browse backend. Any other source keeps the panel's existing refusal.
 */
export function createPickDirectory(workspace: WorkspacePicker,
  request: typeof fetch = (input, init) => fetch(input, init)): PickDirectory {
  return async source => {
    if (source === 'native') return await workspace.pickDirectory();
    if (source !== 'desktop') throw new Error('native-picker-unavailable');
    const response = await request('/api/project/pick', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.error === 'string' && pickErrors.has(data.error) ? data.error : 'operation-failed');
    return typeof data?.path === 'string' ? data.path : null;
  };
}
