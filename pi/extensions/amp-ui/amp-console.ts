import { format } from "node:util";

/**
 * Keeps stray console output out of the prompt box.
 *
 * Extensions such as pi-web-access print hints with `console.error`. Pi does
 * not intercept the console while its TUI runs, so the raw text lands at the
 * hardware cursor, inside the editor, and stays there because the differential
 * renderer believes those rows are unchanged. While the TUI runs, this module
 * shows such output as a notification instead.
 */

type NotifyType = "info" | "warning";
type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
export type ConsoleLike = Record<ConsoleMethod, (...args: unknown[]) => void>;

const METHODS: Record<ConsoleMethod, NotifyType> = {
  log: "info",
  info: "info",
  debug: "info",
  warn: "warning",
  error: "warning",
};

/**
 * Replaces the console methods of `target` so that, while `isActive()` holds,
 * their output goes to `notify`. Returns a function that restores the originals.
 */
export function captureConsole(
  target: ConsoleLike,
  isActive: () => boolean,
  notify: (message: string, type: NotifyType) => void,
): () => void {
  const originals = {} as ConsoleLike;
  for (const method of Object.keys(METHODS) as ConsoleMethod[]) {
    const original = target[method];
    originals[method] = original;
    target[method] = (...args: unknown[]) => {
      if (!isActive()) {
        original.apply(target, args);
        return;
      }
      const message = format(...args).trim();
      if (message) notify(message, METHODS[method]);
    };
  }
  return () => Object.assign(target, originals);
}
