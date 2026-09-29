/** Project actions for the controls without action slots in the official SidebarRoot. */
export interface ProjectSidebarControls {
  overviewLabelId: string;
  canStart: boolean;
  showOverview(): void;
  startSession(): void;
}

/**
 * Bind only the enclosing official sidebar, reached from our own brand-mark slot.
 * SidebarRoot owns a direct New Session button. On macOS 0.2 the logo row is
 * preceded by a draggable top strip, and its brand is a plain span; on other
 * platforms the expanded brand remains a button. Find the root by its owned
 * workspaces seat instead of assuming the logo row is its first child.
 * Avoid generated CSS names and locale text selectors.
 */
export function bindProjectSidebarControls(mark: HTMLElement, actions: ProjectSidebarControls): () => void {
  const markSlot = mark.closest('[data-slot="sidebar.brand.mark"]');
  const slotRoot = markSlot?.closest('[data-slot="sidebar"]');
  let sidebar = markSlot?.parentElement;
  while (sidebar && sidebar !== slotRoot &&
    (!sidebar.querySelector(':scope > button') || !sidebar.querySelector('[data-slot="sidebar.workspaces"]'))) {
    sidebar = sidebar.parentElement;
  }
  const newSession = sidebar?.querySelector<HTMLButtonElement>(':scope > button');
  if (!slotRoot || !sidebar || sidebar === slotRoot || !newSession) {
    throw new Error('Project sidebar controls require the pinned official SidebarRoot layout');
  }
  const brandButton = markSlot?.closest('button');
  const brand = brandButton?.querySelector('[data-slot="sidebar.brand.name"]') ? brandButton : undefined;
  const releases: Array<() => void> = [];
  const intercept = (button: HTMLButtonElement, action: () => void) => {
    const click = (event: MouseEvent) => {
      // Native button activation produces click for both pointer and Enter/Space.
      // Stop the official React onClick before it reaches the delegated handler.
      event.preventDefault();
      event.stopImmediatePropagation();
      action();
    };
    button.addEventListener('click', click, true);
    releases.push(() => button.removeEventListener('click', click, true));
  };
  if (brand) {
    const previousLabel = brand.getAttribute('aria-labelledby');
    brand.setAttribute('aria-labelledby', actions.overviewLabelId);
    releases.push(() => {
      if (previousLabel === null) brand.removeAttribute('aria-labelledby');
      else brand.setAttribute('aria-labelledby', previousLabel);
    });
    intercept(brand, actions.showOverview);
  }
  // In the collapsed rail the brand mark sits inside the expand button. Leave
  // that button untouched, while retaining the root-bound New Session action.
  const wasDisabled = newSession.disabled;
  newSession.disabled = !actions.canStart;
  releases.push(() => {newSession.disabled = wasDisabled;});
  intercept(newSession, () => {if (actions.canStart) actions.startSession();});
  return () => {for (const release of releases.reverse()) release();};
}
