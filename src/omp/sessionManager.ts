import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { OmpRpcClient } from "./rpcClient";
import { chatMessagesFromOmp, messagesFromSessionFile } from "./sessionHistory";
import { logToolFileTouch } from "./toolFileLog";
import { collectToolFileRefs, collectToolPaths, preview } from "./toolPaths";
import type {
  Attachment,
  ChatMessage,
  ContextUsage,
  MessagePart, TextPart,
  OmpClientOptions,
  OmpRpcEvent,
  SessionModelInfo,
  SessionStatus,
  ToolCallPart,
  ToolFileRef,
  UiQuestion,
  UiQuestionMethod,
} from "./types";

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
  private sessionFile: string | undefined;
  private restoringHistory = false;
  /** Prompts waiting for the current turn to finish before being sent. */
  private pendingPrompts: Array<{ id: string; text: string; composed: string }> = [];
  /** Interactive omp extension UI questions waiting for a user answer. */
  private pendingUiQuestions: UiQuestion[] = [];
  /** Wall-clock start for the currently open thinking block. */
  private thinkingStartedAt: number | undefined;

  private uiQuestionTimers = new Map<string, ReturnType<typeof setTimeout>>();
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

  /** Oldest unanswered interactive UI question, if any. */
  getUiQuestion(): UiQuestion | null {
    return this.pendingUiQuestions[0] ?? null;
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
    this.thinkingStartedAt = undefined;
    this.clearUiQuestions({ cancelRemote: false });
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
    this.clearUiQuestions({ cancelRemote: false });
    this.contextUsage = null;
    this.sessionModel = null;
    this.sessionId = undefined;
    this.sessionFile = undefined;
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
      this.pendingPrompts.push({ id: userMessage.id, text: trimmed, composed });
      this.notify();
      return;
    }

    this.dispatchPrompt(composed);
  }

  /** Pull a queued prompt back into the composer (removes it from the queue). */
  recallQueued(id: string, textHint?: string): { text: string; attachments: Attachment[] } | undefined {
    const recalled = this.takeQueued(id, textHint);
    if (!recalled) {
      return undefined;
    }
    // Restore any attachments that were queued with the prompt.
    if (recalled.attachments.length) {
      for (const att of recalled.attachments) {
        this.attachments = [
          ...this.attachments.filter((a) => {
            if (att.id && a.id === att.id) return false;
            if (att.fsPath && a.fsPath) return a.fsPath !== att.fsPath;
            return true;
          }),
          {
            id: att.id || randomUUID(),
            kind: att.kind,
            label: att.label,
            fsPath: att.fsPath,
            path: att.path,
            language: att.language,
            content: att.content,
            mimeType: att.mimeType,
            previewDataUrl: att.previewDataUrl,
            size: att.size,
          },
        ];
      }
    }
    this.notify();
    return { text: recalled.text, attachments: recalled.attachments };
  }

  /** Discard a queued prompt without sending it. */
  removeQueued(id: string, textHint?: string): boolean {
    const removed = this.takeQueued(id, textHint);
    if (!removed) {
      return false;
    }
    this.notify();
    return true;
  }

  private takeQueued(
    id: string,
    textHint?: string,
  ): { text: string; attachments: Attachment[] } | undefined {
    const rawId = String(id || "").trim();
    const hint = String(textHint ?? "").trim();

    let pendingIdx = rawId ? this.pendingPrompts.findIndex((item) => item.id === rawId) : -1;
    let messageIdx = rawId
      ? this.messages.findIndex(
          (message) => message.id === rawId && (message.queued || pendingIdx >= 0),
        )
      : -1;

    // Optimistic webview ids (local-*) won't match host UUIDs — fall back to
    // the latest queued prompt, optionally matched by text.
    if (pendingIdx < 0 && messageIdx < 0) {
      if (hint) {
        pendingIdx = [...this.pendingPrompts]
          .map((item, idx) => ({ item, idx }))
          .reverse()
          .find((entry) => entry.item.text.trim() === hint)?.idx ?? -1;
        messageIdx = [...this.messages]
          .map((message, idx) => ({ message, idx }))
          .reverse()
          .find((entry) => {
            if (!entry.message.queued) return false;
            const text = entry.message.parts
              .filter((part): part is TextPart => part.kind === "text")
              .map((part) => part.text)
              .join("\n")
              .trim();
            return text === hint;
          })?.idx ?? -1;
      }
      if (pendingIdx < 0 && messageIdx < 0 && (rawId.startsWith("local-") || !rawId)) {
        pendingIdx = this.pendingPrompts.length ? this.pendingPrompts.length - 1 : -1;
        for (let i = this.messages.length - 1; i >= 0; i -= 1) {
          if (this.messages[i]?.queued) {
            messageIdx = i;
            break;
          }
        }
      }
    }

    if (pendingIdx < 0 && messageIdx < 0) {
      return undefined;
    }

    const pending = pendingIdx >= 0 ? this.pendingPrompts[pendingIdx] : undefined;
    const message = messageIdx >= 0 ? this.messages[messageIdx] : undefined;
    const targetId = message?.id || pending?.id || rawId;
    const textFromParts =
      message?.parts
        ?.filter((part): part is TextPart => part.kind === "text")
        .map((part) => part.text)
        .join("\n")
        .trim() ?? "";
    const text = textFromParts || pending?.text || hint || "";
    const attachments = (message?.attachments ?? []).map((att) => ({ ...att }));

    if (pending) {
      this.pendingPrompts = this.pendingPrompts.filter((item) => item.id !== pending.id);
    } else if (targetId) {
      this.pendingPrompts = this.pendingPrompts.filter((item) => item.id !== targetId);
    }
    if (message) {
      this.messages = this.messages.filter((item) => item.id !== message.id);
    } else if (targetId) {
      this.messages = this.messages.filter((item) => item.id !== targetId);
    }
    return { text, attachments };
  }

  abort(): void {
    this.client?.abort();
    this.clearQueuedPrompts();
    this.clearUiQuestions({ cancelRemote: true });
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


  private applyAssistantTimingMeta(raw: unknown): void {
    if (!raw || typeof raw !== "object" || !this.currentAssistantId) {
      return;
    }
    const message = raw as Record<string, unknown>;
    const duration = Number(message.duration);
    const ttft = Number(message.ttft);
    const hasDuration = Number.isFinite(duration) && duration > 0;
    const hasTtft = Number.isFinite(ttft) && ttft > 0;
    if (!hasDuration && !hasTtft) {
      return;
    }
    this.patchMessage(this.currentAssistantId, (msg) => {
      let firstThinking = true;
      const parts = msg.parts.map((part) => {
        if (part.kind !== "thinking") {
          return part;
        }
        const measured =
          typeof part.durationMs === "number"
            ? part.durationMs
            : part.startedAt && part.endedAt
              ? Math.max(0, part.endedAt - part.startedAt)
              : 0;
        // Providers often flush thinking in one burst, so Date.now()-based
        // timing collapses to <1s. Prefer omp ttft for the first weak block.
        // Once we already have a stable >=1s measurement, keep it so the
        // "Thought for Xs" label does not jump after the turn settles.
        let durationMs = measured;
        if (measured < 1000 && firstThinking) {
          if (hasTtft) {
            durationMs = ttft;
          } else if (hasDuration) {
            durationMs = duration;
          }
        }
        firstThinking = false;
        if (typeof part.durationMs === "number" && part.durationMs >= 1000) {
          durationMs = part.durationMs;
        }
        const startedAt = part.startedAt ?? (part.endedAt ? part.endedAt - durationMs : undefined);
        const endedAt = part.endedAt ?? (startedAt != null ? startedAt + durationMs : Date.now());
        return {
          ...part,
          streaming: false,
          startedAt,
          endedAt,
          durationMs,
        };
      });
      return { ...msg, parts };
    });
  }

  private markTurnComplete(): void {
    // Ignore duplicate settle attempts once we have already left the busy state.
    if (this.status.state !== "busy") {
      return;
    }
    if (this.currentAssistantId) {
      this.patchMessage(this.currentAssistantId, (msg) => {
        const parts = msg.parts.map((part) => {
          if (part.kind === "tool" && part.status === "running") {
            // Avoid leaving orphan spinners when omp skips/mismatches tool_execution_end.
            return {
              ...part,
              status: "done" as const,
            };
          }
          if (part.kind !== "thinking") {
            return part;
          }
          if (part.streaming === false && (part.endedAt || part.durationMs)) {
            return part;
          }
          const at = Date.now();
          const startedAt = part.startedAt ?? this.thinkingStartedAt ?? at;
          const endedAt = part.endedAt ?? at;
          const measured = Math.max(0, endedAt - startedAt);
          return {
            ...part,
            streaming: false,
            startedAt,
            endedAt,
            durationMs: part.durationMs ?? (measured >= 1000 ? measured : part.durationMs),
          };
        });
        return {
          ...msg,
          streaming: false,
          parts,
        };
      });
    }
    this.thinkingStartedAt = undefined;
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

  private closeOpenThinking(parts: MessagePart[], at = Date.now()): void {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (part.kind !== "thinking") {
        continue;
      }
      if (part.streaming === false && (part.endedAt || part.durationMs)) {
        break;
      }
      const startedAt = part.startedAt ?? this.thinkingStartedAt ?? at;
      const endedAt = part.endedAt ?? at;
      const measured = Math.max(0, endedAt - startedAt);
      const durationMs =
        part.durationMs ??
        (measured >= 1000 ? measured : undefined);
      parts[i] = {
        ...part,
        streaming: false,
        startedAt,
        endedAt,
        durationMs,
      };
      this.thinkingStartedAt = undefined;
      break;
    }
  }

  private appendText(kind: "text" | "thinking", delta: string, at = Date.now()): void {
    // Allow empty thinking_start so the UI can show a live thinking block immediately.
    if (!delta && kind !== "thinking") {
      return;
    }
    this.updateAssistant((parts) => {
      const last = parts[parts.length - 1];
      if (last && last.kind === kind) {
        if (!delta) {
          // thinking_start while a thinking block is already open — keep original start.
          if (last.kind === "thinking") {
            this.thinkingStartedAt = this.thinkingStartedAt ?? last.startedAt ?? at;
            if (last.startedAt == null) {
              parts[parts.length - 1] = {
                ...last,
                streaming: true,
                startedAt: at,
              };
            }
          }
          return parts;
        }
        if (last.kind === "thinking") {
          const startedAt = last.startedAt ?? this.thinkingStartedAt ?? at;
          this.thinkingStartedAt = this.thinkingStartedAt ?? startedAt;
          parts[parts.length - 1] = {
            ...last,
            text: last.text + delta,
            streaming: true,
            startedAt,
          };
        } else {
          parts[parts.length - 1] = { ...last, text: last.text + delta };
        }
        return parts;
      }
      if (kind !== "thinking") {
        this.closeOpenThinking(parts, at);
      }
      if (kind === "thinking") {
        this.thinkingStartedAt = at;
        parts.push({
          kind: "thinking",
          text: delta || "",
          streaming: true,
          startedAt: at,
        });
      } else {
        parts.push({ kind: "text", text: delta || "" });
      }
      return parts;
    });
  }

  private upsertTool(partial: Partial<ToolCallPart> & { id: string; name?: string }): void {
    let nextName = partial.name ?? "tool";
    let nextStatus = partial.status ?? "running";
    let nextPaths = partial.filePaths ?? [];
    let nextRefs = partial.fileRefs ?? [];
    this.updateAssistant((parts) => {
      const idx = parts.findIndex((p) => p.kind === "tool" && p.id === partial.id);
      if (idx >= 0) {
        const current = parts[idx] as ToolCallPart;
        nextName = partial.name ?? current.name;
        nextStatus = partial.status ?? current.status;
        nextRefs = partial.fileRefs ?? current.fileRefs ?? [];
        nextPaths =
          partial.filePaths ??
          (nextRefs.length ? nextRefs.map((ref) => ref.path) : current.filePaths ?? []);
        parts[idx] = {
          ...current,
          ...partial,
          kind: "tool",
          id: partial.id,
          name: nextName,
          status: nextStatus,
          filePaths: nextPaths,
          fileRefs: nextRefs,
        };
        return parts;
      }
      this.closeOpenThinking(parts);
      nextName = partial.name ?? "tool";
      nextStatus = partial.status ?? "running";
      nextRefs = partial.fileRefs ?? [];
      nextPaths = partial.filePaths ?? nextRefs.map((ref) => ref.path);
      parts.push({
        kind: "tool",
        id: partial.id,
        name: nextName,
        status: nextStatus,
        inputPreview: partial.inputPreview,
        outputPreview: partial.outputPreview,
        filePaths: nextPaths,
        fileRefs: nextRefs,
      });
      return parts;
    });
    logToolFileTouch({
      id: partial.id,
      name: nextName,
      paths: nextPaths,
      status: nextStatus,
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
        const data =
          event.data && typeof event.data === "object"
            ? (event.data as Record<string, unknown>)
            : undefined;
        const id = String(event.toolCallId ?? data?.toolCallId ?? "");
        if (!id) {
          return;
        }
        const name = String(event.toolName ?? data?.toolName ?? event.name ?? data?.name ?? "tool");
        const rawArgs = event.args ?? event.input ?? data?.args ?? data?.input;
        this.upsertTool({
          id,
          name,
          status: "running",
          inputPreview: preview(rawArgs, 800),
          fileRefs: collectToolFileRefs(rawArgs),
          filePaths: collectToolPaths(rawArgs),
        });
        break;
      }
      case "tool_execution_update": {
        const data =
          event.data && typeof event.data === "object"
            ? (event.data as Record<string, unknown>)
            : undefined;
        const id = String(event.toolCallId ?? data?.toolCallId ?? "");
        if (!id) {
          return;
        }
        this.upsertTool({
          id,
          status: "running",
          outputPreview: preview(
            event.result ?? event.output ?? event.partialResult ?? data?.result ?? data?.output,
          ),
        });
        break;
      }
      case "tool_execution_end": {
        const data =
          event.data && typeof event.data === "object"
            ? (event.data as Record<string, unknown>)
            : undefined;
        const id = String(event.toolCallId ?? data?.toolCallId ?? "");
        if (!id) {
          return;
        }
        const failed = Boolean(event.isError ?? event.error ?? data?.isError ?? data?.error);
        this.upsertTool({
          id,
          status: failed ? "error" : "done",
          outputPreview: preview(
            event.result ?? event.output ?? event.error ?? data?.result ?? data?.output ?? data?.error,
          ),
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
          const at = Date.now();
          this.patchMessage(this.currentAssistantId, (msg) => {
            const parts = [...msg.parts];
            this.closeOpenThinking(parts, at);
            return {
              ...msg,
              streaming: false,
              parts,
            };
          });
          this.applyAssistantTimingMeta(event.message);
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
      case "extension_ui_request":
        this.handleExtensionUiRequest(event);
        break;
      default:
        break;
    }
  }

  private handleAssistantEvent(ev: Record<string, unknown>): void {
    const type = String(ev.type ?? "");
    switch (type) {
      case "thinking_start":
        // Create an empty thinking part immediately so the UI can show a live thinking block.
        this.appendText("thinking", "");
        break;
      case "thinking_delta":
        this.appendText("thinking", String(ev.delta ?? ""));
        break;
      case "thinking_end": {
        const content = typeof ev.content === "string" ? ev.content : "";
        if (content) {
          // Some providers only send the full thinking payload on end.
          this.updateAssistant((parts) => {
            const last = parts[parts.length - 1];
            if (last?.kind === "thinking") {
              const startedAt = last.startedAt ?? this.thinkingStartedAt ?? Date.now();
              this.thinkingStartedAt = this.thinkingStartedAt ?? startedAt;
              parts[parts.length - 1] = {
                ...last,
                text: last.text && last.text.length >= content.length ? last.text : content,
                streaming: true,
                startedAt,
              };
              return parts;
            }
            this.thinkingStartedAt = this.thinkingStartedAt ?? Date.now();
            parts.push({
              kind: "thinking",
              text: content,
              streaming: true,
              startedAt: this.thinkingStartedAt,
            });
            return parts;
          });
        }
        this.updateAssistant((parts) => {
          this.closeOpenThinking(parts);
          return parts;
        });
        break;
      }
      case "text_delta":
        this.appendText("text", String(ev.delta ?? ""));
        break;
      case "toolcall_start":
      case "tool_call_start":
      case "toolCall_start": {
        const id = String(ev.toolCallId ?? ev.id ?? "");
        if (!id) {
          return;
        }
        const name = String(ev.toolName ?? ev.name ?? "tool");
        const rawArgs = ev.args ?? ev.input;
        this.upsertTool({
          id,
          name,
          status: "running",
          inputPreview: preview(rawArgs, 800),
          fileRefs: collectToolFileRefs(rawArgs),
          filePaths: collectToolPaths(rawArgs),
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
      let raw: unknown[] = [];
      try {
        raw = await this.client.getMessages();
      } catch {
        // Large sessions often exceed omp's 1 MiB RPC frame limit.
        raw = [];
      }

      if (raw.length === 0) {
        const sessionFile = await this.resolveSessionFile();
        if (sessionFile) {
          raw = await messagesFromSessionFile(sessionFile);
        }
      }

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

  private async resolveSessionFile(): Promise<string | undefined> {
    if (this.sessionFile?.trim()) {
      return this.sessionFile.trim();
    }
    if (!this.client?.isReady) {
      return undefined;
    }
    try {
      const state = await this.client.getState();
      const file = state.sessionFile;
      if (typeof file === "string" && file.trim()) {
        this.sessionFile = file.trim();
        return this.sessionFile;
      }
    } catch {
      // ignore
    }
    return undefined;
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
      const file = state.sessionFile;
      if (typeof file === "string" && file.trim()) {
        this.sessionFile = file.trim();
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


  answerUiQuestion(
    id: string,
    answer: { confirmed?: boolean; value?: string; cancelled?: boolean; timedOut?: boolean },
  ): void {
    const idx = this.pendingUiQuestions.findIndex((q) => q.id === id);
    if (idx < 0) {
      return;
    }
    this.clearUiQuestionTimer(id);
    this.pendingUiQuestions = this.pendingUiQuestions.filter((q) => q.id !== id);
    try {
      if (!this.client?.isReady) {
        this.notify();
        return;
      }
      if (answer.cancelled) {
        this.client.respondExtensionUi(id, {
          cancelled: true,
          ...(answer.timedOut ? { timedOut: true } : {}),
        });
      } else if (typeof answer.confirmed === "boolean") {
        this.client.respondExtensionUi(id, { confirmed: answer.confirmed });
      } else if (typeof answer.value === "string") {
        this.client.respondExtensionUi(id, { value: answer.value });
      } else {
        this.client.respondExtensionUi(id, { cancelled: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ state: "error", detail: message });
    }
    this.notify();
  }

  private handleExtensionUiRequest(event: OmpRpcEvent): void {
    const id = String(event.id ?? "").trim();
    const method = String(event.method ?? "").trim();
    if (!id || !method) {
      return;
    }

    if (method === "cancel") {
      const targetId = String(event.targetId ?? event.target_id ?? "").trim();
      if (targetId) {
        this.answerUiQuestion(targetId, { cancelled: true });
      } else {
        this.clearUiQuestions({ cancelRemote: true });
      }
      return;
    }

    if (method === "notify") {
      const message =
        String(event.message ?? event.text ?? event.title ?? "Notification").trim() ||
        "Notification";
      const notifyType = String(event.notifyType ?? event.notify_type ?? "info");
      if (notifyType === "error") {
        void vscode.window.showErrorMessage(message);
      } else if (notifyType === "warning") {
        void vscode.window.showWarningMessage(message);
      } else {
        void vscode.window.showInformationMessage(message);
      }
      return;
    }

    if (method === "open_url" || method === "openUrl") {
      const url = String(event.url ?? event.text ?? event.message ?? "").trim();
      if (url) {
        void vscode.env.openExternal(vscode.Uri.parse(url));
      }
      return;
    }

    if (method === "setStatus" || method === "set_status") {
      const detail = String(event.statusText ?? event.status_text ?? event.text ?? "").trim();
      if (detail) {
        this.setStatus({ ...this.status, detail });
      }
      return;
    }

    if (
      method === "setWidget" ||
      method === "set_widget" ||
      method === "setTitle" ||
      method === "set_title" ||
      method === "set_editor_text" ||
      method === "setEditorText"
    ) {
      // Passive terminal/editor chrome; ignore in the chat host.
      return;
    }

    if (
      method !== "select" &&
      method !== "confirm" &&
      method !== "input" &&
      method !== "editor"
    ) {
      // Unknown interactive method — cancel so omp does not hang.
      try {
        this.client?.respondExtensionUi(id, { cancelled: true });
      } catch {
        // ignore
      }
      return;
    }

    const optionsRaw = event.options;
    const options = Array.isArray(optionsRaw)
      ? optionsRaw.map((item) => String(item)).filter(Boolean)
      : undefined;
    const timeoutRaw = event.timeout;
    const timeoutMs =
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.floor(timeoutRaw)
        : undefined;

    const question: UiQuestion = {
      id,
      method: method as UiQuestionMethod,
      title: event.title != null ? String(event.title) : undefined,
      message: event.message != null ? String(event.message) : undefined,
      options,
      placeholder: event.placeholder != null ? String(event.placeholder) : undefined,
      prefill: event.prefill != null ? String(event.prefill) : undefined,
      timeoutMs,
      createdAt: Date.now(),
    };

    // Replace any existing question with the same id.
    this.clearUiQuestionTimer(id);
    this.pendingUiQuestions = [
      ...this.pendingUiQuestions.filter((q) => q.id !== id),
      question,
    ];

    if (timeoutMs) {
      const timer = setTimeout(() => {
        this.answerUiQuestion(id, { cancelled: true, timedOut: true });
      }, timeoutMs);
      this.uiQuestionTimers.set(id, timer);
    }

    this.setStatus({
      state: this.status.state === "busy" ? "busy" : this.status.state,
      detail: question.title || question.message || "Waiting for your answer…",
    });
    this.notify();
  }

  private clearUiQuestionTimer(id: string): void {
    const timer = this.uiQuestionTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.uiQuestionTimers.delete(id);
    }
  }

  private clearUiQuestions(options: { cancelRemote: boolean }): void {
    const pending = [...this.pendingUiQuestions];
    for (const question of pending) {
      this.clearUiQuestionTimer(question.id);
    }
    this.pendingUiQuestions = [];
    if (options.cancelRemote && this.client?.isReady) {
      for (const question of pending) {
        try {
          this.client.respondExtensionUi(question.id, { cancelled: true });
        } catch {
          // ignore
        }
      }
    }
    if (pending.length > 0) {
      this.notify();
    }
  }

  async dispose(): Promise<void> {
    await this.disposeClient();
    this.setStatus({ state: "stopped" });
    this._onDidChange.dispose();
  }

  private async disposeClient(): Promise<void> {
    this.clearUiQuestions({ cancelRemote: false });
    if (!this.client) {
      return;
    }
    const client = this.client;
    this.client = undefined;
    await client.dispose();
  }
}
