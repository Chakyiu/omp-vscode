import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import type { AssistantMessageEvent, OmpClientOptions, OmpRpcEvent } from "./types";

export interface OmpRpcClientEvents {
  ready: [];
  event: [OmpRpcEvent];
  messageUpdate: [AssistantMessageEvent];
  stderr: [string];
  exit: [number | null];
  error: [Error];
}

export class OmpRpcClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private started = false;
  private ready = false;

  constructor(private readonly options: OmpClientOptions) {
    super();
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isRunning(): boolean {
    return Boolean(this.proc && !this.proc.killed);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    const args = ["--mode", "rpc", "--cwd", this.options.cwd];
    if (this.options.model) {
      args.push("--model", this.options.model);
    }
    if (this.options.thinking) {
      args.push("--thinking", this.options.thinking);
    }
    if (this.options.approvalMode) {
      args.push("--approval-mode", this.options.approvalMode);
    }
    if (this.options.autoApprove) {
      args.push("--auto-approve");
    }
    if (this.options.continueLastSession) {
      args.push("--continue");
    }
    if (this.options.extraArgs?.length) {
      args.push(...this.options.extraArgs);
    }

    this.proc = spawn(this.options.ompPath, args, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });

    this.proc.on("exit", (code) => {
      this.ready = false;
      this.emit("exit", code);
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let event: OmpRpcEvent;
      try {
        event = JSON.parse(trimmed) as OmpRpcEvent;
      } catch {
        this.emit("stderr", `Non-JSON stdout: ${trimmed.slice(0, 200)}`);
        return;
      }

      if (event.type === "ready") {
        this.ready = true;
        this.emit("ready");
      }

      if (event.type === "message_update") {
        const assistantEvent =
          (event.assistantMessageEvent as AssistantMessageEvent | undefined) ??
          (event.event as AssistantMessageEvent | undefined);
        if (assistantEvent) {
          this.emit("messageUpdate", assistantEvent);
        }
      }

      this.emit("event", event);
    });

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        this.emit("stderr", text);
      }
    });

    await this.waitForReady(20_000);
  }

  private waitForReady(timeoutMs: number): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`omp exited before ready (code ${code ?? "null"})`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for omp RPC ready"));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.off("ready", onReady);
        this.off("error", onError);
        this.off("exit", onExit);
      };

      this.on("ready", onReady);
      this.on("error", onError);
      this.on("exit", onExit);
    });
  }

  send(command: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) {
      throw new Error("omp RPC process is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(command)}\n`);
  }

  prompt(message: string): void {
    this.send({ type: "prompt", message });
  }

  abort(): void {
    try {
      this.send({ type: "abort" });
    } catch {
      // ignore if process already gone
    }
  }

  async dispose(): Promise<void> {
    if (!this.proc) {
      return;
    }
    try {
      this.send({ type: "shutdown" });
    } catch {
      // ignore
    }
    const proc = this.proc;
    this.proc = undefined;
    this.ready = false;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGTERM");
        }
        resolve();
      }, 800);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
