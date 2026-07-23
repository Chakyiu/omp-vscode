import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { OmpRpcClient } from "./rpcClient";
import { chatMessagesFromOmp } from "./sessionHistory";
import type {
  Attachment,
  ChatMessage,
  ContextUsage,
  MessagePart,
  OmpClientOptions,
  OmpRpcEvent,
  SessionModelInfo,
  SessionStatus,
  ToolCallPart,
} from "./types";

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

export interface SessionIdStore {
  get(): string | undefined;
  set(id: string | undefined): void;
}

export class SessionManager {
  private client: OmpRpcClient | undefined;
  private status: SessionStatus = { state: "stopped" };
  private messages: ChatMessage[] = [];
  private attachments: Attachment[] = [];
  private currentAssistantId: string | undefined;
  private contextUsage: ContextUsage | null = null;
  private sessionModel: SessionModelInfo | null = null;
  private sessionId: string | undefined;
  private restoringHistory = false;
  /** Prompts waiting for the current turn to finish before being sent. */
  private pendingPrompts: Array<{ id: string; composed: string }> = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly getWorkspaceCwd: () => string,
    private readonly sessionIdStore?: SessionIdStore,
  ) {}

  getStatus(): SessionStatus {
    return this.status;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  getAttachments(): Attachment[] {
    return this.attachments;
  }

  getContextUsage(): ContextUsage | null {
    return this.contextUsage;
  }

  getSessionModel(): SessionModelInfo | null {
    return this.sessionModel;
  }

  getModelLabel(): string {
    if (this.sessionModel?.name) {
      return this.sessionModel.name;
    }
    if (this.sessionModel?.id) {
      return this.sessionModel.id;
    }
    const cfgModel = vscode.workspace.getConfiguration("ompChat").get<string>("model", "");
    return cfgModel && cfgModel.trim() ? cfgModel.trim() : "Model";
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

  async ensureStarted(options?: Partial<OmpClientOptions>): Promise<void> {
    if (this.client?.isRunning && this.client.isReady) {
      return;
    }
    await this.start(options ?? this.defaultStartOptions());
  }

  private defaultStartOptions(): Partial<OmpClientOptions> {
    const continueEnabled = vscode.workspace
      .getConfiguration("ompChat")
      .get<boolean>("continueLastSession", true);
    if (!continueEnabled) {
      return { continueLastSession: false, resumeSessionId: undefined };
    }
    const saved = this.sessionId ?? this.sessionIdStore?.get();
    if (saved) {
      // Prefer exact resume so a VS Code kill still restores the same session.
      return { resumeSessionId: saved, continueLastSession: false };
    }
    return { continueLastSession: true };
  }

  async start(overrides?: Partial<OmpClientOptions>): Promise<void> {
    await this.disposeClient();
    this.pendingPrompts = [];
    this.setStatus({ state: "starting", detail: "Launching omp…" });

    const options = this.readConfig(overrides);
    const client = new OmpRpcClient(options);
    this.client = client;

    client.on("ready", () => {
      this.setStatus({ state: "ready", detail: "Connected to omp" });
      void this.onSessionReady(options);
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
    const resumeId = this.sessionId ?? this.sessionIdStore?.get();
    if (resumeId) {
      await this.start({ resumeSessionId: resumeId, continueLastSession: false });
      return;
    }
    await this.start(this.defaultStartOptions());
  }

  async newChat(): Promise<void> {
    if (this.status.state === "busy") {
      this.abort();
    }
    this.messages = [];
    this.currentAssistantId = undefined;
    this.attachments = [];
    this.pendingPrompts = [];
    this.contextUsage = null;
    this.sessionModel = null;
    this.sessionId = undefined;
    this.notify();
    // Always start a fresh session for New Chat.
    await this.start({ continueLastSession: false, resumeSessionId: undefined });
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
    const messageAttachments = this.attachments.map((att) => ({ ...att }));
    const busy = this.status.state === "busy";
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      createdAt: Date.now(),
      // Keep the typed text for display; @path mentions stay only in the omp prompt.
      parts: trimmed ? [{ kind: "text", text: trimmed }] : [],
      attachments: messageAttachments,
      queued: busy,
    };
    this.messages = [...this.messages, userMessage];
    this.attachments = [];

    if (busy) {
      this.pendingPrompts.push({ id: userMessage.id, composed });
      this.notify();
      return;
    }

    this.dispatchPrompt(composed);
  }

  abort(): void {
    this.client?.abort();
    this.clearQueuedPrompts();
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

  private dispatchPrompt(composed: string): void {
    if (!this.client?.isReady) {
      throw new Error("omp session is not ready");
    }
    this.currentAssistantId = undefined;
    this.setStatus({ state: "busy", detail: "Generating…" });
    this.notify();
    this.client.prompt(composed);
  }

  private clearQueuedPrompts(): void {
    const queuedIds = new Set(this.pendingPrompts.map((item) => item.id));
    this.pendingPrompts = [];
    const nextMessages = this.messages.filter(
      (message) => !queuedIds.has(message.id) && !message.queued,
    );
    if (nextMessages.length !== this.messages.length) {
      this.messages = nextMessages;
      this.notify();
    }
  }

  private flushQueuedPrompt(): void {
    const next = this.pendingPrompts.shift();
    if (!next) {
      return;
    }
    this.patchMessage(next.id, (msg) => ({
      ...msg,
      queued: false,
    }));
    try {
      this.dispatchPrompt(next.composed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
    }
  }

  private markTurnComplete(): void {
    // Ignore duplicate settle attempts once we have already left the busy state.
    if (this.status.state !== "busy") {
      return;
    }
    if (this.currentAssistantId) {
      this.patchMessage(this.currentAssistantId, (msg) => {
        const parts = msg.parts.map((part) => {
          if (part.kind !== "thinking") {
            return part;
          }
          if (part.streaming === false && part.endedAt) {
            return part;
          }
          return {
            ...part,
            streaming: false,
            endedAt: part.endedAt ?? Date.now(),
          };
        });
        return {
          ...msg,
          streaming: false,
          parts,
        };
      });
    }
    this.currentAssistantId = undefined;
    if (this.pendingPrompts.length > 0) {
      this.flushQueuedPrompt();
      return;
    }
    this.setStatus({ state: "ready", detail: "Ready" });
    void this.refreshSessionState();
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

  private closeOpenThinking(parts: MessagePart[]): void {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (part.kind !== "thinking") {
        continue;
      }
      if (part.streaming === false && part.endedAt) {
        break;
      }
      parts[i] = {
        ...part,
        streaming: false,
        endedAt: part.endedAt ?? Date.now(),
      };
      break;
    }
  }

  private appendText(kind: "text" | "thinking", delta: string): void {
    // Allow empty thinking_start so the UI can show a live thinking block immediately.
    if (!delta && kind !== "thinking") {
      return;
    }
    this.updateAssistant((parts) => {
      const last = parts[parts.length - 1];
      if (last && last.kind === kind) {
        if (!delta) {
          return parts;
        }
        if (last.kind === "thinking") {
          parts[parts.length - 1] = {
            ...last,
            text: last.text + delta,
            streaming: true,
            startedAt: last.startedAt ?? Date.now(),
          };
        } else {
          parts[parts.length - 1] = { ...last, text: last.text + delta };
        }
        return parts;
      }
      if (kind !== "thinking") {
        this.closeOpenThinking(parts);
      }
      if (kind === "thinking") {
        parts.push({
          kind: "thinking",
          text: delta || "",
          streaming: true,
          startedAt: Date.now(),
        });
      } else {
        parts.push({ kind: "text", text: delta || "" });
      }
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
      this.closeOpenThinking(parts);
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
          inputPreview: preview(event.args ?? event.input, 800),
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
      case "prompt_result": {
        if (event.agentInvoked === false && this.status.state === "busy") {
          this.markTurnComplete();
        }
        break;
      }
      case "response": {
        if (event.command === "prompt" && event.success === false) {
          const message = String(event.error ?? "prompt failed");
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
        if (
          event.command === "prompt" &&
          event.success !== false &&
          (event.data as Record<string, unknown> | undefined)?.agentInvoked === false &&
          this.status.state === "busy"
        ) {
          this.markTurnComplete();
        }
        break;
      }
      case "turn_end":
        // Visual end-of-turn only. Queue flush waits for agent_end so a
        // follow-up prompt isn't settled by a stale turn_end.
        if (this.currentAssistantId) {
          this.patchMessage(this.currentAssistantId, (msg) => {
            const parts = msg.parts.map((part) => {
              if (part.kind !== "thinking") {
                return part;
              }
              if (part.streaming === false && part.endedAt) {
                return part;
              }
              return {
                ...part,
                streaming: false,
                endedAt: part.endedAt ?? Date.now(),
              };
            });
            return {
              ...msg,
              streaming: false,
              parts,
            };
          });
        }
        break;
      case "agent_end":
        this.markTurnComplete();
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
      case "thinking_start":
        // Create an empty thinking part immediately so the UI can open/stream.
        this.appendText("thinking", "");
        break;
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
          inputPreview: preview(ev.args ?? ev.input, 800),
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

  private parseContextUsage(raw: unknown, fallbackWindow?: number): ContextUsage | null {
    if (!raw || typeof raw !== "object") {
      if (fallbackWindow && fallbackWindow > 0) {
        return { tokens: 0, contextWindow: fallbackWindow, percent: 0 };
      }
      return null;
    }
    const obj = raw as Record<string, unknown>;
    const tokens = Number(obj.tokens ?? obj.used ?? obj.totalTokens ?? 0);
    const contextWindow = Number(obj.contextWindow ?? obj.window ?? fallbackWindow ?? 0);
    let percent = Number(obj.percent ?? obj.percentage ?? NaN);
    if (!Number.isFinite(percent)) {
      percent = contextWindow > 0 ? (tokens / contextWindow) * 100 : 0;
    }
    // omp reports percent already on a 0-100 scale (e.g. 0.0085).
    return {
      tokens: Number.isFinite(tokens) ? tokens : 0,
      contextWindow: Number.isFinite(contextWindow) ? contextWindow : 0,
      percent: Number.isFinite(percent) ? percent : 0,
    };
  }

  private async onSessionReady(_options: OmpClientOptions): Promise<void> {
    await this.refreshSessionState();
    // After VS Code is killed, local transcript is gone — reload from omp session.
    if (this.messages.length === 0) {
      await this.hydrateMessagesFromSession();
    }
  }

  private async hydrateMessagesFromSession(): Promise<void> {
    if (!this.client?.isReady || this.restoringHistory) {
      return;
    }
    // Keep live streaming/UI state if we already have local messages.
    if (this.messages.length > 0) {
      return;
    }
    this.restoringHistory = true;
    try {
      const raw = await this.client.getMessages();
      const restored = chatMessagesFromOmp(raw);
      if (restored.length > 0) {
        this.messages = restored;
        this.currentAssistantId = undefined;
        this.notify();
      }
    } catch {
      // Non-fatal: chat can continue without restored transcript.
    } finally {
      this.restoringHistory = false;
    }
  }

  async refreshSessionState(): Promise<void> {
    if (!this.client?.isReady) {
      return;
    }
    try {
      const state = await this.client.getState();
      const sid = state.sessionId;
      if (typeof sid === "string" && sid.trim()) {
        this.sessionId = sid.trim();
        this.sessionIdStore?.set(this.sessionId);
      }
      const modelRaw = state.model;
      if (modelRaw && typeof modelRaw === "object") {
        const m = modelRaw as Record<string, unknown>;
        this.sessionModel = {
          id: String(m.id ?? m.selector ?? ""),
          name: String(m.name ?? m.id ?? "Model"),
          provider: m.provider ? String(m.provider) : undefined,
          contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
        };
      }
      const fallbackWindow =
        this.sessionModel?.contextWindow ??
        (typeof (modelRaw as { contextWindow?: number } | undefined)?.contextWindow === "number"
          ? (modelRaw as { contextWindow: number }).contextWindow
          : undefined);
      this.contextUsage = this.parseContextUsage(state.contextUsage, fallbackWindow);
      this.notify();
    } catch {
      // Non-fatal: UI can keep the last known usage.
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
