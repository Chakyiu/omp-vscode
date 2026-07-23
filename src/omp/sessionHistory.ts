import { randomUUID } from "crypto";
import type { ChatMessage, MessagePart, ToolCallPart } from "./types";

const TOOL_PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "filepath",
  "file",
  "target_notebook",
  "target",
  "entry",
  "name",
] as const;

function asToolInputObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function extractHashlinePath(text: string): string | undefined {
  const match = String(text || "").match(/\[\s*([^\]\n#]+?)\s*#[0-9A-Fa-f]{4,}\s*\]/);
  const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  return value || undefined;
}

function pickToolPath(obj: Record<string, unknown>): string | undefined {
  for (const key of TOOL_PATH_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  for (const key of ["input", "_input", "patch"] as const) {
    const nested = obj[key];
    if (typeof nested === "string" && nested.trim()) {
      const fromHashline = extractHashlinePath(nested);
      if (fromHashline) {
        return fromHashline;
      }
    }
  }
  if (Array.isArray(obj.paths)) {
    for (const item of obj.paths) {
      if (typeof item === "string" && item.trim()) {
        return item.trim();
      }
    }
  }
  return undefined;
}

function compactToolInput(value: unknown): unknown {
  const obj = asToolInputObject(value);
  if (!obj) {
    return value;
  }
  const bulkyKeys = new Set([
    "contents",
    "content",
    "new_string",
    "old_string",
    "text",
    "code",
    "prompt",
    "message",
    "input",
    "_input",
    "patch",
  ]);
  const pathValue = pickToolPath(obj);
  const hasBulky = Object.keys(obj).some(
    (key) => bulkyKeys.has(key) && typeof obj[key] === "string" && String(obj[key]).length > 80,
  );
  if (!pathValue || !hasBulky) {
    return obj;
  }
  const slim: Record<string, unknown> = { path: pathValue };
  for (const key of TOOL_PATH_KEYS) {
    if (typeof obj[key] === "string" && String(obj[key]).trim()) {
      slim[key] = obj[key];
    }
  }
  for (const [key, raw] of Object.entries(obj)) {
    if (key in slim) {
      continue;
    }
    if (typeof raw === "string" && bulkyKeys.has(key)) {
      // Keep a tiny hashline prefix so path recovery still works if needed.
      if ((key === "input" || key === "_input" || key === "patch") && extractHashlinePath(raw)) {
        slim[key] = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
      } else {
        slim[key] = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
      }
      continue;
    }
    if (typeof raw === "string" && raw.length > 160) {
      slim[key] = `${raw.slice(0, 160)}…`;
      continue;
    }
    slim[key] = raw;
  }
  return slim;
}

function preview(value: unknown, max = 400): string | undefined {
  if (value == null) {
    return undefined;
  }
  const compact = compactToolInput(value);
  const text = typeof compact === "string" ? compact : JSON.stringify(compact, null, 2);
  if (!text) {
    return undefined;
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return preview(content);
  }
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string" && record.text) {
      texts.push(record.text);
    }
  }
  return texts.length ? preview(texts.join("\n")) : undefined;
}

function createdAtOf(raw: Record<string, unknown>, fallback: number): number {
  const ts = raw.timestamp ?? (raw.message as Record<string, unknown> | undefined)?.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 1e12) {
    return ts;
  }
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

/**
 * Convert omp `get_messages` payload into UI ChatMessage list.
 * toolResult rows are folded into the matching assistant toolCall parts.
 */
export function chatMessagesFromOmp(rawMessages: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const toolIndex = new Map<string, { messageIndex: number; partIndex: number }>();
  let fallbackTime = Date.now();

  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const row = raw as Record<string, unknown>;
    const role = String(row.role ?? "");
    fallbackTime += 1;
    const createdAt = createdAtOf(row, fallbackTime);

    if (role === "user") {
      const nested = row.message as Record<string, unknown> | undefined;
      const content = Array.isArray(row.content)
        ? row.content
        : Array.isArray(nested?.content)
          ? (nested.content as unknown[])
          : [];
      const parts: MessagePart[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") {
          parts.push({ kind: "text", text: p.text });
        }
      }
      if (parts.length === 0) {
        const text = textFromContent(content);
        if (text) {
          parts.push({ kind: "text", text });
        }
      }
      out.push({
        id: randomUUID(),
        role: "user",
        createdAt,
        parts,
      });
      continue;
    }

    if (role === "assistant") {
      const content = Array.isArray(row.content) ? row.content : [];
      const parts: MessagePart[] = [];
      const messageIndex = out.length;
      for (const part of content) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const p = part as Record<string, unknown>;
        if (p.type === "thinking") {
          const thinking = typeof p.thinking === "string" ? p.thinking : "";
          parts.push({ kind: "thinking", text: thinking });
          continue;
        }
        if (p.type === "text" && typeof p.text === "string") {
          parts.push({ kind: "text", text: p.text });
          continue;
        }
        if (p.type === "toolCall" || p.type === "tool_call") {
          const id = String(p.id ?? p.toolCallId ?? randomUUID());
          const tool: ToolCallPart = {
            kind: "tool",
            id,
            name: String(p.name ?? p.toolName ?? "tool"),
            status: "done",
            inputPreview: preview(p.arguments ?? p.args ?? p.input, 800),
          };
          toolIndex.set(id, { messageIndex, partIndex: parts.length });
          parts.push(tool);
        }
      }
      out.push({
        id: randomUUID(),
        role: "assistant",
        createdAt,
        streaming: false,
        parts,
      });
      continue;
    }

    if (role === "toolResult" || role === "tool") {
      const id = String(row.toolCallId ?? row.id ?? "");
      if (!id) {
        continue;
      }
      const loc = toolIndex.get(id);
      if (!loc) {
        continue;
      }
      const message = out[loc.messageIndex];
      if (!message) {
        continue;
      }
      const part = message.parts[loc.partIndex];
      if (!part || part.kind !== "tool") {
        continue;
      }
      const failed = Boolean(row.isError ?? row.error);
      message.parts[loc.partIndex] = {
        ...part,
        status: failed ? "error" : "done",
        outputPreview: textFromContent(row.content) ?? preview(row.result ?? row.error),
      };
    }
  }

  return out;
}
