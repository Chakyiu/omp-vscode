import * as vscode from "vscode";
import { AttachmentService } from "../omp/attachmentService";
import type { SessionManager } from "../omp/sessionManager";
import type { HostToWebview, WebviewToHost } from "../omp/types";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ompChat.sidebar";

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly attachments: AttachmentService;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: SessionManager,
    storageUri: vscode.Uri,
  ) {
    this.attachments = new AttachmentService(sessions, storageUri);

    this.disposables.push(
      sessions.onDidChange(() => {
        this.postState();
      }),
    );

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("ompChat.showThinking")) {
          this.post({
            type: "config",
            showThinking: vscode.workspace
              .getConfiguration("ompChat")
              .get<boolean>("showThinking", true),
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
        break;
      case "restart":
        await this.sessions.restart();
        break;
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
      <div class="drop-card">Drop files or folders to attach</div>
    </div>

    <header class="topbar">
      <div class="brand">
        <div class="logo">π</div>
        <div>
          <div class="title">Oh My Pi</div>
          <div id="status" class="status">Starting…</div>
        </div>
      </div>
      <div class="top-actions">
        <button id="newChatBtn" class="icon-btn" title="New chat">＋</button>
        <button id="restartBtn" class="icon-btn" title="Restart session">↻</button>
      </div>
    </header>

    <main id="messages" class="messages"></main>

    <section id="empty" class="empty visible">
      <h1>Build with Oh My Pi</h1>
      <p>Ask questions, attach files/folders, paste images, and let <code>omp</code> work in your workspace.</p>
      <div class="suggestions">
        <button class="chip" data-prompt="Explain the architecture of this project.">Explain this project</button>
        <button class="chip" data-prompt="Find potential bugs in the current file and suggest fixes.">Find bugs</button>
        <button class="chip" data-prompt="Write tests for the selected code.">Write tests</button>
      </div>
    </section>

    <footer class="composer-wrap">
      <div id="attachments" class="attachments"></div>
      <div class="composer">
        <textarea id="input" rows="2" placeholder="Message Oh My Pi…  (paste image · drop files · 📎 attach)"></textarea>
        <div class="composer-actions">
          <div class="left-actions">
            <button id="attachBtn" class="icon-btn" title="Attach files, folder, or current file">📎</button>
            <button id="attachFilesBtn" class="ghost" title="Attach files">Files</button>
            <button id="attachFolderBtn" class="ghost" title="Attach folder">Folder</button>
          </div>
          <div class="right-actions">
            <button id="stopBtn" class="secondary" hidden>Stop</button>
            <button id="sendBtn" class="primary">Send</button>
          </div>
        </div>
      </div>
      <div class="hint">Enter to send · Shift+Enter newline · Paste image · Drop files/folders · omp @path mentions</div>
    </footer>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
