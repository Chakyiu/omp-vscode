import * as vscode from "vscode";

const MUTATING_TOOL_RE =
  /^(edit|write|delete|hashline|apply_patch|strreplace|search_replace|write_file|delete_file|notebook|create_artifact)$/i;

let channel: vscode.OutputChannel | undefined;
const started = new Set<string>();

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration("ompChat").get<boolean>("logFileTouches", true);
}

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("OMP File Touches");
  }
  return channel;
}

export function isMutatingToolName(name: string): boolean {
  const leaf = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/^.*(?:mcp__|__|\/)/, "")
    .replace(/^mcp[_-]*/, "");
  return MUTATING_TOOL_RE.test(leaf) || MUTATING_TOOL_RE.test(String(name || "").trim());
}

export function showToolFileLog(): void {
  getChannel().show(true);
}

export function disposeToolFileLog(): void {
  channel?.dispose();
  channel = undefined;
  started.clear();
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function logToolFileTouch(opts: {
  id: string;
  name: string;
  paths: string[];
  status: "running" | "done" | "error";
}): void {
  if (!isEnabled()) {
    return;
  }
  if (!isMutatingToolName(opts.name)) {
    return;
  }
  const paths = [...new Set(opts.paths.map((p) => p.trim()).filter(Boolean))];
  if (paths.length === 0) {
    // Still useful to know a mutating tool ran without a recoverable path.
    if (opts.status === "running") {
      if (started.has(opts.id)) {
        return;
      }
      started.add(opts.id);
      getChannel().appendLine(`[${stamp()}] ${opts.name}  (path unknown)`);
    }
    return;
  }

  if (opts.status === "running") {
    if (started.has(opts.id)) {
      return;
    }
    started.add(opts.id);
    for (const path of paths) {
      getChannel().appendLine(`[${stamp()}] ${opts.name}  ${path}`);
    }
    return;
  }

  started.delete(opts.id);
  const tag = opts.status === "error" ? "ERR" : "OK";
  for (const path of paths) {
    getChannel().appendLine(`[${stamp()}] ${tag} ${opts.name}  ${path}`);
  }
}
