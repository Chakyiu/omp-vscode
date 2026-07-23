import * as vscode from "vscode";
import { AttachmentService } from "../omp/attachmentService";
import { pickMode, pickModel } from "../omp/modelCatalog";
import { formatSessionWhen, listOmpSessions } from "../omp/sessionCatalog";
import type { TabManager } from "../omp/tabManager";
import { showToolFileLog } from "../omp/toolFileLog";
import type { FileSuggestItem, HostToWebview, WebviewToHost } from "../omp/types";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ompChat.sidebar";

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private mode: string = "Agent";
  private displayName: string = "";
  private readonly attachments: AttachmentService;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: TabManager,
    storageUri: vscode.Uri,
  ) {
    this.attachments = new AttachmentService(sessions, storageUri);
    this.displayName = this.resolveDisplayName();
    this.mode = vscode.workspace.getConfiguration("ompChat").get<string>("mode", "Agent") || "Agent";

    this.disposables.push(
      sessions.onDidChange(() => {
        this.postState();
      }),
    );

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("ompChat.showThinking") ||
          e.affectsConfiguration("ompChat.model") ||
          e.affectsConfiguration("ompChat.mode")
        ) {
          if (e.affectsConfiguration("ompChat.mode")) {
            this.mode =
              vscode.workspace.getConfiguration("ompChat").get<string>("mode", "Agent") ||
              "Agent";
          }
          this.post({
            type: "config",
            showThinking: vscode.workspace
              .getConfiguration("ompChat")
              .get<boolean>("showThinking", true),
            model: this.currentModelLabel(),
            mode: this.mode,
            displayName: this.displayName,
          });
        }
      }),
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      try {
        await this.onMessage(raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.post({ type: "error", message });
      }
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  async newChat(): Promise<void> {
    await this.sessions.newChat();
    this.postState();
  }

  stop(): void {
    this.sessions.abort();
  }

  async restart(): Promise<void> {
    await this.sessions.restart();
    this.postState();
  }

  revealAttachments(): void {
    this.postState();
  }

  async attachFiles(): Promise<void> {
    await this.attachments.attachFiles();
    await vscode.commands.executeCommand("ompChat.sidebar.focus");
    this.postState();
  }

  async attachFolder(): Promise<void> {
    await this.attachments.attachFolder();
    await vscode.commands.executeCommand("ompChat.sidebar.focus");
    this.postState();
  }

  async attachPaths(paths: string[]): Promise<void> {
    await this.attachments.attachPaths(paths);
    await vscode.commands.executeCommand("ompChat.sidebar.focus");
    this.postState();
  }

  async showAttachMenu(): Promise<void> {
    await this.attachments.showAttachMenu();
    await vscode.commands.executeCommand("ompChat.sidebar.focus");
    this.postState();
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postState();
        void this.sessions.ensureStarted().catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.post({ type: "error", message });
        });
        break;
      case "send":
        await this.sessions.send(msg.text);
        break;
      case "stop":
        this.sessions.abort();
        break;
      case "newChat":
        await this.sessions.newChat();
        this.postState();
        break;
      case "switchTab":
        await this.sessions.switchTab(msg.id);
        this.postState();
        break;
      case "closeTab":
        await this.sessions.closeTab(msg.id);
        this.postState();
        break;
      case "restart":
        await this.sessions.restart();
        break;
      case "history":
        await this.showTabPicker();
        break;
      case "moreMenu":
        await this.showMoreMenu();
        break;
      case "pickModel":
        await this.pickModelAndApply();
        break;
      case "pickMode":
        await this.pickModeAndApply();
        break;
      case "showUsage": {
        const usage = this.sessions.getContextUsage();
        const model = this.currentModelLabel();
        if (!usage) {
          vscode.window.showInformationMessage(`Model: ${model}\nContext usage: unavailable yet`);
        } else {
          vscode.window.showInformationMessage(
            `Model: ${model}\nContext: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${usage.percent.toFixed(2)}%)`,
          );
        }
        break;
      }
      case "attachMenu":
        await this.showAttachMenu();
        break;
      case "attachFiles":
        await this.attachFiles();
        break;
      case "attachFolder":
        await this.attachFolder();
        break;
      case "attachPaths":
        await this.attachments.attachPaths(msg.paths || []);
        this.postState();
        break;
      case "attachImage":
        await this.attachments.attachImageBase64(msg);
        this.postState();
        break;
      case "attachTextFile":
        await this.attachments.attachTextFile(msg);
        this.postState();
        break;
      case "removeAttachment":
        this.sessions.removeAttachment(msg.id);
        break;
      case "copy":
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.setStatusBarMessage("Copied to clipboard", 1500);
        break;
      case "insert": {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showInformationMessage("Open an editor to insert text.");
          break;
        }
        await editor.edit((builder) => {
          builder.insert(editor.selection.active, msg.text);
        });
        break;
      }
      case "openExternal": {
        const raw = String(msg.url || "").trim();
        if (!raw) break;
        try {
          if (/^[A-Za-z]:\\/.test(raw) || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) {
            const uri = vscode.Uri.file(raw);
            await vscode.commands.executeCommand("vscode.open", uri);
          } else {
            await vscode.env.openExternal(vscode.Uri.parse(raw));
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showWarningMessage(`Could not open link: ${message}`);
        }
        break;
      }
      case "searchFiles":
        await this.searchFiles(msg.query || "", msg.requestId);
        break;
      case "runSlashCommand":
        await this.runSlashCommand(msg.command);
        break;
      case "answerUiQuestion":
        this.sessions.answerUiQuestion(msg.id, {
          confirmed: msg.confirmed,
          value: msg.value,
          cancelled: msg.cancelled,
        });
        break;
      case "openFile": {
        const uri = this.resolveWorkspaceUri(msg.path);
        if (!uri) {
          vscode.window.showWarningMessage(`Could not open ${msg.path}`);
          break;
        }
        try {
          await vscode.window.showTextDocument(uri, { preview: false });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showWarningMessage(`Could not open ${msg.path}: ${message}`);
        }
        break;
      }
      default:
        break;
    }
  }

    private resolveWorkspaceUri(pathValue: string): vscode.Uri | undefined {
    let value = String(pathValue || "").trim();
    if (!value) {
      return undefined;
    }
    if (value.startsWith("file://")) {
      try {
        return vscode.Uri.parse(value);
      } catch {
        value = value.slice("file://".length);
        try {
          value = decodeURIComponent(value);
        } catch {
          // keep sliced value
        }
        if (/^\/[A-Za-z]:/.test(value)) {
          value = value.slice(1);
        }
      }
    }
    if (value.startsWith("~/")) {
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home) {
        value = `${home}/${value.slice(2)}`;
      }
    }
    if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
      return vscode.Uri.file(value);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    return vscode.Uri.joinPath(folder.uri, value);
  }


  private currentModelLabel(): string {
    return this.sessions.getModelLabel();
  }

  private resolveDisplayName(): string {
    const fromConfig = vscode.workspace.getConfiguration("ompChat").get<string>("displayName", "");
    if (fromConfig && fromConfig.trim()) {
      return fromConfig.trim();
    }
    // Best-effort first name from OS user.
    const user = process.env.USER || process.env.USERNAME || "";
    if (!user) {
      return "";
    }
    return user.charAt(0).toUpperCase() + user.slice(1);
  }

  private postState(): void {
    const showThinking = vscode.workspace
      .getConfiguration("ompChat")
      .get<boolean>("showThinking", true);
    this.post({
      type: "ready",
      status: this.sessions.getStatus(),
      messages: this.sessions.getMessages(),
      attachments: this.sessions.getAttachments(),
      showThinking,
      model: this.currentModelLabel(),
      mode: this.mode,
      displayName: this.displayName,
      contextUsage: this.sessions.getContextUsage(),
      tabs: this.sessions.getTabs(),
      activeTabId: this.sessions.getActiveId(),
      uiQuestion: this.sessions.getUiQuestion(),
    });
  }

  private post(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat.js"),
    );
    const nonce = String(Date.now());

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: blob:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>OMP Chat</title>
</head>
<body>
  <div id="app">
    <div id="dropOverlay" class="drop-overlay" hidden>
      <div class="drop-card">Drop to attach</div>
    </div>

    <div class="tabstrip" id="tabstrip" aria-label="Chat tabs">
      <div class="tabs" id="tabs"></div>
      <div class="tab-actions">
        <span id="statusDot" class="status-dot" title="status"></span>
        <button id="newChatBtn" class="icon-btn tab-action" title="New session" aria-label="New session">
          <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path fill="currentColor" d="M8.75 1.75a.75.75 0 0 0-1.5 0v5.5h-5.5a.75.75 0 0 0 0 1.5h5.5v5.5a.75.75 0 0 0 1.5 0v-5.5h5.5a.75.75 0 0 0 0-1.5h-5.5v-5.5Z"/>
          </svg>
        </button>
        <button id="moreBtn" class="icon-btn tab-action" title="Settings" aria-label="Settings">
          <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path fill="currentColor" d="M6.5 1.1a1.5 1.5 0 0 1 3 0l.08.46a1.5 1.5 0 0 0 2.1 1.08l.42-.2a1.5 1.5 0 0 1 2.04 1.95l-.25.4a1.5 1.5 0 0 0 .56 2.1l.43.2a1.5 1.5 0 0 1 0 2.72l-.43.2a1.5 1.5 0 0 0-.56 2.1l.25.4a1.5 1.5 0 0 1-2.04 1.95l-.42-.2a1.5 1.5 0 0 0-2.1 1.08L9.5 14.9a1.5 1.5 0 0 1-3 0l-.08-.46a1.5 1.5 0 0 0-2.1-1.08l-.42.2a1.5 1.5 0 0 1-2.04-1.95l.25-.4a1.5 1.5 0 0 0-.56-2.1l-.43-.2a1.5 1.5 0 0 1 0-2.72l.43-.2a1.5 1.5 0 0 0 .56-2.1l-.25-.4A1.5 1.5 0 0 1 4.3 2.44l.42.2a1.5 1.5 0 0 0 2.1-1.08L6.5 1.1ZM8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5Z"/>
          </svg>
        </button>
        <button id="historyBtn" class="icon-btn tab-action" title="History" aria-label="History">
          <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path fill="currentColor" d="M1.5 8a6.5 6.5 0 1 1 1.61 4.263.75.75 0 1 1 1.025-1.096A5 5 0 1 0 3 8H1.75A.75.75 0 0 1 1.5 8Z"/>
            <path fill="currentColor" d="M8.75 4.75a.75.75 0 0 0-1.5 0v3.5c0 .192.168.1.5.53l2.5 1.5a.75.75 0 1 0 .75-1.3L8.75 7.8V4.75Z"/>
            <path fill="currentColor" d="M4.28 1.22a.75.75 0 0 1 0 1.06L2.81 3.75H5.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1-.75-.75V1.75a.75.75 0 0 1 1.5 0v1.69l1.72-1.72a.75.75 0 0 1 1.06 0Z"/>
          </svg>
        </button>
      </div>
    </div>

    <main id="messages" class="messages"></main>

    <section id="empty" class="empty visible">
      <div class="greeting">
        <svg class="sparkle" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6.5 8.25h11M9 8.25V16.4c0 .75-.3 1.15-.95 1.15-.3 0-.58-.08-.82-.22M15 8.25V16.4c0 .75.3 1.15.95 1.15.3 0 .58-.08.82-.22" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <h1 id="greetingTitle">How can I help you?</h1>
      </div>
      <div class="suggestions">
        <button class="chip" data-prompt="Open a pull request for my current changes.">
          <span class="chip-icon">⎇</span>
          <span class="chip-title">Create PR</span>
          <span class="chip-sub">Open a pull request for…</span>
        </button>
        <button class="chip" data-prompt="Walk me through how this project works, starting from the entrypoints.">
          <span class="chip-icon">◇</span>
          <span class="chip-title">Explain code</span>
          <span class="chip-sub">Walk me through how this…</span>
        </button>
        <button class="chip" data-prompt="Help me resolve TypeScript and compile/lint errors in this workspace.">
          <span class="chip-icon">⚠</span>
          <span class="chip-title">Fix errors</span>
          <span class="chip-sub">Help me resolve TypeScript…</span>
        </button>
        <button class="chip" data-prompt="Write unit tests for the selected code or current file.">
          <span class="chip-icon">▣</span>
          <span class="chip-title">Generate unit tests</span>
          <span class="chip-sub">Write unit tests for…</span>
        </button>
      </div>
    </section>

    <div id="uiQuestion" class="ui-question" hidden></div>
    <footer class="composer-wrap">
      <div class="composer">
        <div id="suggest" class="suggest" hidden>
          <div id="suggestHeader" class="suggest-header"></div>
          <div id="suggestList" class="suggest-list" role="listbox"></div>
        </div>
        <div id="attachments" class="attachments"></div>
        <textarea id="input" rows="2" placeholder="Plan, @ for context, / for commands — Enter queues while generating"></textarea>
        <div class="composer-actions">
          <div class="left-actions">
            <button id="modelBtn" class="pill" title="Select model">
              <span id="modelLabel" class="pill-label">Model</span>
              <span class="chev">▾</span>
            </button>
            <button id="modeBtn" class="pill" title="Mode">
              <span id="modeLabel" class="pill-label">Agent</span>
              <span class="chev">▾</span>
            </button>
            <button id="usageBtn" class="usage-chip" title="Context usage this session" type="button">
              <svg id="usageRing" class="usage-ring" viewBox="0 0 28 28" aria-hidden="true">
                <circle class="usage-track" cx="14" cy="14" r="11"></circle>
                <circle id="usageProgress" class="usage-progress" cx="14" cy="14" r="11"></circle>
              </svg>
              <span id="usageLabel" class="usage-label">0%</span>
            </button>
          </div>
          <div class="right-actions">
            <button id="attachBtn" class="icon-btn composer-icon" title="Attach" aria-label="Attach">
              <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path fill="currentColor" d="M13.56 3.56a2.25 2.25 0 0 0-3.18 0L3.66 10.28a3.25 3.25 0 0 0 4.6 4.6l5.65-5.66-.71-.7-5.65 5.65a2.25 2.25 0 1 1-3.18-3.18l6.72-6.72a1.25 1.25 0 1 1 1.77 1.77L6.86 12.04l-.71-.7 6.36-6.37a2.25 2.25 0 0 0 0-3.18z"/>
              </svg>
            </button>
            <button id="attachFilesBtn" class="ghost" title="Attach files">Files</button>
            <button id="attachFolderBtn" class="ghost" title="Attach folder">Folder</button>
            <button id="stopBtn" class="secondary" title="Stop" hidden>■</button>
            <button id="sendBtn" class="primary" title="Send">↑</button>
          </div>
        </div>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }


  private async pickModelAndApply(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("ompChat");
    const ompPath = cfg.get<string>("ompPath", "omp") || "omp";
    const current = cfg.get<string>("model", "") || "";
    const selected = await pickModel(ompPath, current);
    if (selected === undefined) {
      return;
    }
    await cfg.update("model", selected, vscode.ConfigurationTarget.Workspace);
    this.post({
      type: "config",
      model: selected.trim() ? selected : "Default",
      mode: this.mode,
      displayName: this.displayName,
    });
    await this.sessions.restart();
    this.postState();
  }

  private async pickModeAndApply(): Promise<void> {
    const selected = await pickMode(this.mode);
    if (!selected) {
      return;
    }
    this.mode = selected;
    await vscode.workspace
      .getConfiguration("ompChat")
      .update("mode", selected, vscode.ConfigurationTarget.Workspace);
    this.post({
      type: "config",
      mode: selected,
      model: this.currentModelLabel(),
      displayName: this.displayName,
    });
  }


  private async showTabPicker(): Promise<void> {
    const cwd = this.sessions.getWorkspaceCwdPath();
    const openIds = this.sessions.getOpenOmpSessionIds();
    const activeTabId = this.sessions.getActiveId();

    let history: Awaited<ReturnType<typeof listOmpSessions>> = [];
    try {
      history = await listOmpSessions(cwd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Could not load session history: ${message}`);
    }

    let activeOmpSessionId: string | undefined;
    for (const sessionId of openIds) {
      const tabId = this.sessions.findTabIdBySessionId(sessionId);
      if (tabId === activeTabId) {
        activeOmpSessionId = sessionId;
        break;
      }
    }

    type HistoryPick = vscode.QuickPickItem & {
      action: "new" | "open";
      sessionId?: string;
      title?: string;
    };

    const items: HistoryPick[] = [
      {
        label: "+ New chat",
        description: "Start a fresh session",
        action: "new",
      },
      ...history.map((session) => {
        const isOpen = openIds.has(session.id);
        const isActive = session.id === activeOmpSessionId;
        const when = formatSessionWhen(session.updatedAt);
        const icon = isActive
          ? "$(check)"
          : isOpen
            ? "$(comment-discussion)"
            : "$(history)";
        return {
          label: `${icon} ${session.title}`,
          description: [isOpen ? "open" : undefined, when].filter(Boolean).join(" · "),
          detail:
            session.preview && session.preview !== session.title ? session.preview : session.id,
          action: "open" as const,
          sessionId: session.id,
          title: session.title,
        };
      }),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: "Session history",
      placeHolder: history.length
        ? "Resume a past session or start a new chat"
        : "No past sessions found — start a new chat",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) {
      return;
    }
    if (picked.action === "new") {
      await this.sessions.newChat();
    } else if (picked.sessionId) {
      await this.sessions.openHistorySession(picked.sessionId, picked.title);
    }
    this.postState();
  }

  private async showMoreMenu(): Promise<void> {
    const usage = this.sessions.getContextUsage();
    const usageDesc = usage
      ? `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${usage.percent.toFixed(2)}%)`
      : "No usage yet";
    const picked = await vscode.window.showQuickPick(
      [
        { label: "Select model", description: this.currentModelLabel() },
        { label: "Context usage", description: usageDesc },
        { label: "File touch log", description: "Show edit/write/delete paths" },
        { label: "Restart session", description: "Reload omp RPC bridge" },
        { label: "Attach current file" },
        { label: "Attach selection" },
      ],
      { title: "OMP" },
    );
    if (!picked) {
      return;
    }
    if (picked.label === "Select model") {
      await this.pickModelAndApply();
    } else if (picked.label === "Context usage") {
      vscode.window.showInformationMessage(`Context usage: ${usageDesc}`);
    } else if (picked.label === "File touch log") {
      showToolFileLog();
    } else if (picked.label === "Restart session") {
      await this.restart();
    } else if (picked.label === "Attach current file") {
      await vscode.commands.executeCommand("ompChat.attachCurrentFile");
    } else if (picked.label === "Attach selection") {
      await vscode.commands.executeCommand("ompChat.sendSelection");
    }
  }


  private async searchFiles(query: string, requestId: number): Promise<void> {
    const files = await this.collectFileSuggestions(query);
    this.post({ type: "fileResults", requestId, files });
  }

  private async collectFileSuggestions(query: string): Promise<FileSuggestItem[]> {
    const q = query.trim().toLowerCase();
    const results: FileSuggestItem[] = [];
    const seen = new Set<string>();
    const ignoreDirs = new Set([
      "node_modules",
      ".git",
      "dist",
      "out",
      "build",
      ".venv",
      "coverage",
      ".next",
      "target",
    ]);

    const push = (item: FileSuggestItem): void => {
      if (!item.fsPath || seen.has(item.fsPath)) {
        return;
      }
      const hay = `${item.path} ${item.label || ""}`.toLowerCase();
      if (q && !hay.includes(q) && !scorePath(item.path, q)) {
        return;
      }
      seen.add(item.fsPath);
      results.push(item);
    };

    const pushFolder = (relPath: string, fsPath: string, detail = "Folder"): void => {
      const normalized = relPath.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!normalized || normalized === ".") {
        return;
      }
      const parts = normalized.split("/");
      if (parts.some((part) => ignoreDirs.has(part))) {
        return;
      }
      push({
        path: normalized,
        fsPath,
        kind: "folder",
        label: `${normalized}/`,
        detail,
      });
    };

    const active = vscode.window.activeTextEditor?.document;
    if (active && !active.isUntitled && active.uri.scheme === "file") {
      push({
        path: vscode.workspace.asRelativePath(active.uri, false),
        fsPath: active.uri.fsPath,
        kind: "file",
        label: "Current file",
        detail: vscode.workspace.asRelativePath(active.uri, false),
      });
    }

    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isUntitled || doc.uri.scheme !== "file") continue;
      push({
        path: vscode.workspace.asRelativePath(doc.uri, false),
        fsPath: doc.uri.fsPath,
        kind: "file",
        detail: "Open editor",
      });
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      // Top-level workspace roots are always attachable as folders.
      pushFolder(folder.name, folder.uri.fsPath, "Workspace folder");
    }

    try {
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,out,build,.venv,coverage,.next,target}/**",
        400,
      );
      for (const uri of uris) {
        const rel = vscode.workspace.asRelativePath(uri, false);
        push({
          path: rel,
          fsPath: uri.fsPath,
          kind: "file",
        });

        // Derive ancestor folders from each file so @ can select entire directories.
        let parent = vscode.Uri.joinPath(uri, "..");
        for (let depth = 0; depth < 8; depth += 1) {
          const parentFs = parent.fsPath;
          const root = folders.find(
            (folder) =>
              parentFs === folder.uri.fsPath ||
              parentFs.startsWith(folder.uri.fsPath + "/") ||
              parentFs.startsWith(folder.uri.fsPath + "\\"),
          );
          if (!root) {
            break;
          }
          if (parentFs === root.uri.fsPath) {
            pushFolder(root.name, root.uri.fsPath, "Workspace folder");
            break;
          }
          const parentRel = vscode.workspace.asRelativePath(parent, false);
          if (!parentRel || parentRel === rel) {
            break;
          }
          pushFolder(parentRel, parentFs);
          parent = vscode.Uri.joinPath(parent, "..");
        }
      }
    } catch {
      // ignore findFiles failures (e.g. no workspace)
    }

    results.sort((a, b) => {
      const boost = (item: FileSuggestItem): number => {
        if (item.label === "Current file") return 1000;
        if (item.detail === "Open editor") return 500;
        if (item.kind === "folder") {
          const base = item.path.split(/[\\/]/).pop() || item.path;
          if (q && base.toLowerCase() === q) return 280;
          if (q && base.toLowerCase().startsWith(q)) return 180;
          return 40;
        }
        return 0;
      };
      const sa = scorePath(a.path, q) + boost(a);
      const sb = scorePath(b.path, q) + boost(b);
      if (sb !== sa) return sb - sa;
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    return results.slice(0, 25);
  }

  private async runSlashCommand(command: string): Promise<void> {
    const id = (command || "").trim().replace(/^\//, "").toLowerCase();
    switch (id) {
      case "new":
      case "clear":
        await this.newChat();
        break;
      case "stop":
        this.stop();
        break;
      case "restart":
        await this.restart();
        break;
      case "model":
        await this.pickModelAndApply();
        break;
      case "mode":
        await this.pickModeAndApply();
        break;
      case "attach":
      case "files":
        await this.attachFiles();
        break;
      case "folder":
        await this.attachFolder();
        break;
      case "usage":
        {
          const usage = this.sessions.getContextUsage();
          const model = this.currentModelLabel();
          if (!usage) {
            vscode.window.showInformationMessage(`Model: ${model}\nContext usage: unavailable yet`);
          } else {
            vscode.window.showInformationMessage(
              `Model: ${model}\nContext: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${usage.percent.toFixed(2)}%)`,
            );
          }
        }
        break;
      case "history":
      case "tabs":
        await this.showTabPicker();
        break;
      case "help":
        vscode.window.showInformationMessage(
          "Commands: /new /stop /restart /model /mode /attach /folder /usage /history /help — Files/folders: type @ to attach",
        );
        break;
      default:
        vscode.window.showWarningMessage(`Unknown command: /${id}`);
        break;
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function scorePath(pathValue: string, query: string): number {
  if (!query) {
    return 1;
  }
  const lower = pathValue.toLowerCase();
  const base = lower.split(/[\\/]/).pop() || lower;
  if (base === query) return 300;
  if (base.startsWith(query)) return 200;
  if (base.includes(query)) return 120;
  if (lower.includes(query)) return 60;
  // subsequence match
  let qi = 0;
  for (let i = 0; i < lower.length && qi < query.length; i += 1) {
    if (lower[i] === query[qi]) qi += 1;
  }
  return qi === query.length ? 20 : 0;
}

