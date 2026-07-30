/**
 * Transcript extraction from a session branch.
 *
 * Ported in shape from pi-autoname (MIT) — https://github.com/ssdiwu/pi-autoname
 *
 * Entries are read structurally rather than through pi's session types so this
 * module stays free of pi imports and testable with plain object literals.
 */

/** Per-message character cap, so one large paste cannot dominate the excerpt. */
export const MAX_PART_CHARS = 700;

/** Default number of messages in the recent window. */
export const DEFAULT_WINDOW = 6;

export interface DialoguePart {
  role: "user" | "assistant";
  text: string;
}

/** Pull text out of message content that may be a string or a ContentBlock[]. */
export function blockText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join(" ")
    .trim();
}

/**
 * Remove fenced and inline code, URLs, and filesystem paths. Used before the
 * language decision so identifiers and paths cannot outweigh short prose.
 */
export function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:^|\s)(?:~\/|\.{0,2}\/)\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cap(text: string): string {
  return text.length > MAX_PART_CHARS ? text.slice(0, MAX_PART_CHARS) : text;
}

function messageOf(entry: any): { role: unknown; text: string } | undefined {
  if (entry?.type !== "message" || !entry.message) return undefined;
  return { role: entry.message.role, text: blockText(entry.message.content) };
}

/**
 * First user message and the first assistant reply after it. When compaction has
 * already consumed the opening exchange, the compaction summary stands in for
 * the user message. Returns [] unless both halves are available.
 */
export function firstExchange(branch: readonly unknown[]): DialoguePart[] {
  let user: string | undefined;
  let assistant: string | undefined;

  for (const entry of branch as any[]) {
    if (entry?.type === "compaction" && !user) {
      const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
      if (summary) user = summary;
      continue;
    }
    const message = messageOf(entry);
    if (!message || !message.text) continue;
    if (!user && message.role === "user") {
      user = message.text;
      continue;
    }
    if (user && message.role === "assistant") {
      assistant = message.text;
      break;
    }
  }

  if (!user || !assistant) return [];
  return [
    { role: "user", text: cap(user) },
    { role: "assistant", text: cap(assistant) },
  ];
}

/** The last `maxMessages` user/assistant messages, chronologically. */
export function recentWindow(
  branch: readonly unknown[],
  maxMessages = DEFAULT_WINDOW,
): DialoguePart[] {
  const parts: DialoguePart[] = [];
  for (let index = branch.length - 1; index >= 0 && parts.length < maxMessages; index -= 1) {
    const message = messageOf(branch[index]);
    if (!message || !message.text) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    parts.push({ role: message.role, text: cap(message.text) });
  }
  return parts.reverse();
}

function messageCount(branch: readonly unknown[]): number {
  let count = 0;
  for (const entry of branch as any[]) {
    const role = entry?.message?.role;
    if (entry?.type === "message" && (role === "user" || role === "assistant")) count += 1;
  }
  return count;
}

/**
 * Input for automatic titling. A fresh session is titled from its opening
 * exchange; a session that accumulated more than one exchange without ever
 * being named is titled from its recent window, because its first exchange is
 * no longer what the session is about.
 */
export function initialDialogue(branch: readonly unknown[]): DialoguePart[] {
  if (messageCount(branch) > 2) return recentWindow(branch);
  return firstExchange(branch);
}
