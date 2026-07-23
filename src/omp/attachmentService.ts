import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import type { Attachment, AttachmentKind } from "./types";
type AttachmentHost = {
  addAttachment(attachment: Omit<import("./types").Attachment, "id"> & { id?: string }): void;
};

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".css", ".scss",
  ".html", ".htm", ".yml", ".yaml", ".toml", ".py", ".rs", ".go", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".sh", ".zsh", ".bash", ".sql", ".graphql", ".env",
  ".xml", ".svg", ".vue", ".svelte", ".rb", ".php", ".lua", ".r", ".dart",
]);

function displayPath(fsPath: string): string {
  return vscode.workspace.asRelativePath(fsPath, false);
}

function kindForPath(fsPath: string, isDirectory: boolean): AttachmentKind {
  if (isDirectory) {
    return "folder";
  }
  const ext = path.extname(fsPath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    return "image";
  }
  return "file";
}

function mimeFromExt(fsPath: string): string | undefined {
  switch (path.extname(fsPath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      return undefined;
  }
}

async function maybePreviewDataUrl(fsPath: string, kind: AttachmentKind): Promise<string | undefined> {
  if (kind !== "image") {
    return undefined;
  }
  try {
    const stat = await fs.stat(fsPath);
    // Keep chat thumbnails snappy; larger images still open via native preview.
    if (stat.size > 4_000_000) {
      return undefined;
    }
    const buf = await fs.readFile(fsPath);
    const mime = mimeFromExt(fsPath) ?? "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

export class AttachmentService {
  constructor(
    private readonly sessions: AttachmentHost,
    private readonly storageUri: vscode.Uri,
  ) {}

  async attachFiles(): Promise<number> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Attach",
      title: "Attach files to OMP chat",
    });
    if (!uris?.length) {
      return 0;
    }
    let count = 0;
    for (const uri of uris) {
      await this.attachFsPath(uri.fsPath);
      count += 1;
    }
    return count;
  }

  async attachFolder(): Promise<number> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Attach Folder",
      title: "Attach folder to OMP chat",
    });
    if (!uris?.length) {
      return 0;
    }
    await this.attachFsPath(uris[0].fsPath);
    return 1;
  }

  async attachPaths(paths: string[]): Promise<number> {
    let count = 0;
    for (const p of paths) {
      if (!p) continue;
      try {
        await this.attachFsPath(p);
        count += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showWarningMessage(`Could not attach ${p}: ${message}`);
      }
    }
    return count;
  }

  async attachFsPath(fsPath: string): Promise<Attachment> {
    const stat = await fs.stat(fsPath);
    const kind = kindForPath(fsPath, stat.isDirectory());
    const label = displayPath(fsPath);
    const previewDataUrl = await maybePreviewDataUrl(fsPath, kind);
    const attachment: Omit<Attachment, "id"> = {
      kind,
      label: kind === "folder" ? `${label}/` : label,
      fsPath,
      path: label,
      mimeType: kind === "image" ? mimeFromExt(fsPath) : undefined,
      previewDataUrl,
      size: stat.isDirectory() ? undefined : stat.size,
    };
    this.sessions.addAttachment(attachment);
    return { id: "", ...attachment };
  }

  async attachImageBase64(input: {
    name: string;
    mimeType: string;
    base64: string;
  }): Promise<Attachment> {
    const raw = Buffer.from(input.base64, "base64");
    if (raw.byteLength === 0) {
      throw new Error("Empty image data");
    }
    if (raw.byteLength > 12 * 1024 * 1024) {
      throw new Error("Image is larger than 12MB");
    }

    const dir = path.join(this.storageUri.fsPath, "pasted-images");
    await fs.mkdir(dir, { recursive: true });

    const safeBase = (input.name || "paste")
      .replace(/[^\w.\-]+/g, "_")
      .slice(0, 80);
    const ext =
      path.extname(safeBase) ||
      (input.mimeType === "image/jpeg"
        ? ".jpg"
        : input.mimeType === "image/webp"
          ? ".webp"
          : input.mimeType === "image/gif"
            ? ".gif"
            : ".png");
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}${ext.startsWith(".") ? ext : `.${ext}`}`;
    const fsPath = path.join(dir, filename.endsWith(ext) ? filename : `${filename}${ext}`);
    // Prefer generated unique name.
    const finalPath = path.join(dir, filename);
    await fs.writeFile(finalPath, raw);

    const previewDataUrl = `data:${input.mimeType || "image/png"};base64,${input.base64}`;
    const label = `paste/${path.basename(finalPath)}`;
    const attachment: Omit<Attachment, "id"> = {
      kind: "image",
      label,
      fsPath: finalPath,
      path: label,
      mimeType: input.mimeType || "image/png",
      previewDataUrl,
      size: raw.byteLength,
    };
    this.sessions.addAttachment(attachment);
    return { id: "", ...attachment };
  }

  async attachTextFile(input: {
    name: string;
    content: string;
    language?: string;
  }): Promise<void> {
    if (input.content.length > 400_000) {
      throw new Error(`File ${input.name} is too large to paste inline`);
    }
    this.sessions.addAttachment({
      kind: "text",
      label: input.name,
      path: input.name,
      language: input.language,
      content: input.content,
      size: Buffer.byteLength(input.content, "utf8"),
    });
  }

  async showAttachMenu(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(file) Attach files…", id: "files" },
        { label: "$(folder) Attach folder…", id: "folder" },
        { label: "$(file-code) Attach current file", id: "current" },
        { label: "$(selection) Attach selection", id: "selection" },
      ],
      { title: "Attach to OMP chat", placeHolder: "Choose what to attach" },
    );
    if (!pick) {
      return;
    }
    if (pick.id === "files") {
      await this.attachFiles();
      return;
    }
    if (pick.id === "folder") {
      await this.attachFolder();
      return;
    }
    if (pick.id === "current") {
      await vscode.commands.executeCommand("ompChat.attachCurrentFile");
      return;
    }
    if (pick.id === "selection") {
      await vscode.commands.executeCommand("ompChat.sendSelection");
    }
  }
}

export function isProbablyTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (!ext) {
    return true;
  }
  return TEXT_EXTS.has(ext);
}

export function uploadsDir(): string {
  return path.join(os.tmpdir(), "omp-vscode-uploads");
}
