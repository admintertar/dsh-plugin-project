import type {Context} from '@deepseek-ai/cordis';
import type {PickSource} from './api-types.ts';
import {ProjectHttpError} from './http.ts';

/**
 * Optional Desktop capability; the Web plugin remains a regular DSH plugin.
 * The Desktop shell bridges its own Electron chooser into this Host process, so a
 * launcher that pins the browse directory-picker backend still offers a native one.
 */
interface DesktopRuntimePicker {pickDirectory?(): Promise<string | null>}

function desktopRuntime(ctx: Context): DesktopRuntimePicker | undefined {
  const runtime = ctx.get('desktopRuntime') as DesktopRuntimePicker | undefined;
  return typeof runtime?.pickDirectory === 'function' ? runtime : undefined;
}

/**
 * The local attended chooser this Host can drive for a directory, or `null` when
 * none is reachable. `native` is the official directory-picker seam; `desktop` is
 * the Desktop shell runtime, which serves Windows where the launcher pins browse.
 */
export function pickSource(ctx: Context): PickSource | null {
  if ((ctx.get('directoryPicker') as {capability(): {kind: string}} | undefined)?.capability().kind === 'native') return 'native';
  return desktopRuntime(ctx) === undefined ? null : 'desktop';
}

/** Open the Desktop shell's chooser on the host display; callers check `pickSource` first. */
export async function pickDesktopDirectory(ctx: Context): Promise<string | null> {
  const runtime = desktopRuntime(ctx);
  if (runtime === undefined) throw new ProjectHttpError(409, 'native-picker-unavailable');
  const pick = runtime.pickDirectory;
  if (pick === undefined) throw new ProjectHttpError(409, 'native-picker-unavailable');
  return await pick.call(runtime);
}
