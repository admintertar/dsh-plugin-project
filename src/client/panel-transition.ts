export const PROJECT_PANEL_SWITCHING_ATTRIBUTE = 'data-project-panel-switching';

export interface ProjectPanelFrameHost {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

/** Keep panel-driven geometry changes transition-free through one painted frame. */
export class ProjectPanelTransition {
  private firstFrame?: number;
  private secondFrame?: number;

  constructor(
    private readonly document: Document,
    private readonly frames: ProjectPanelFrameHost = document.defaultView!,
  ) {}

  suppress = (): void => {
    this.cancelFrames();
    this.document.documentElement.setAttribute(PROJECT_PANEL_SWITCHING_ATTRIBUTE, '');
    this.firstFrame = this.frames.requestAnimationFrame(() => {
      this.firstFrame = undefined;
      this.secondFrame = this.frames.requestAnimationFrame(() => {
        this.secondFrame = undefined;
        this.document.documentElement.removeAttribute(PROJECT_PANEL_SWITCHING_ATTRIBUTE);
      });
    });
  };

  dispose(): void {
    this.cancelFrames();
    this.document.documentElement.removeAttribute(PROJECT_PANEL_SWITCHING_ATTRIBUTE);
  }

  private cancelFrames(): void {
    if (this.firstFrame !== undefined) this.frames.cancelAnimationFrame(this.firstFrame);
    if (this.secondFrame !== undefined) this.frames.cancelAnimationFrame(this.secondFrame);
    this.firstFrame = undefined;
    this.secondFrame = undefined;
  }
}
