import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const LOG_FILE_NAME = "error-log.jsonl";

type LogLevel = "ERROR" | "WARN";

interface LogEntry {
  ts: number;
  level: LogLevel;
  message: string;
  detail?: string;
}

let channel: vscode.OutputChannel | undefined;
let logFilePath: string | undefined;
let ready = false;
let writing = Promise.resolve();

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("OMP Chat Log");
  }
  return channel;
}

function stamp(ts = Date.now()): string {
  return new Date(ts).toISOString();
}

function formatEntry(entry: LogEntry): string {
  const detail = entry.detail?.trim() ? `\n${entry.detail.trim()}` : "";
  return `[${stamp(entry.ts)}] ${entry.level} ${entry.message}${detail}`;
}

function serializeEntry(entry: LogEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

function parseLine(line: string): LogEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const row = JSON.parse(trimmed) as Partial<LogEntry>;
    if (
      typeof row.ts !== "number" ||
      !Number.isFinite(row.ts) ||
      (row.level !== "ERROR" && row.level !== "WARN") ||
      typeof row.message !== "string" ||
      !row.message.trim()
    ) {
      return undefined;
    }
    return {
      ts: row.ts,
      level: row.level,
      message: row.message,
      detail: typeof row.detail === "string" && row.detail.trim() ? row.detail : undefined,
    };
  } catch {
    return undefined;
  }
}

function pruneEntries(entries: LogEntry[], now = Date.now()): LogEntry[] {
  const cutoff = now - RETENTION_MS;
  return entries.filter((entry) => entry.ts >= cutoff).slice(-MAX_ENTRIES);
}

function errDetail(err: unknown): string | undefined {
  if (err == null) {
    return undefined;
  }
  if (err instanceof Error) {
    return err.stack?.trim() || err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err, null, 2);
  } catch {
    return String(err);
  }
}

async function ensureStorageDir(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

async function readEntries(filePath: string): Promise<LogEntry[]> {
  try {
    const text = await fs.promises.readFile(filePath, "utf8");
    const entries: LogEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
      const entry = parseLine(line);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      getChannel().appendLine(
        `[${stamp()}] WARN Failed to read error log file: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return [];
  }
}

async function writeEntries(filePath: string, entries: LogEntry[]): Promise<void> {
  await ensureStorageDir(filePath);
  if (entries.length === 0) {
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }
    return;
  }
  const body = entries.map(serializeEntry).join("");
  await fs.promises.writeFile(filePath, body, "utf8");
}

function replay(entries: LogEntry[]): void {
  const out = getChannel();
  out.clear();
  if (entries.length === 0) {
    out.appendLine(
      `[${stamp()}] INFO OMP Chat error log is empty (entries older than 7 days are auto-cleared).`,
    );
    return;
  }
  out.appendLine(
    `[${stamp()}] INFO Loaded ${entries.length} log entr${entries.length === 1 ? "y" : "ies"} (auto-clears after 7 days).`,
  );
  for (const entry of entries) {
    out.appendLine(formatEntry(entry));
  }
}

function enqueue(task: () => Promise<void>): void {
  writing = writing.then(task).catch((err) => {
    getChannel().appendLine(
      `[${stamp()}] WARN Error log write failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

async function appendEntry(entry: LogEntry): Promise<void> {
  if (!logFilePath) {
    getChannel().appendLine(formatEntry(entry));
    return;
  }
  const existing = await readEntries(logFilePath);
  const next = pruneEntries([...existing, entry]);
  await writeEntries(logFilePath, next);
  getChannel().appendLine(formatEntry(entry));
}

function log(level: LogLevel, message: string, err?: unknown): void {
  const entry: LogEntry = {
    ts: Date.now(),
    level,
    message: String(message || "Unknown error").trim() || "Unknown error",
    detail: errDetail(err),
  };
  if (!ready) {
    getChannel().appendLine(formatEntry(entry));
    return;
  }
  enqueue(async () => {
    await appendEntry(entry);
  });
}

export function initErrorLog(context: vscode.ExtensionContext): void {
  logFilePath = path.join(context.globalStorageUri.fsPath, LOG_FILE_NAME);
  ready = true;
  enqueue(async () => {
    if (!logFilePath) {
      return;
    }
    const entries = pruneEntries(await readEntries(logFilePath));
    await writeEntries(logFilePath, entries);
    replay(entries);
  });
}

export function logError(message: string, err?: unknown): void {
  log("ERROR", message, err);
}

export function logWarn(message: string, err?: unknown): void {
  log("WARN", message, err);
}

export function showErrorLog(): void {
  getChannel().show(true);
}

export async function clearErrorLog(): Promise<void> {
  enqueue(async () => {
    if (logFilePath) {
      await writeEntries(logFilePath, []);
    }
    replay([]);
  });
  await writing;
}

export function disposeErrorLog(): void {
  channel?.dispose();
  channel = undefined;
  logFilePath = undefined;
  ready = false;
  writing = Promise.resolve();
}
