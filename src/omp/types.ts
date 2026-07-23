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
}

export type MessagePart = TextPart | ThinkingPart | ToolCallPart;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  parts: MessagePart[];
  createdAt: number;
  streaming?: boolean;
}

export type AttachmentKind = "file" | "folder" | "image" | "selection" | "text";

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

export type HostToWebview =
  | {
      type: "ready";
      status: SessionStatus;
      messages: ChatMessage[];
      attachments: Attachment[];
      showThinking: boolean;
    }
  | { type: "status"; status: SessionStatus }
  | { type: "messages"; messages: ChatMessage[] }
  | { type: "attachments"; attachments: Attachment[] }
  | { type: "error"; message: string }
  | { type: "config"; showThinking: boolean };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "restart" }
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
  | { type: "openFile"; path: string };

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
  extraArgs?: string[];
}
