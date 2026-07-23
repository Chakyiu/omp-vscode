import * as vscode from "vscode";
import { ChatViewProvider } from "./chat/chatViewProvider";
import { TabManager, type OpenSessionsState } from "./omp/tabManager";

function workspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? process.cwd();
}

const OPEN_SESSIONS_KEY = "ompChat.openSessions";
const LEGACY_LAST_SESSION_KEY = "ompChat.lastSessionId";

function readOpenSessions(context: vscode.ExtensionContext): OpenSessionsState | undefined {
  const saved = context.workspaceState.get<OpenSessionsState>(OPEN_SESSIONS_KEY);
  const rawIds = saved?.sessionIds ?? [];
  const sessionIds: string[] = [];
  const titles: string[] = [];
  for (let i = 0; i < rawIds.length; i += 1) {
    const id = rawIds[i]?.trim();
    if (!id) {
      continue;
    }
    sessionIds.push(id);
    titles.push(saved?.titles?.[i]?.trim() || "New chat");
  }
  if (sessionIds.length > 0) {
    return {
      sessionIds,
      titles,
      activeIndex: Math.min(Math.max(saved?.activeIndex ?? 0, 0), sessionIds.length - 1),
    };
  }

  // Migrate the older single-session key so existing workspaces keep restoring.
  const legacy = context.workspaceState.get<string>(LEGACY_LAST_SESSION_KEY);
  if (legacy?.trim()) {
    return { sessionIds: [legacy.trim()], titles: ["New chat"], activeIndex: 0 };
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const openSessionsStore = {
    get(): OpenSessionsState | undefined {
      return readOpenSessions(context);
    },
    set(state: OpenSessionsState): void {
      void context.workspaceState.update(OPEN_SESSIONS_KEY, state);
      // Clear legacy key once the multi-session format is written.
      void context.workspaceState.update(LEGACY_LAST_SESSION_KEY, undefined);
    },
  };
  const sessions = new TabManager(workspaceCwd, openSessionsStore);
  const provider = new ChatViewProvider(
    context.extensionUri,
    sessions,
    context.globalStorageUri,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.open", async () => {
      await vscode.commands.executeCommand("ompChat.sidebar.focus");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.newChat", async () => {
      await provider.newChat();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.stop", () => {
      provider.stop();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.restartSession", async () => {
      await provider.restart();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.attachFiles", async () => {
      await provider.attachFiles();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.attachFolder", async () => {
      await provider.attachFolder();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.attachMenu", async () => {
      await provider.showAttachMenu();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ompChat.attachExplorer",
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const selected = uris?.length ? uris : uri ? [uri] : [];
        if (!selected.length) {
          await provider.attachFiles();
          return;
        }
        await provider.attachPaths(selected.map((item) => item.fsPath));
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.sendSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage("Select some code first.");
        return;
      }
      const selection = editor.document.getText(editor.selection);
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const language = editor.document.languageId;
      sessions.addAttachment({
        kind: "selection",
        label: `${rel} (selection)`,
        path: rel,
        language,
        content: selection,
      });
      await vscode.commands.executeCommand("ompChat.sidebar.focus");
      provider.revealAttachments();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.attachCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Open a file first.");
        return;
      }
      const fileUri = editor.document.uri;
      const rel = vscode.workspace.asRelativePath(fileUri);
      if (fileUri.scheme === "file") {
        sessions.addAttachment({
          kind: "file",
          label: rel,
          path: rel,
          fsPath: fileUri.fsPath,
          language: editor.document.languageId,
        });
      } else {
        sessions.addAttachment({
          kind: "text",
          label: rel,
          path: rel,
          language: editor.document.languageId,
          content: editor.document.getText(),
        });
      }
      await vscode.commands.executeCommand("ompChat.sidebar.focus");
      provider.revealAttachments();
    }),
  );

  context.subscriptions.push(provider);
  context.subscriptions.push({
    dispose: () => {
      void sessions.dispose();
    },
  });

  void sessions.ensureStarted().catch(() => {
    // Errors are reflected in status; ignore here.
  });
}

export function deactivate(): void {
  // disposed via subscriptions
}
