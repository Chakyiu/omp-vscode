import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export interface OmpModelInfo {
  provider: string;
  id: string;
  selector: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

function formatTokens(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export async function listOmpModels(ompPath: string): Promise<OmpModelInfo[]> {
  try {
    const { stdout } = await execFileAsync(ompPath, ["models", "--json"], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    const parsed = JSON.parse(stdout) as { models?: OmpModelInfo[] } | OmpModelInfo[];
    const models = Array.isArray(parsed) ? parsed : parsed.models ?? [];
    return models
      .filter((m) => m && (m.selector || m.id))
      .map((m) => ({
        provider: m.provider || "",
        id: m.id || m.selector,
        selector: m.selector || (m.provider ? `${m.provider}/${m.id}` : m.id),
        name: m.name || m.id,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoning: m.reasoning,
      }));
  } catch {
    // Fallback: plain text listing
    try {
      const { stdout } = await execFileAsync(ompPath, ["models"], {
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
      });
      const models: OmpModelInfo[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^\s*[│|]?\s*([A-Za-z0-9._:+/-]+)\s*[│|]/);
        if (!m) continue;
        const name = m[1];
        if (!name || name === "model" || name.includes("─") || name.includes("context")) continue;
        models.push({ provider: "", id: name, selector: name, name });
      }
      return models;
    } catch {
      return [];
    }
  }
}

export async function pickModel(ompPath: string, current?: string): Promise<string | undefined> {
  const models = await listOmpModels(ompPath);
  if (models.length === 0) {
    const typed = await vscode.window.showInputBox({
      title: "Select Oh My Pi model",
      prompt: "Could not list models. Type a model id/selector (or leave blank for default).",
      value: current || "",
      placeHolder: "e.g. opus, gpt-5.2, cursor/claude-4.6-sonnet-medium",
    });
    return typed === undefined ? undefined : typed.trim();
  }

  const items: (vscode.QuickPickItem & { selector?: string })[] = [
    {
      label: "$(clear-all) Default",
      description: "Use omp default model",
      selector: "",
    },
    ...models.map((m) => {
      const ctx = formatTokens(m.contextWindow);
      const bits = [
        m.provider,
        ctx ? `${ctx} ctx` : "",
        m.reasoning ? "reasoning" : "",
        current && (current === m.selector || current === m.id || current === m.name)
          ? "current"
          : "",
      ].filter(Boolean);
      return {
        label: m.name || m.id,
        description: bits.join(" · "),
        detail: m.selector,
        selector: m.selector,
      };
    }),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: "Select Oh My Pi model",
    placeHolder: current || "Choose a model",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return undefined;
  if (picked.selector === "") return "";
  return picked.selector ?? picked.detail ?? picked.label;
}

export async function pickMode(current?: string): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "Agent", description: "Full coding agent" },
      { label: "Ask", description: "Answer questions with less tool use" },
      { label: "Plan", description: "Plan first (read-oriented)" },
    ],
    {
      title: "Mode",
      placeHolder: current || "Agent",
    },
  );
  return picked?.label;
}
