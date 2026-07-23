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

export interface OpenSessionsState {
  sessionIds: string[];
  titles?: string[];
  activeIndex: number;
}

export interface OpenSessionsStore {
  get(): OpenSessionsState | undefined;
  set(state: OpenSessionsState): void;
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
    .replace(/@[^\n]+/g, "")
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
  private readonly tabSessionIds = new Map<string, string>();
  private readonly tabTitles = new Map<string, string>();
  private order: string[] = [];
  private activeId = "";
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly getWorkspaceCwd: () => string,
    private readonly openSessionsStore?: OpenSessionsStore,
  ) {
    const continueEnabled = vscode.workspace
      .getConfiguration("ompChat")
      .get<boolean>("continueLastSession", true);
    const saved = continueEnabled ? this.openSessionsStore?.get() : undefined;
    const sessionIds = saved?.sessionIds?.filter((id) => Boolean(id?.trim())) ?? [];

    if (sessionIds.length > 0) {
      const titles = saved?.titles ?? [];
      for (let i = 0; i < sessionIds.length; i += 1) {
        this.createTab(false, sessionIds[i].trim(), titles[i]);
      }
      const activeIndex = Math.min(
        Math.max(saved?.activeIndex ?? 0, 0),
        this.order.length - 1,
      );
      this.activeId = this.order[activeIndex] ?? this.order[0] ?? "";
      this.persistOpenSessions();
      this.notify();
      return;
    }

    this.createTab(true);
  }

  private notify(): void {
    this._onDidChange.fire();
  }

  private persistOpenSessions(): void {
    if (!this.openSessionsStore) {
      return;
    }

    const entries = this.order
      .map((tabId) => {
        const sessionId = this.tabSessionIds.get(tabId)?.trim();
        if (!sessionId) {
          return undefined;
        }
        const title = this.tabTitles.get(tabId) ?? this.tabs.get(tabId)?.title;
        return { tabId, sessionId, title };
      })
      .filter(
        (entry): entry is { tabId: string; sessionId: string; title: string | undefined } =>
          Boolean(entry),
      );

    if (entries.length === 0) {
      this.openSessionsStore.set({ sessionIds: [], titles: [], activeIndex: 0 });
      return;
    }

    let activeIndex = entries.findIndex((entry) => entry.tabId === this.activeId);
    if (activeIndex < 0) {
      activeIndex = entries.length - 1;
    }

    this.openSessionsStore.set({
      sessionIds: entries.map((entry) => entry.sessionId),
      titles: entries.map((entry) => entry.title ?? "New chat"),
      activeIndex,
    });
  }

  private makeSessionStore(tabId: string): SessionIdStore {
    return {
      get: () => this.tabSessionIds.get(tabId),
      set: (sessionId) => {
        const next = sessionId?.trim();
        if (next) {
          this.tabSessionIds.set(tabId, next);
        } else {
          this.tabSessionIds.delete(tabId);
        }
        this.persistOpenSessions();
      },
    };
  }

  private syncTitle(tab: TabRecord): void {
    const fromMessages = titleFromMessages(tab.session.getMessages());
    const next = fromMessages ?? this.tabTitles.get(tab.id) ?? "New chat";
    if (tab.title !== next) {
      tab.title = next;
    }
    if (fromMessages && this.tabTitles.get(tab.id) !== fromMessages) {
      this.tabTitles.set(tab.id, fromMessages);
      this.persistOpenSessions();
    }
  }

  getActiveId(): string {
    return this.activeId;
  }

  getWorkspaceCwdPath(): string {
    return this.getWorkspaceCwd();
  }

  /** omp session ids currently open in tabs */
  getOpenOmpSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const sessionId of this.tabSessionIds.values()) {
      const trimmed = sessionId?.trim();
      if (trimmed) {
        ids.add(trimmed);
      }
    }
    return ids;
  }

  findTabIdBySessionId(sessionId: string): string | undefined {
    const target = sessionId.trim();
    if (!target) {
      return undefined;
    }
    for (const [tabId, sid] of this.tabSessionIds) {
      if (sid === target) {
        return tabId;
      }
    }
    return undefined;
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

  createTab(activate = true, resumeSessionId?: string, title?: string): string {
    const id = randomUUID();
    if (resumeSessionId?.trim()) {
      this.tabSessionIds.set(id, resumeSessionId.trim());
    }
    const initialTitle = title?.trim() || "New chat";
    if (initialTitle !== "New chat") {
      this.tabTitles.set(id, initialTitle);
    }
    const session = new SessionManager(this.getWorkspaceCwd, this.makeSessionStore(id));
    const subscription = session.onDidChange(() => {
      const tab = this.tabs.get(id);
      if (tab) {
        this.syncTitle(tab);
      }
      // Only bubble UI updates for the active tab, plus tab title/status strip.
      this.notify();
    });
    this.tabs.set(id, { id, title: initialTitle, session, subscription });
    this.order.push(id);
    if (activate || !this.activeId) {
      this.activeId = id;
    }
    this.persistOpenSessions();
    this.notify();
    return id;
  }

  async switchTab(id: string): Promise<void> {
    if (!this.tabs.has(id) || this.activeId === id) {
      this.notify();
      return;
    }
    this.activeId = id;
    this.persistOpenSessions();
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
    this.tabSessionIds.delete(id);
    this.tabTitles.delete(id);
    this.order = this.order.filter((item) => item !== id);

    if (this.order.length === 0) {
      this.activeId = "";
      const nextId = this.createTab(true);
      void this.tabs
        .get(nextId)
        ?.session.ensureStarted({ continueLastSession: false, resumeSessionId: undefined })
        .catch(() => undefined);
      return;
    }

    if (this.activeId === id) {
      this.activeId = this.order[this.order.length - 1] || this.order[0];
      void this.active().ensureStarted().catch(() => undefined);
    }
    this.persistOpenSessions();
    this.notify();
  }

  async newChat(): Promise<void> {
    const id = this.createTab(true);
    void this.tabs
      .get(id)
      ?.session.ensureStarted({ continueLastSession: false, resumeSessionId: undefined })
      .catch(() => undefined);
  }

  /** Switch to an open tab for this omp session, or open a new tab that resumes it. */
  async openHistorySession(sessionId: string, title?: string): Promise<void> {
    const existing = this.findTabIdBySessionId(sessionId);
    if (existing) {
      await this.switchTab(existing);
      return;
    }
    const id = this.createTab(true, sessionId, title);
    void this.tabs
      .get(id)
      ?.session.ensureStarted({ continueLastSession: false, resumeSessionId: sessionId })
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
    this.persistOpenSessions();
    const all = [...this.tabs.values()];
    this.tabs.clear();
    this.tabSessionIds.clear();
    this.tabTitles.clear();
    this.order = [];
    this.activeId = "";
    for (const tab of all) {
      tab.subscription.dispose();
      await tab.session.dispose();
    }
    this._onDidChange.dispose();
  }
}
