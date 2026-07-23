# Oh My Pi Chat

A VS Code extension that gives [Oh My Pi (`omp`)](https://omp.sh/) a **Copilot / Cursor-style chat sidebar**.

It launches a local `omp --mode rpc` session and streams replies, thinking, and tool activity into a modern webview chat UI.

## Features

- Multi-tab chats (each tab is its own `omp` session)

- Model picker button (lists `omp models --json`, restarts session on change)
- Per-session context usage meter from omp `get_state.contextUsage`


- Activity-bar **Chat** sidebar (Copilot-like)
- Streaming assistant responses over omp RPC
- Collapsible **thinking** blocks
- Live **tool call** cards
- Attach current file / selection from the editor context menu
- New chat, stop generation, restart session
- Settings for model, thinking level, approval mode, auto-approve

## Prerequisites

1. Install Oh My Pi so `omp` is on your `PATH`
2. Configure provider auth the same way you do for the terminal CLI
3. VS Code `1.90+`

## Develop

```bash
npm install
npm run build
```

Then press **F5** (`Run Extension`) to open an Extension Development Host.

## Use

1. Open the **Oh My Pi** icon in the Activity Bar
2. Type a prompt and press **Enter**
3. Optional:
   - Right-click in the editor → **Oh My Pi: Attach Current File**
   - Select code → **Oh My Pi: Send Selection to Chat**
4. Use the view title buttons for **New Chat**, **Stop**, or **Restart Session**

### Keyboard shortcuts

| Action | macOS | Windows/Linux |
|---|---|---|
| Open chat | `Cmd+Shift+;` | `Ctrl+Shift+;` |
| Send selection | `Cmd+Shift+'` | `Ctrl+Shift+'` |

## Settings

| Setting | Meaning |
|---|---|
| `ompChat.ompPath` | Path to `omp` (default: `omp`) |
| `ompChat.model` | Model override (fuzzy match) |
| `ompChat.thinking` | Thinking level |
| `ompChat.approvalMode` | `always-ask` / `write` / `yolo` |
| `ompChat.autoApprove` | Pass `--auto-approve` |
| `ompChat.continueLastSession` | Start with `omp --continue` |
| `ompChat.extraArgs` | Extra CLI args |
| `ompChat.showThinking` | Show/hide thinking blocks in UI |

## Architecture

```
VS Code extension host
  └─ ChatViewProvider (webview sidebar)
       └─ SessionManager
            └─ OmpRpcClient
                 └─ spawn: omp --mode rpc --cwd <workspace>
                      stdin/stdout: newline-delimited JSON
```

Prompt command:

```json
{ "type": "prompt", "message": "..." }
```

Stop command:

```json
{ "type": "abort" }
```

## Package

```bash
npm run package
```

This produces a `.vsix` you can install with:

```bash
code --install-extension oh-my-pi-chat-0.1.0.vsix
```

## Notes / roadmap

- Approval prompts from omp are not yet rendered as interactive UI cards (use `approvalMode` / `autoApprove` for now)
- Multi-workspace root picker, session history browser, and inline apply/diff are natural next steps
- ACP (`omp acp`) is an alternative transport; this extension uses native `--mode rpc` for richer streaming events


## Attachments

- Click **📎** / **Files** / **Folder** in the composer
- Paste an image from the clipboard into the input
- Drag & drop files onto the chat panel
- Right-click in Explorer → **Oh My Pi: Attach to Chat**

Attachments are sent to `omp` as `@/absolute/path` mentions (images/files/folders), except code selections which are inlined.