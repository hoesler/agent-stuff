/**
 * The terminal side: a hold on pi's own OSC 7501 reports while a block it does
 * not know about is open.
 *
 * pi's reporter writes through `terminal.setProgramStatus` and skips a report
 * equal to its last one. So writing `blocked` beside it is not enough: when the
 * wait ends, pi's state has not changed, pi says nothing, and the terminal stays
 * on "blocked". Instead the hold sits in front of the terminal, keeps pi's latest
 * report while blocked, and replays it on release — the terminal ends up exactly
 * where pi left it, including any change pi reported in between.
 */

import type { ProgramStatus } from "@earendil-works/pi-tui";

type StatusSink = { setProgramStatus(status: ProgramStatus): void };

/** pi's `APP_NAME`, used until pi has reported something to copy it from. */
const APP = "pi";

export interface BlockedHold {
  /** Report `blocked` with this label until `release`. A second block replaces the label. */
  block(label: string): void;
  /** End the block and put back pi's latest report. */
  release(): void;
  /** Stop intercepting. pi's reports go straight to the terminal again. */
  detach(): void;
}

export function holdOn(terminal: StatusSink): BlockedHold {
  const original = terminal.setProgramStatus;
  const ownMethod = Object.hasOwn(terminal, "setProgramStatus");
  const write = original.bind(terminal);
  let blocked = false;
  // pi's latest report. Unknown when pi reported nothing since the hold was
  // attached; releasing then clears the record, and pi's next report restores it.
  let underlying: ProgramStatus | undefined;

  const intercept = (status: ProgramStatus): void => {
    underlying = status;
    if (!blocked) write(status);
  };
  terminal.setProgramStatus = intercept;

  return {
    block(label) {
      blocked = true;
      write({ state: "blocked", kind: "question", message: label, app: underlying?.app ?? APP });
    },
    release() {
      if (!blocked) return;
      blocked = false;
      write(underlying ?? { state: "clear" });
    },
    detach() {
      this.release();
      if (terminal.setProgramStatus !== intercept) return;
      if (ownMethod) terminal.setProgramStatus = original;
      else delete (terminal as Partial<StatusSink>).setProgramStatus;
    },
  };
}
