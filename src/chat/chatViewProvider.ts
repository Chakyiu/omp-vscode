import * as vscode from "vscode";
import { AttachmentService } from "../omp/attachmentService";
import { pickMode, pickModel } from "../omp/modelCatalog";
import type { TabManager } from "../omp/tabManager";
import type { HostToWebview, WebviewToHost } from "../omp/types";

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
      case "openFile": {
        const uri = this.resolveWorkspaceUri(msg.path);
        if (!uri) {
          vscode.window.showWarningMessage(`Could not open ${msg.path}`);
          break;
        }
        await vscode.window.showTextDocument(uri);
        break;
      }
      default:
        break;
    }
  }

  private resolveWorkspaceUri(pathValue: string): vscode.Uri | undefined {
    if (!pathValue) {
      return undefined;
    }
    if (pathValue.startsWith("/") || /^[A-Za-z]:\\/.test(pathValue)) {
      return vscode.Uri.file(pathValue);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    return vscode.Uri.joinPath(folder.uri, pathValue);
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
  <title>Oh My Pi Chat</title>
</head>
<body>
  <div id="app">
    <div id="dropOverlay" class="drop-overlay" hidden>
      <div class="drop-card">Drop to attach</div>
    </div>

    <header class="topbar">
      <div class="brand">
        <button id="modeTopBtn" class="mode-btn" title="Mode">
          <span id="modeTopLabel">Agent</span>
          <span class="chev">▾</span>
        </button>
        <span id="statusDot" class="status-dot" title="status"></span>
      </div>
      <div class="top-actions">
        <button id="historyBtn" class="icon-btn" title="History">☰</button>
        <button id="moreBtn" class="icon-btn" title="More">⋯</button>
        <button id="newChatBtn" class="icon-btn" title="New chat">＋</button>
      </div>
    </header>

    <div class="tabstrip" id="tabstrip" aria-label="Chat tabs">
      <div class="tabs" id="tabs"></div>
      <button id="addTabBtn" class="icon-btn tab-add" title="New tab">＋</button>
    </div>

    <main id="messages" class="messages"></main>

    <section id="empty" class="empty visible">
      <div class="greeting">
        <svg class="sparkle" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2l1.2 6.3L19 10l-5.8 1.7L12 18l-1.2-6.3L5 10l5.8-1.7L12 2z" fill="currentColor" opacity="0.95"/>
          <path d="M19 14l.6 2.4L22 17l-2.4.6L19 20l-.6-2.4L16 17l2.4-.6L19 14z" fill="currentColor" opacity="0.75"/>
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

    <footer class="composer-wrap">
      <div class="composer">
        <div id="attachments" class="attachments"></div>
        <textarea id="input" rows="2" placeholder="Plan, @ for context, / for commands"></textarea>
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
            <button id="attachBtn" class="icon-btn composer-icon" title="Attach">＋</button>
            <button id="attachFilesBtn" class="ghost" title="Attach files">Files</button>
            <button id="attachFolderBtn" class="ghost" title="Attach folder">Folder</button>
            <button id="imageBtn" class="icon-btn composer-icon" title="Attach image">🖼</button>
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
    const tabs = this.sessions.getTabs();
    const activeId = this.sessions.getActiveId();
    const items = [
      ...tabs.map((tab) => ({
        label: `${tab.id === activeId ? "• " : ""}${tab.title}`,
        description: tab.busy ? "running" : tab.status,
        detail: tab.id,
      })),
      {
        label: "+ New chat",
        description: "Open another tab",
        detail: "__new__",
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Chat tabs",
      placeHolder: "Switch chat tab",
    });
    if (!picked) {
      return;
    }
    if (picked.detail === "__new__") {
      await this.sessions.newChat();
    } else if (picked.detail) {
      await this.sessions.switchTab(picked.detail);
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
        { label: "Restart session", description: "Reload omp RPC bridge" },
        { label: "Attach current file" },
        { label: "Attach selection" },
      ],
      { title: "Oh My Pi" },
    );
    if (!picked) {
      return;
    }
    if (picked.label === "Select model") {
      await this.pickModelAndApply();
    } else if (picked.label === "Context usage") {
      vscode.window.showInformationMessage(`Context usage: ${usageDesc}`);
    } else if (picked.label === "Restart session") {
      await this.restart();
    } else if (picked.label === "Attach current file") {
      await vscode.commands.executeCommand("ompChat.attachCurrentFile");
    } else if (picked.label === "Attach selection") {
      await vscode.commands.executeCommand("ompChat.sendSelection");
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
