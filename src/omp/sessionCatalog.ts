import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

export interface OmpHistorySession {
  id: string;
  /** Display title (generated title or first user prompt). */
  title: string;
  /** First user message preview, if any. */
  preview?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  filePath: string;
}

function agentRoot(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".omp", "agent");
}

/** omp stores workspace sessions under sessions/<encoded-cwd>/ */
export function encodeSessionDirName(cwd: string): string {
  const home = os.homedir();
  const resolved = path.resolve(cwd);
  const rel =
    resolved === home || resolved.startsWith(home + path.sep)
      ? path.relative(home, resolved)
      : resolved;
  return `-${rel.split(path.sep).filter(Boolean).join("-")}`;
}

function sameCwd(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return a === b;
  }
}

function cleanTitle(text: string, max = 48): string {
  let next = text
    .replace(/@[^\n]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!next) {
    return "New chat";
  }
  if (next.length > max) {
    next = `${next.slice(0, max)}…`;
  }
  return next;
}

function textFromUserContent(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
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
  return texts.length ? texts.join("\n") : undefined;
}

async function readSessionMeta(
  filePath: string,
): Promise<Omit<OmpHistorySession, "filePath"> | undefined> {
  const stat = await fs.promises.stat(filePath);
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let id = "";
  let cwd = "";
  let title = "";
  let preview = "";
  let createdAt = stat.mtimeMs;
  let updatedAt = stat.mtimeMs;
  let lines = 0;

  try {
    for await (const line of rl) {
      lines += 1;
      if (!line.trim()) {
        continue;
      }
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const type = String(row.type ?? "");
      if (type === "title") {
        if (typeof row.title === "string" && row.title.trim()) {
          title = row.title.trim();
        }
        if (typeof row.updatedAt === "string") {
          const parsed = Date.parse(row.updatedAt);
          if (!Number.isNaN(parsed)) {
            updatedAt = Math.max(updatedAt, parsed);
          }
        }
      } else if (type === "session") {
        if (typeof row.id === "string" && row.id.trim()) {
          id = row.id.trim();
        }
        if (typeof row.cwd === "string") {
          cwd = row.cwd;
        }
        if (typeof row.timestamp === "string") {
          const parsed = Date.parse(row.timestamp);
          if (!Number.isNaN(parsed)) {
            createdAt = parsed;
            updatedAt = Math.max(updatedAt, parsed);
          }
        }
      } else if (type === "message" && !preview) {
        const message = row.message as Record<string, unknown> | undefined;
        if (message?.role === "user") {
          const text = textFromUserContent(message.content);
          if (text) {
            preview = text;
          }
        }
      } else if (typeof row.timestamp === "string") {
        const parsed = Date.parse(row.timestamp);
        if (!Number.isNaN(parsed)) {
          updatedAt = Math.max(updatedAt, parsed);
        }
      }

      // Enough metadata once we have id + (title or first user prompt).
      if (id && (title || preview) && lines >= 8) {
        break;
      }
      if (lines >= 80) {
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!id) {
    const base = path.basename(filePath, ".jsonl");
    const underscored = base.match(/_([0-9a-f-]{20,})$/i);
    if (underscored?.[1]) {
      id = underscored[1];
    }
  }
  if (!id) {
    return undefined;
  }

  const display = title || (preview ? cleanTitle(preview) : "New chat");
  return {
    id,
    title: display,
    preview: preview ? cleanTitle(preview, 80) : undefined,
    cwd,
    createdAt,
    updatedAt,
  };
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(dir, entry.name));
}

/**
 * List omp session history for a workspace cwd (newest first).
 */
export async function listOmpSessions(cwd: string): Promise<OmpHistorySession[]> {
  const sessionsRoot = path.join(agentRoot(), "sessions");
  const preferred = path.join(sessionsRoot, encodeSessionDirName(cwd));
  const dirs = new Set<string>([preferred]);

  // Also scan sibling dirs in case encoding differs; filter by session cwd.
  try {
    const entries = await fs.promises.readdir(sessionsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.add(path.join(sessionsRoot, entry.name));
      }
    }
  } catch {
    // no session root yet
  }

  const files: string[] = [];
  for (const dir of dirs) {
    files.push(...(await listJsonlFiles(dir)));
  }

  const metas = await Promise.all(
    files.map(async (filePath) => {
      const meta = await readSessionMeta(filePath);
      if (!meta) {
        return undefined;
      }
      if (meta.cwd && !sameCwd(meta.cwd, cwd)) {
        return undefined;
      }
      // Prefer exact-dir matches when cwd is missing from older files.
      if (!meta.cwd && path.dirname(filePath) !== preferred) {
        return undefined;
      }
      return { ...meta, filePath } satisfies OmpHistorySession;
    }),
  );

  const results: OmpHistorySession[] = [];
  const seen = new Set<string>();
  for (const entry of metas) {
    if (!entry || seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    results.push(entry);
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

export function formatSessionWhen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return "";
  }
  const delta = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) {
    return "just now";
  }
  if (delta < hour) {
    const n = Math.floor(delta / minute);
    return `${n}m ago`;
  }
  if (delta < day) {
    const n = Math.floor(delta / hour);
    return `${n}h ago`;
  }
  if (delta < 7 * day) {
    const n = Math.floor(delta / day);
    return `${n}d ago`;
  }
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
