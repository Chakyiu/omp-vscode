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

interface PendingRequest {
  resolve: (event: OmpRpcEvent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OmpRpcClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private started = false;
  private ready = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

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
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`omp exited (code ${code ?? "null"})`));
        this.pending.delete(id);
      }
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

      if (event.type === "response" && event.id != null) {
        const id = Number(event.id);
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.resolve(event);
        }
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

  request(command: Record<string, unknown>, timeoutMs = 10_000): Promise<OmpRpcEvent> {
    if (!this.proc?.stdin.writable) {
      return Promise.reject(new Error("omp RPC process is not running"));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${String(command.type)} response`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...command, id });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async getState(): Promise<Record<string, unknown>> {
    const response = await this.request({ type: "get_state" });
    if (response.success === false) {
      throw new Error(String(response.error ?? "get_state failed"));
    }
    return (response.data as Record<string, unknown>) ?? {};
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
