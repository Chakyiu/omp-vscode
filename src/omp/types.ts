export type ChatRole = "user" | "assistant" | "system";

export type ToolStatus = "running" | "done" | "error";

export interface ToolCallPart {
  kind: "tool";
  id: string;
  name: string;
  status: ToolStatus;
  inputPreview?: string;
  outputPreview?: string;
}

export interface TextPart {
  kind: "text";
  text: string;
}

export interface ThinkingPart {
  kind: "thinking";
  text: string;
  streaming?: boolean;
}

export type MessagePart = TextPart | ThinkingPart | ToolCallPart;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  parts: MessagePart[];
  createdAt: number;
  streaming?: boolean;
  /** Attachments shown in the transcript (e.g. image previews). */
  attachments?: Attachment[];
}

export type AttachmentKind = "file" | "folder" | "image" | "selection" | "text" | "context";

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  label: string;
  /** Absolute filesystem path used for omp @mentions */
  fsPath?: string;
  /** Display / workspace-relative path */
  path?: string;
  language?: string;
  /** Inline text for selections or pathless drops */
  content?: string;
  mimeType?: string;
  /** Optional data URL for image thumbnails in the webview */
  previewDataUrl?: string;
  size?: number;
}

export interface SessionStatus {
  state: "starting" | "ready" | "busy" | "error" | "stopped";
  detail?: string;
}

/** Session context window usage from omp get_state.contextUsage */
export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  /** Percentage of the context window used (0-100). */
  percent: number;
}

export interface ChatTabInfo {
  id: string;
  title: string;
  busy: boolean;
  status: SessionStatus["state"];
}

export interface SessionModelInfo {
  id: string;
  name: string;
  provider?: string;
  contextWindow?: number;
}

/** Workspace file / folder result for @-mention autocomplete */
export interface FileSuggestItem {
  path: string;
  fsPath: string;
  kind: "file" | "folder";
  /** Optional short label override (e.g. "Current file") */
  label?: string;
  detail?: string;
}

export type HostToWebview =
  | {
      type: "ready";
      status: SessionStatus;
      messages: ChatMessage[];
      attachments: Attachment[];
      showThinking: boolean;
      model?: string;
      mode?: string;
      displayName?: string;
      contextUsage?: ContextUsage | null;
      tabs?: ChatTabInfo[];
      activeTabId?: string;
    }
  | { type: "status"; status: SessionStatus }
  | { type: "messages"; messages: ChatMessage[] }
  | { type: "attachments"; attachments: Attachment[] }
  | { type: "error"; message: string }
  | {
      type: "config";
      showThinking?: boolean;
      model?: string;
      mode?: string;
      displayName?: string;
      contextUsage?: ContextUsage | null;
      tabs?: ChatTabInfo[];
      activeTabId?: string;
    }
  | { type: "contextUsage"; contextUsage: ContextUsage | null; model?: string }
  | { type: "tabs"; tabs: ChatTabInfo[]; activeTabId: string }
  | { type: "fileResults"; requestId: number; files: FileSuggestItem[] };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "switchTab"; id: string }
  | { type: "closeTab"; id: string }
  | { type: "restart" }
  | { type: "history" }
  | { type: "moreMenu" }
  | { type: "pickModel" }
  | { type: "pickMode" }
  | { type: "showUsage" }
  | { type: "attachMenu" }
  | { type: "attachFiles" }
  | { type: "attachFolder" }
  | { type: "attachPaths"; paths: string[] }
  | {
      type: "attachImage";
      name: string;
      mimeType: string;
      base64: string;
    }
  | {
      type: "attachTextFile";
      name: string;
      content: string;
      language?: string;
    }
  | { type: "removeAttachment"; id: string }
  | { type: "copy"; text: string }
  | { type: "insert"; text: string }
  | { type: "openFile"; path: string }
  | { type: "searchFiles"; query: string; requestId: number }
  | { type: "runSlashCommand"; command: string };

export interface OmpRpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface AssistantMessageEvent {
  type: string;
  delta?: string;
  contentIndex?: number;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface OmpClientOptions {
  ompPath: string;
  cwd: string;
  model?: string;
  thinking?: string;
  approvalMode?: string;
  autoApprove?: boolean;
  continueLastSession?: boolean;
  /** Resume a specific omp session id (takes precedence over --continue). */
  resumeSessionId?: string;
  extraArgs?: string[];
}
