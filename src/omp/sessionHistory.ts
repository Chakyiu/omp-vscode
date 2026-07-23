import { randomUUID } from "crypto";
import type { ChatMessage, MessagePart, ToolCallPart } from "./types";

function preview(value: unknown, max = 400): string | undefined {
  if (value == null) {
    return undefined;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
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
            inputPreview: preview(p.arguments ?? p.args ?? p.input),
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
