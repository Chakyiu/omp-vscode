import type { ChatMessage, MessagePart } from "./types";

export interface SessionTranscriptMeta {
  title?: string;
  sessionId?: string;
  exportedAt?: Date;
}

function formatStamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function roleHeading(role: ChatMessage["role"]): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  return "System";
}

function formatPart(part: MessagePart): string {
  if (part.kind === "text") {
    return part.text.trimEnd();
  }
  if (part.kind === "thinking") {
    const body = part.text.trim();
    if (!body) {
      return "";
    }
    return `Thinking:\n${body}`;
  }

  const lines = [`[Tool: ${part.name}] (${part.status})`];
  if (part.filePaths?.length) {
    lines.push(`Files: ${part.filePaths.join(", ")}`);
  } else if (part.fileRefs?.length) {
    lines.push(
      `Files: ${part.fileRefs
        .map((ref) => {
          if (ref.line != null && ref.endLine != null && ref.endLine !== ref.line) {
            return `${ref.path}:${ref.line}-${ref.endLine}`;
          }
          if (ref.line != null) {
            return `${ref.path}:${ref.line}`;
          }
          return ref.path;
        })
        .join(", ")}`,
    );
  }
  if (part.inputPreview?.trim()) {
    lines.push(`Input:\n${part.inputPreview.trim()}`);
  }
  if (part.outputPreview?.trim()) {
    lines.push(`Output:\n${part.outputPreview.trim()}`);
  }
  return lines.join("\n");
}

function formatAttachments(message: ChatMessage): string {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return "";
  }
  const lines = attachments.map((item) => {
    const path = item.path || item.fsPath || item.label;
    return `- [${item.kind}] ${path}`;
  });
  return `Attachments:\n${lines.join("\n")}`;
}

/** Render a chat transcript as plain text for viewing / export. */
export function formatSessionPlainText(
  messages: ChatMessage[],
  meta: SessionTranscriptMeta = {},
): string {
  const header: string[] = [];
  header.push(`# ${meta.title?.trim() || "OMP Session"}`);
  if (meta.sessionId?.trim()) {
    header.push(`Session ID: ${meta.sessionId.trim()}`);
  }
  header.push(`Exported: ${(meta.exportedAt ?? new Date()).toISOString()}`);
  header.push(`Messages: ${messages.length}`);
  header.push("");
  header.push("---");
  header.push("");

  if (messages.length === 0) {
    header.push("(empty session)");
    header.push("");
    return header.join("\n");
  }

  const body = messages
    .map((message) => {
      const blocks: string[] = [];
      blocks.push(`## ${roleHeading(message.role)} · ${formatStamp(message.createdAt)}`);
      if (message.queued) {
        blocks.push("(queued)");
      }
      const attachmentBlock = formatAttachments(message);
      if (attachmentBlock) {
        blocks.push(attachmentBlock);
      }
      const parts = message.parts
        .map((part) => formatPart(part))
        .filter((text) => Boolean(text && text.trim()));
      if (parts.length === 0) {
        blocks.push("(no content)");
      } else {
        blocks.push(parts.join("\n\n"));
      }
      return blocks.join("\n\n");
    })
    .join("\n\n---\n\n");

  return `${header.join("\n")}${body}\n`;
}

export function suggestExportFileName(title?: string, sessionId?: string): string {
  const raw = (title || "omp-session").trim() || "omp-session";
  const slug = raw
    .replace(/[^\w\s.-]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .toLowerCase();
  const id = sessionId?.trim().slice(0, 8);
  const base = slug || "omp-session";
  return id ? `${base}-${id}.txt` : `${base}.txt`;
}
