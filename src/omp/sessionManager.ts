import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { OmpRpcClient } from "./rpcClient";
import type {
  Attachment,
  ChatMessage,
  MessagePart,
  OmpClientOptions,
  OmpRpcEvent,
  SessionStatus,
  ToolCallPart,
} from "./types";

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

export class SessionManager {
  private client: OmpRpcClient | undefined;
  private status: SessionStatus = { state: "stopped" };
  private messages: ChatMessage[] = [];
  private attachments: Attachment[] = [];
  private currentAssistantId: string | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly getWorkspaceCwd: () => string) {}

  getStatus(): SessionStatus {
    return this.status;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  getAttachments(): Attachment[] {
    return this.attachments;
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this._onDidChange.fire();
  }

  private notify(): void {
    this._onDidChange.fire();
  }

  private readConfig(overrides?: Partial<OmpClientOptions>): OmpClientOptions {
    const cfg = vscode.workspace.getConfiguration("ompChat");
    return {
      ompPath: cfg.get<string>("ompPath", "omp") || "omp",
      cwd: this.getWorkspaceCwd(),
      model: cfg.get<string>("model", "") || undefined,
      thinking: cfg.get<string>("thinking", "") || undefined,
      approvalMode: cfg.get<string>("approvalMode", "") || undefined,
      autoApprove: cfg.get<boolean>("autoApprove", false),
      continueLastSession: cfg.get<boolean>("continueLastSession", false),
      extraArgs: cfg.get<string[]>("extraArgs", []),
      ...overrides,
    };
  }

  async ensureStarted(): Promise<void> {
    if (this.client?.isRunning && this.client.isReady) {
      return;
    }
    await this.start();
  }

  async start(overrides?: Partial<OmpClientOptions>): Promise<void> {
    await this.disposeClient();
    this.setStatus({ state: "starting", detail: "Launching omp…" });

    const options = this.readConfig(overrides);
    const client = new OmpRpcClient(options);
    this.client = client;

    client.on("ready", () => {
      this.setStatus({ state: "ready", detail: "Connected to omp" });
    });

    client.on("error", (err) => {
      this.setStatus({ state: "error", detail: err.message });
    });

    client.on("exit", (code) => {
      if (this.status.state !== "stopped") {
        this.setStatus({
          state: "error",
          detail: `omp exited (code ${code ?? "null"})`,
        });
      }
    });

    client.on("stderr", (line) => {
      // Surface interesting failures without spamming every line.
      if (/error|fail|not found|ENOENT/i.test(line)) {
        this.setStatus({ state: "error", detail: line.slice(0, 240) });
      }
    });

    client.on("event", (event) => this.handleEvent(event));

    try {
      await client.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({
        state: "error",
        detail: `${message}. Is omp installed and on PATH?`,
      });
      throw err;
    }
  }

  async restart(): Promise<void> {
    await this.start();
  }

  async newChat(): Promise<void> {
    if (this.status.state === "busy") {
      this.abort();
    }
    this.messages = [];
    this.currentAssistantId = undefined;
    this.attachments = [];
    this.notify();
    // Always start a fresh session for New Chat.
    await this.start({ continueLastSession: false });
  }

  addAttachment(attachment: Omit<Attachment, "id"> & { id?: string }): void {
    const next: Attachment = {
      id: attachment.id ?? randomUUID(),
      kind: attachment.kind ?? (attachment.content ? "text" : "file"),
      label: attachment.label,
      fsPath: attachment.fsPath,
      path: attachment.path,
      language: attachment.language,
      content: attachment.content,
      mimeType: attachment.mimeType,
      previewDataUrl: attachment.previewDataUrl,
      size: attachment.size,
    };
    this.attachments = [
      ...this.attachments.filter((a) => {
        if (next.fsPath && a.fsPath) {
          return a.fsPath !== next.fsPath;
        }
        if (next.path && a.path && next.kind === a.kind) {
          return a.path !== next.path;
        }
        return a.id !== next.id;
      }),
      next,
    ];
    this.notify();
  }

  removeAttachment(id: string): void {
    this.attachments = this.attachments.filter((a) => a.id !== id);
    this.notify();
  }

  clearAttachments(): void {
    this.attachments = [];
    this.notify();
  }

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && this.attachments.length === 0) {
      return;
    }

    await this.ensureStarted();
    if (!this.client?.isReady) {
      throw new Error("omp session is not ready");
    }

    const composed = this.composePrompt(trimmed);
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      createdAt: Date.now(),
      parts: [{ kind: "text", text: composed }],
    };
    this.messages = [...this.messages, userMessage];
    this.attachments = [];
    this.currentAssistantId = undefined;
    this.setStatus({ state: "busy", detail: "Generating…" });
    this.notify();

    this.client.prompt(composed);
  }

  abort(): void {
    this.client?.abort();
    if (this.currentAssistantId) {
      this.patchMessage(this.currentAssistantId, (msg) => ({
        ...msg,
        streaming: false,
      }));
    }
    if (this.status.state === "busy") {
      this.setStatus({ state: "ready", detail: "Stopped" });
    }
  }

  private composePrompt(userText: string): string {
    if (this.attachments.length === 0) {
      return userText;
    }

    const mentions: string[] = [];
    const blocks: string[] = [];

    for (const att of this.attachments) {
      // Selections / inline text must stay embedded; @path would attach the whole file.
      if (
        (att.kind === "selection" || att.kind === "text") &&
        att.content != null &&
        att.content !== ""
      ) {
        const fence = att.language || "";
        const header = att.path ? `File: ${att.path}` : att.label;
        blocks.push(`${header}\n\`\`\`${fence}\n${att.content}\n\`\`\``);
        continue;
      }

      // Prefer omp @path file mentions for real filesystem paths (files, folders, images).
      if (att.fsPath) {
        mentions.push(`@${att.fsPath}`);
        continue;
      }

      if (att.content != null && att.content !== "") {
        const fence = att.language || "";
        const header = att.path ? `File: ${att.path}` : att.label;
        blocks.push(`${header}\n\`\`\`${fence}\n${att.content}\n\`\`\``);
      } else if (att.path) {
        mentions.push(`@${att.path}`);
      }
    }

    const parts: string[] = [];
    if (userText) {
      parts.push(userText);
    }
    if (mentions.length) {
      // Trailing mentions keep the user text readable while still triggering omp fileMention.
      parts.push(mentions.join(" "));
    }
    if (blocks.length) {
      parts.push(blocks.join("\n\n"));
    }
    return parts.join("\n\n");
  }

  private ensureAssistantMessage(): ChatMessage {
    if (this.currentAssistantId) {
      const existing = this.messages.find((m) => m.id === this.currentAssistantId);
      if (existing) {
        return existing;
      }
    }
    const msg: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      createdAt: Date.now(),
      streaming: true,
      parts: [],
    };
    this.currentAssistantId = msg.id;
    this.messages = [...this.messages, msg];
    return msg;
  }

  private patchMessage(id: string, update: (msg: ChatMessage) => ChatMessage): void {
    this.messages = this.messages.map((m) => (m.id === id ? update(m) : m));
    this.notify();
  }

  private updateAssistant(mutator: (parts: MessagePart[]) => MessagePart[]): void {
    const msg = this.ensureAssistantMessage();
    this.patchMessage(msg.id, (current) => ({
      ...current,
      streaming: true,
      parts: mutator([...current.parts]),
    }));
  }

  private appendText(kind: "text" | "thinking", delta: string): void {
    if (!delta) {
      return;
    }
    this.updateAssistant((parts) => {
      const last = parts[parts.length - 1];
      if (last && last.kind === kind) {
        parts[parts.length - 1] = { ...last, text: last.text + delta };
        return parts;
      }
      parts.push({ kind, text: delta });
      return parts;
    });
  }

  private upsertTool(partial: Partial<ToolCallPart> & { id: string; name?: string }): void {
    this.updateAssistant((parts) => {
      const idx = parts.findIndex((p) => p.kind === "tool" && p.id === partial.id);
      if (idx >= 0) {
        const current = parts[idx] as ToolCallPart;
        parts[idx] = {
          ...current,
          ...partial,
          kind: "tool",
          id: partial.id,
          name: partial.name ?? current.name,
          status: partial.status ?? current.status,
        };
        return parts;
      }
      parts.push({
        kind: "tool",
        id: partial.id,
        name: partial.name ?? "tool",
        status: partial.status ?? "running",
        inputPreview: partial.inputPreview,
        outputPreview: partial.outputPreview,
      });
      return parts;
    });
  }

  private handleEvent(event: OmpRpcEvent): void {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        this.setStatus({ state: "busy", detail: "Generating…" });
        break;
      case "message_update": {
        const ev =
          (event.assistantMessageEvent as Record<string, unknown> | undefined) ??
          (event.event as Record<string, unknown> | undefined);
        if (!ev) {
          return;
        }
        this.handleAssistantEvent(ev);
        break;
      }
      case "tool_execution_start": {
        const id = String(event.toolCallId ?? event.id ?? randomUUID());
        const name = String(event.toolName ?? event.name ?? "tool");
        this.upsertTool({
          id,
          name,
          status: "running",
          inputPreview: preview(event.args ?? event.input),
        });
        break;
      }
      case "tool_execution_update": {
        const id = String(event.toolCallId ?? event.id ?? "");
        if (!id) {
          return;
        }
        this.upsertTool({
          id,
          status: "running",
          outputPreview: preview(event.result ?? event.output ?? event.partialResult),
        });
        break;
      }
      case "tool_execution_end": {
        const id = String(event.toolCallId ?? event.id ?? "");
        if (!id) {
          return;
        }
        const failed = Boolean(event.isError ?? event.error);
        this.upsertTool({
          id,
          status: failed ? "error" : "done",
          outputPreview: preview(event.result ?? event.output ?? event.error),
        });
        break;
      }
      case "turn_end":
      case "agent_end":
        if (this.currentAssistantId) {
          this.patchMessage(this.currentAssistantId, (msg) => ({
            ...msg,
            streaming: false,
          }));
        }
        this.currentAssistantId = undefined;
        this.setStatus({ state: "ready", detail: "Ready" });
        break;
      case "prompt_error":
      case "error": {
        const message = String(event.error ?? event.message ?? "Unknown omp error");
        this.messages = [
          ...this.messages,
          {
            id: randomUUID(),
            role: "system",
            createdAt: Date.now(),
            parts: [{ kind: "text", text: message }],
          },
        ];
        this.setStatus({ state: "error", detail: message });
        break;
      }
      default:
        break;
    }
  }

  private handleAssistantEvent(ev: Record<string, unknown>): void {
    const type = String(ev.type ?? "");
    switch (type) {
      case "text_delta":
        this.appendText("text", String(ev.delta ?? ""));
        break;
      case "thinking_delta":
        this.appendText("thinking", String(ev.delta ?? ""));
        break;
      case "toolcall_start":
      case "tool_call_start":
      case "toolCall_start": {
        const id = String(ev.toolCallId ?? ev.id ?? randomUUID());
        const name = String(ev.toolName ?? ev.name ?? "tool");
        this.upsertTool({
          id,
          name,
          status: "running",
          inputPreview: preview(ev.args ?? ev.input),
        });
        break;
      }
      case "toolcall_delta":
      case "tool_call_delta":
        // Argument streaming ignored for UI brevity.
        break;
      case "toolcall_end":
      case "tool_call_end": {
        const id = String(ev.toolCallId ?? ev.id ?? "");
        if (!id) {
          return;
        }
        this.upsertTool({
          id,
          status: ev.error ? "error" : "done",
          outputPreview: preview(ev.result ?? ev.error),
        });
        break;
      }
      default:
        break;
    }
  }

  async dispose(): Promise<void> {
    await this.disposeClient();
    this.setStatus({ state: "stopped" });
    this._onDidChange.dispose();
  }

  private async disposeClient(): Promise<void> {
    if (!this.client) {
      return;
    }
    const client = this.client;
    this.client = undefined;
    await client.dispose();
  }
}
