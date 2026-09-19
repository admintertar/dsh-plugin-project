/** Project actions for the two controls without slots in DSH 0.1.5-rc.2 SidebarRoot. */
export interface ProjectSidebarControls {
  overviewLabelId: string;
  canStart: boolean;
  showOverview(): void;
  startSession(): void;
}

/**
 * Bind only the enclosing official sidebar, reached from our own brand-mark slot.
 * SidebarRoot owns a logo row followed by its direct New Session button; Tooltip
 * clones that button without wrapping it. Avoid generated CSS names and locale
 * text selectors. Recheck this small DOM contract when upgrading the pinned DSH.
 */
export function bindProjectSidebarControls(mark: HTMLElement, actions: ProjectSidebarControls): () => void {
  const markSlot = mark.closest('[data-slot="sidebar.brand.mark"]');
  const markButton = markSlot?.closest('button');
  const logoRow = markButton?.parentElement;
  const sidebar = logoRow?.parentElement;
  const newSession = sidebar?.querySelector<HTMLButtonElement>(':scope > button');
  if (!logoRow || !sidebar?.closest('[data-slot="sidebar"]') || sidebar.firstElementChild !== logoRow || !newSession) {
    throw new Error('Project sidebar controls require the pinned official SidebarRoot layout');
  }
  const brand = logoRow.querySelector('[data-slot="sidebar.brand.name"]')?.closest('button');
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
