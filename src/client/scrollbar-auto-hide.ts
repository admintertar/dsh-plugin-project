export const PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE = 'data-project-scrolling';
export const PROJECT_SCROLLBAR_IDLE_MS = 800;

/**
 * Every plugin surface that may scroll. The list drives the controller's
 * `matches` check and the generated idle-fade CSS in `styles.ts`, so a new
 * scroll container is registered in exactly one place. It mirrors each rule
 * that reserves a stable gutter; `client-styles.test.ts` fails when a stable
 * gutter exists without a corresponding entry here.
 */
export const PROJECT_SCROLL_SURFACE_SELECTORS = [
  '.project-session-list',
  '.project-panel',
  '.project-mcp-tools',
  '.project-settings-dialog-content>div:last-child',
  '.project-commit-list',
  '.project-tasks>.project-task-diagnostics',
  '.project-tasks .project-capability-list',
  '.project-tasks .project-task-detail',
  '.project-task-materials',
  '.project-task-official-document [data-textpreview-body]',
  '.project-task-commit',
  '.project-task-commit [data-diff]>div:first-of-type',
] as const;

const SURFACE_QUERY = PROJECT_SCROLL_SURFACE_SELECTORS.join(',');

export interface ProjectScrollbarTimerHost {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

/** A scroll event targets the scrolling element; `Document` targets and any
 * non-element target are ignored. The structural check keeps the controller
 * independent of the window that created the element, because the plugin
 * renders into the Host Renderer while tests run under happy-dom. */
interface ScrollSurfaceLike {
  nodeType?: number;
  matches?(selectors: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function isScrollSurface(target: EventTarget | null): target is EventTarget & ScrollSurfaceLike {
  const candidate = target as ScrollSurfaceLike | null;
  return candidate !== null && candidate.nodeType === 1
    && typeof candidate.matches === 'function' && candidate.matches(SURFACE_QUERY);
}

/**
 * Idle fade for the plugin's themed scrollbars. The pinned stable ui-theme
 * skins the scrollbar but ships no auto-hide controller; the shell guide window
 * keeps its own copy on GuideFrame. Observing real scroll events puts wheel,
 * touchpad, keyboard and thumb dragging on one path, and only the visibility
 * changes: overflow, the stable gutter and the content width stay untouched.
 */
export class ProjectScrollbarAutoHide {
  private readonly timers = new Map<ScrollSurfaceLike, number>();
  private disposed = false;

  constructor(
    private readonly document: Document,
    private readonly host: ProjectScrollbarTimerHost = document.defaultView!,
    private readonly idleMs: number = PROJECT_SCROLLBAR_IDLE_MS,
  ) {
    this.document.addEventListener('scroll', this.onScroll, true);
  }

  private readonly onScroll = (event: Event): void => {
    const target = event.target;
    if (!isScrollSurface(target)) return;
    const pending = this.timers.get(target);
    if (pending !== undefined) this.host.clearTimeout(pending);
    target.setAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE, '');
    this.timers.set(target, this.host.setTimeout(() => {
      this.timers.delete(target);
      target.removeAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE);
    }, this.idleMs));
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.document.removeEventListener('scroll', this.onScroll, true);
    for (const [target, timer] of this.timers) {
      this.host.clearTimeout(timer);
      target.removeAttribute(PROJECT_SCROLLBAR_SCROLLING_ATTRIBUTE);
    }
    this.timers.clear();
  }
}
