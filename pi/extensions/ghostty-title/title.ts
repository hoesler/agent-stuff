/**
 * The title and progress bar, as a state machine over pi's lifecycle.
 *
 * Forked from pi-ghostty (see README). The one behavioural change: while a
 * prompt is up during a turn, the spinner stops and the title holds still.
 * Upstream rewrote the title every 80 ms for the whole turn, so anything else
 * that marks the terminal through its title — agentdash appending
 * "● needs you" while the agent waits on you — was overwritten before Ghostty's
 * command palette could ever see it.
 */

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Spinner frame interval. */
export const FRAME_MS = 80;

/** How long the "complete" progress flash stays before the bar is removed. */
const COMPLETION_FLASH_MS = 800;

/** Ghostty's ConEmu progress states (OSC 9;4). */
const PROGRESS_REMOVE = 0;
const PROGRESS_SET = 1;
const PROGRESS_INDETERMINATE = 3;

export interface Terminal {
  setTitle(title: string): void;
  setProgress(state: number, value?: number): void;
}

export interface Clock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class GhosttyTitle {
  private readonly term: Terminal;
  private readonly clock: Clock;
  private readonly project: string;
  private model: string | undefined;
  private sessionName: string | undefined;
  private working = false;
  private prompting = false;
  private tool: string | undefined;
  private frame = 0;
  private spinner: unknown;
  private completion: unknown;

  constructor(term: Terminal, clock: Clock, project: string) {
    this.term = term;
    this.clock = clock;
    this.project = project;
  }

  sessionStart(model: string | undefined, sessionName: string | undefined): void {
    this.model = model;
    this.sessionName = sessionName;
    this.term.setTitle(this.build());
  }

  modelSelect(model: string): void {
    this.model = model;
    if (!this.working) this.term.setTitle(this.build());
  }

  agentStart(): void {
    this.cancelCompletion();
    this.working = true;
    this.tool = undefined;
    this.frame = 0;
    this.term.setProgress(PROGRESS_INDETERMINATE);
    if (!this.prompting) this.spin();
  }

  agentEnd(): void {
    this.working = false;
    this.tool = undefined;
    this.stopSpinner();
    this.term.setProgress(PROGRESS_SET, 100);
    this.term.setTitle(this.build());
    this.completion = this.clock.setTimeout(() => {
      this.term.setProgress(PROGRESS_REMOVE);
      this.completion = undefined;
    }, COMPLETION_FLASH_MS);
  }

  toolStart(name: string): void {
    this.tool = name;
  }

  toolEnd(): void {
    this.tool = undefined;
  }

  /** A prompt is up. During a turn, freeze the title on what is running. */
  promptStart(): void {
    this.prompting = true;
    if (!this.working) return;
    this.stopSpinner();
    this.term.setTitle(this.build(this.tool));
  }

  promptEnd(): void {
    this.prompting = false;
    if (this.working) this.spin();
  }

  shutdown(): void {
    this.stopSpinner();
    this.cancelCompletion();
    this.term.setProgress(PROGRESS_REMOVE);
  }

  private spin(): void {
    this.stopSpinner();
    this.spinner = this.clock.setInterval(() => {
      const frame = BRAILLE_FRAMES[this.frame % BRAILLE_FRAMES.length];
      this.frame++;
      this.term.setTitle(`${frame} ${this.build(this.tool)}`);
    }, FRAME_MS);
  }

  private stopSpinner(): void {
    if (this.spinner) this.clock.clearInterval(this.spinner);
    this.spinner = undefined;
  }

  private cancelCompletion(): void {
    if (this.completion) this.clock.clearTimeout(this.completion);
    this.completion = undefined;
  }

  private build(extra?: string): string {
    const segments = ["π", this.project];
    if (this.sessionName) segments.push(this.sessionName);
    if (extra) segments.push(extra);
    else if (this.model) segments.push(this.model);
    return segments.join(" · ");
  }
}
