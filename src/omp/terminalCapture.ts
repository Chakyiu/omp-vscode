import * as vscode from "vscode";

export interface CapturedTerminalCommand {
  id: string;
  terminalName: string;
  command: string;
  cwd?: string;
  output: string;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
}

const MAX_ENTRIES = 30;
const MAX_OUTPUT_CHARS = 120_000;

/** Strip CSI/OSC and other common terminal escape sequences. */
export function stripAnsi(input: string): string {
  return String(input || "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "");
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  const keep = MAX_OUTPUT_CHARS - 80;
  return `${text.slice(0, keep)}\n\n…[truncated ${text.length - keep} chars]`;
}

type ActiveCapture = {
  id: string;
  terminalName: string;
  command: string;
  cwd?: string;
  startedAt: number;
  chunks: string[];
  done: boolean;
};

/**
 * Captures recent integrated-terminal command output via shell integration.
 * Requires VS Code shell integration (enabled by default for bash/zsh/pwsh/fish).
 */
export class TerminalCaptureService implements vscode.Disposable {
  private readonly entries: CapturedTerminalCommand[] = [];
  private readonly active = new Map<object, ActiveCapture>();
  private readonly disposables: vscode.Disposable[] = [];
  private seq = 0;
  private started = false;

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    const win = vscode.window as typeof vscode.window & {
      onDidStartTerminalShellExecution?: vscode.Event<{
        terminal: vscode.Terminal;
        execution: {
          commandLine?: { value?: string };
          cwd?: vscode.Uri;
          read(): AsyncIterable<string>;
        };
      }>;
      onDidEndTerminalShellExecution?: vscode.Event<{
        terminal: vscode.Terminal;
        execution: object;
        exitCode?: number;
      }>;
    };

    if (!win.onDidStartTerminalShellExecution || !win.onDidEndTerminalShellExecution) {
      return;
    }

    this.disposables.push(
      win.onDidStartTerminalShellExecution((event) => {
        const command = String(event.execution.commandLine?.value || "").trim();
        if (!command) {
          return;
        }
        const id = `term-${Date.now()}-${++this.seq}`;
        const capture: ActiveCapture = {
          id,
          terminalName: event.terminal.name || "Terminal",
          command,
          cwd: event.execution.cwd?.fsPath,
          startedAt: Date.now(),
          chunks: [],
          done: false,
        };
        this.active.set(event.execution, capture);

        void (async () => {
          try {
            for await (const chunk of event.execution.read()) {
              if (capture.done) {
                break;
              }
              capture.chunks.push(String(chunk || ""));
              // Soft cap while streaming so a runaway command can't blow memory.
              const joined = capture.chunks.join("");
              if (joined.length > MAX_OUTPUT_CHARS * 2) {
                capture.chunks = [joined.slice(-MAX_OUTPUT_CHARS)];
              }
            }
          } catch {
            // Terminal may dispose mid-read; keep whatever we captured.
          }
        })();
      }),
    );

    this.disposables.push(
      win.onDidEndTerminalShellExecution((event) => {
        const capture = this.active.get(event.execution);
        if (!capture) {
          return;
        }
        this.active.delete(event.execution);
        capture.done = true;
        const raw = capture.chunks.join("");
        const output = truncateOutput(stripAnsi(raw).trimEnd());
        this.entries.unshift({
          id: capture.id,
          terminalName: capture.terminalName,
          command: capture.command,
          cwd: capture.cwd,
          output,
          exitCode: event.exitCode,
          startedAt: capture.startedAt,
          endedAt: Date.now(),
        });
        if (this.entries.length > MAX_ENTRIES) {
          this.entries.length = MAX_ENTRIES;
        }
      }),
    );
  }

  getRecent(limit = 20): CapturedTerminalCommand[] {
    return this.entries.slice(0, Math.max(1, limit));
  }

  getLastForActiveTerminal(): CapturedTerminalCommand | undefined {
    const activeName = vscode.window.activeTerminal?.name;
    if (activeName) {
      const match = this.entries.find((item) => item.terminalName === activeName);
      if (match) {
        return match;
      }
    }
    return this.entries[0];
  }

  formatEntry(entry: CapturedTerminalCommand): string {
    const lines = [`Terminal: ${entry.terminalName}`, `Command: ${entry.command}`];
    if (entry.cwd) {
      lines.push(`Cwd: ${entry.cwd}`);
    }
    if (entry.exitCode != null) {
      lines.push(`Exit code: ${entry.exitCode}`);
    }
    lines.push("", entry.output || "(no output captured)");
    return lines.join("\n");
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.active.clear();
    this.entries.length = 0;
    this.started = false;
  }
}

export const terminalCapture = new TerminalCaptureService();
