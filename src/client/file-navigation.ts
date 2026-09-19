interface ResourceNavigation {
  sessionId: string;
  currentSession(): string | undefined;
  cancelled(): boolean;
  openResource(): void;
  nextFrame?(): Promise<void>;
  timeoutMs?: number;
}

/**
 * Open from a Project global panel, where the previous rightbar seat is unmounted.
 * A fresh mounted seat may have no tabs; active() cannot test its readiness.
 * This is not a barrier for navigation directly between two mounted Session seats.
 */
export async function openSessionResource({sessionId, currentSession, cancelled, openResource,
  nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())), timeoutMs = 3000,
}: ResourceNavigation): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await nextFrame();
    if (cancelled()) return;
    if (currentSession() !== sessionId) continue;
    try {openResource(); return;}
    catch (error) {
      // The public service explicitly rejects a command before React mounts
      // its Session seat. Retry only that transition, never a resource error.
      if (!(error instanceof Error) || error.message !== 'sidebarRight: no session surface is mounted') throw error;
    }
  }
  if (!cancelled()) throw new Error('preview-unavailable');
}
