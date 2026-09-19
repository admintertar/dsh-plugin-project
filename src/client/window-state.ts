import type {Context} from '@deepseek-ai/cordis';

interface WindowState {enabled: boolean; presentation?: string}
interface WindowStateOptions {
  request?: typeof fetch;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

/** Distinguish transient Host failures from responses retrying cannot repair. */
class WindowStateError extends Error {
  constructor(message: string, readonly retryable: boolean) {super(message);}
}

/** A cancelled plugin must not leave a retry timer or its abort listener alive. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {clearTimeout(timer); reject(signal.reason);};
    const timer = setTimeout(() => {signal.removeEventListener('abort', abort); resolve();}, ms);
    signal.addEventListener('abort', abort, {once: true});
  });
}

/** Read the mode before mounting UI, retrying only bounded, transient failures. */
async function fetchWindowState(signal: AbortSignal, {
  request = (input, init) => fetch(input, init), timeoutMs = 5000, retryDelaysMs = [250, 1000],
}: WindowStateOptions): Promise<WindowState> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const current = new AbortController();
    const abort = () => current.abort(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    const timeout = setTimeout(() => current.abort(new DOMException('Window state request timed out', 'TimeoutError')), timeoutMs);
    try {
      const response = await request('/api/project/windows', {signal: current.signal});
      if (!response.ok) throw new WindowStateError(`HTTP ${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500);
      let state: unknown;
      try {state = await response.json();}
      catch (error) {
        current.signal.throwIfAborted();
        if (error instanceof SyntaxError) throw new WindowStateError('Invalid window state JSON', false);
        throw error;
      }
      current.signal.throwIfAborted();
      if (!state || typeof state !== 'object' || !('enabled' in state) || typeof state.enabled !== 'boolean'
        || ('presentation' in state && typeof state.presentation !== 'string')) {
        throw new WindowStateError('Invalid window state', false);
      }
      return state as WindowState;
    } catch (error) {
      signal.throwIfAborted();
      if (attempt >= retryDelaysMs.length || (error instanceof WindowStateError && !error.retryable)) throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      current.abort();
    }
    await delay(retryDelaysMs[attempt]!, signal);
  }
}

/**
 * Bind startup requests to the Cordis plugin lifetime. Cordis waits for async
 * apply() before running effects' cleanup, so observe disposal immediately too.
 * An undefined result means teardown won and no UI may be registered.
 */
export async function loadProjectWindowState(ctx: Context, options: WindowStateOptions = {}): Promise<WindowState | undefined> {
  const lifetime = new AbortController();
  const cleanup = ctx.effect(() => () => lifetime.abort(), 'project: window state request');
  const remove = ctx.on('internal/plugin', fiber => {
    if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort();
  });
  try {return await fetchWindowState(lifetime.signal, options);}
  catch (error) {
    if (lifetime.signal.aborted) return undefined;
    throw error;
  } finally {remove(); cleanup();}
}
