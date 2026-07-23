import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { SessionManager, type SessionIdStore } from "./sessionManager";
import type { Attachment, ChatMessage, ContextUsage, SessionModelInfo, SessionStatus } from "./types";

export interface ChatTabInfo {
  id: string;
  title: string;
  busy: boolean;
  status: SessionStatus["state"];
}

interface TabRecord {
  id: string;
  title: string;
  session: SessionManager;
  subscription: vscode.Disposable;
}

function titleFromMessages(messages: ChatMessage[]): string | undefined {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) {
    return undefined;
  }
  const textPart = firstUser.parts.find((p) => p.kind === "text");
  if (!textPart || textPart.kind !== "text") {
    return undefined;
  }
  let text = textPart.text
    .replace(/@[^\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return "New chat";
  }
  if (text.length > 28) {
    text = `${text.slice(0, 28)}…`;
  }
  return text;
}

export class TabManager {
  private readonly tabs = new Map<string, TabRecord>();
  private order: string[] = [];
  private activeId = "";
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly getWorkspaceCwd: () => string,
    private readonly sessionIdStore?: SessionIdStore,
  ) {
    this.createTab(true);
  }

  private notify(): void {
    this._onDidChange.fire();
  }

  private makeSession(): SessionManager {
    return new SessionManager(this.getWorkspaceCwd, this.sessionIdStore);
  }

  private syncTitle(tab: TabRecord): void {
    const next = titleFromMessages(tab.session.getMessages()) ?? "New chat";
    if (tab.title !== next) {
      tab.title = next;
    }
  }

  getActiveId(): string {
    return this.activeId;
  }

  getTabs(): ChatTabInfo[] {
    return this.order
      .map((id) => this.tabs.get(id))
      .filter((tab): tab is TabRecord => Boolean(tab))
      .map((tab) => {
        this.syncTitle(tab);
        const status = tab.session.getStatus();
        return {
          id: tab.id,
          title: tab.title,
          busy: status.state === "busy",
          status: status.state,
        };
      });
  }

  active(): SessionManager {
    const tab = this.tabs.get(this.activeId);
    if (!tab) {
      throw new Error("No active chat tab");
    }
    return tab.session;
  }

  createTab(activate = true): string {
    const id = randomUUID();
    const session = this.makeSession();
    const subscription = session.onDidChange(() => {
      const tab = this.tabs.get(id);
      if (tab) {
        this.syncTitle(tab);
      }
      // Only bubble UI updates for the active tab, plus tab title/status strip.
      this.notify();
    });
    this.tabs.set(id, { id, title: "New chat", session, subscription });
    this.order.push(id);
    if (activate || !this.activeId) {
      this.activeId = id;
    }
    this.notify();
    return id;
  }

  async switchTab(id: string): Promise<void> {
    if (!this.tabs.has(id) || this.activeId === id) {
      this.notify();
      return;
    }
    this.activeId = id;
    this.notify();
    void this.active().ensureStarted().catch(() => {
      // surfaced via status
    });
  }

  async closeTab(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) {
      return;
    }

    tab.subscription.dispose();
    await tab.session.dispose();
    this.tabs.delete(id);
    this.order = this.order.filter((item) => item !== id);

    if (this.order.length === 0) {
      this.activeId = "";
      const id = this.createTab(true);
      void this.tabs
        .get(id)
        ?.session.ensureStarted({ continueLastSession: false, resumeSessionId: undefined })
        .catch(() => undefined);
      return;
    }

    if (this.activeId === id) {
      this.activeId = this.order[this.order.length - 1] || this.order[0];
      void this.active().ensureStarted().catch(() => undefined);
    }
    this.notify();
  }

  async newChat(): Promise<void> {
    const id = this.createTab(true);
    void this.tabs
      .get(id)
      ?.session.ensureStarted({ continueLastSession: false, resumeSessionId: undefined })
      .catch(() => undefined);
  }

  async restart(): Promise<void> {
    await this.active().restart();
  }

  async ensureStarted(): Promise<void> {
    await this.active().ensureStarted();
  }

  abort(): void {
    this.active().abort();
  }

  async send(text: string): Promise<void> {
    await this.active().send(text);
  }

  addAttachment(attachment: Omit<Attachment, "id"> & { id?: string }): void {
    this.active().addAttachment(attachment);
  }

  removeAttachment(id: string): void {
    this.active().removeAttachment(id);
  }

  getStatus(): SessionStatus {
    return this.active().getStatus();
  }

  getMessages(): ChatMessage[] {
    return this.active().getMessages();
  }

  getAttachments(): Attachment[] {
    return this.active().getAttachments();
  }

  getContextUsage(): ContextUsage | null {
    return this.active().getContextUsage();
  }

  getSessionModel(): SessionModelInfo | null {
    return this.active().getSessionModel();
  }

  getModelLabel(): string {
    return this.active().getModelLabel();
  }

  async refreshSessionState(): Promise<void> {
    await this.active().refreshSessionState();
  }

  async dispose(): Promise<void> {
    const all = [...this.tabs.values()];
    this.tabs.clear();
    this.order = [];
    this.activeId = "";
    for (const tab of all) {
      tab.subscription.dispose();
      await tab.session.dispose();
    }
    this._onDidChange.dispose();
  }
}
