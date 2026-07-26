/**
 * Shared chat-tab / history title normalization.
 * Keep tab labels, history rows, and agent titles on the same length/mention rules.
 */

const DEFAULT_MAX = 48;

/** File/folder basenames from `@path` mentions in a prompt. */
export function mentionBasenames(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of String(text || "").matchAll(/@([^\s\]})"']+)/g)) {
    const raw = match[1]?.replace(/\\/g, "/") ?? "";
    const base = raw.split("/").filter(Boolean).pop();
    if (!base || seen.has(base)) {
      continue;
    }
    seen.add(base);
    names.push(base);
  }
  return names;
}

export function cleanChatTitle(raw: string, max = DEFAULT_MAX): string | undefined {
  let next = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!next) {
    return undefined;
  }
  if (next.length > max) {
    next = `${next.slice(0, max).trim()}…`;
  }
  return next;
}

/**
 * Build a display title from the first user prompt.
 * Prefer natural language; fall back to "Review <files>" for @path-only turns.
 */
export function titleFromUserText(text: string, max = DEFAULT_MAX): string | undefined {
  const original = String(text || "").trim();
  if (!original) {
    return undefined;
  }

  const mentions = mentionBasenames(original);
  let body = original.replace(/@\S+/g, "").replace(/\s+/g, " ").trim();

  if (!body && mentions.length) {
    const shown = mentions.slice(0, 3).join(", ");
    const extra = mentions.length > 3 ? ` +${mentions.length - 3}` : "";
    body = `Review ${shown}${extra}`;
  }

  if (!body) {
    return undefined;
  }

  body = body.replace(/^(please\s+)?(can you\s+|could you\s+|help me\s+)?/i, "");
  if (!body) {
    return undefined;
  }
  body = body.charAt(0).toUpperCase() + body.slice(1);
  return cleanChatTitle(body, max);
}
