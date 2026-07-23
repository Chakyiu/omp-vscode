import type { ToolFileRef } from "./types";

const TOOL_PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "filepath",
  "file",
  "target_notebook",
  "target",
  "entry",
  "name",
] as const;

const LINE_SEL_RE = /^(raw|conflicts|\d+(?:[-+]\d*)?(?:,\d+(?:[-+]\d*)?)*)$/i;
const HASHLINE_HEADER_RE = /\[\s*([^\]\n#]+?)\s*#[0-9A-Fa-f]{4,}\s*\]/g;
const HASHLINE_OP_RE =
  /\b(?:SWAP(?:\.BLK)?|DEL(?:\.BLK)?|INS(?:\.BLK)?\.(?:PRE|POST)|INS\.(?:PRE|POST))\s+(\d+)(?:\.=(\d+))?/g;

export function asToolInputObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number.parseInt(value.trim(), 10);
    if (n >= 1) {
      return n;
    }
  }
  return undefined;
}

/** Parse omp line selectors: `120`, `120-140`, `120+20` (count), comma-lists use the first range. */
export function parseLineSelector(sel: string | undefined | null): { line?: number; endLine?: number } {
  if (!sel) {
    return {};
  }
  const first = String(sel).split(",")[0]?.trim();
  if (!first || !LINE_SEL_RE.test(first) || /^(raw|conflicts)$/i.test(first)) {
    return {};
  }
  const m = first.match(/^(\d+)(?:([-+])(\d+))?$/);
  if (!m) {
    return {};
  }
  const start = Number.parseInt(m[1], 10);
  if (!Number.isFinite(start) || start < 1) {
    return {};
  }
  if (!m[2] || !m[3]) {
    return { line: start };
  }
  const op = m[2];
  const rhs = Number.parseInt(m[3], 10);
  if (!Number.isFinite(rhs)) {
    return { line: start };
  }
  if (op === "+") {
    if (rhs < 1) {
      return { line: start };
    }
    return { line: start, endLine: start + rhs - 1 };
  }
  if (rhs < start) {
    return { line: start };
  }
  return { line: start, endLine: rhs };
}

/** Strip trailing `:120` / `:120-140` selectors from a path-like string. */
export function splitPathAndSelector(raw: string): { path: string; line?: number; endLine?: number } {
  let path = String(raw || "").trim();
  const sels: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const idx = path.lastIndexOf(":");
    if (idx <= 0) {
      break;
    }
    const maybe = path.slice(idx + 1);
    if (!LINE_SEL_RE.test(maybe)) {
      break;
    }
    sels.unshift(maybe);
    path = path.slice(0, idx);
  }
  const range = parseLineSelector(sels.join(":") || undefined);
  return { path, ...range };
}

export function extractHashlinePaths(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(HASHLINE_HEADER_RE.source, "g");
  const src = String(text || "");
  let match: RegExpExecArray | null = re.exec(src);
  while (match) {
    const value = match[1]?.trim().replace(/^['"]|['"]$/g, "");
    if (value) {
      out.push(value);
    }
    match = re.exec(src);
  }
  return out;
}

export function extractHashlinePath(text: string): string | undefined {
  return extractHashlinePaths(text)[0];
}

function extractHashlineOpRange(text: string): { line?: number; endLine?: number } {
  let line: number | undefined;
  let endLine: number | undefined;
  const re = new RegExp(HASHLINE_OP_RE.source, "g");
  let match: RegExpExecArray | null = re.exec(String(text || ""));
  while (match) {
    const start = Number.parseInt(match[1], 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : start;
    if (Number.isFinite(start) && start >= 1) {
      line = line == null ? start : Math.min(line, start);
      const capped = Number.isFinite(end) && end >= start ? end : start;
      endLine = endLine == null ? capped : Math.max(endLine, capped);
    }
    match = re.exec(String(text || ""));
  }
  if (line == null) {
    return {};
  }
  return endLine && endLine !== line ? { line, endLine } : { line };
}

function extractHashlineRefs(text: string): ToolFileRef[] {
  const src = String(text || "");
  const refs: ToolFileRef[] = [];
  const re = new RegExp(HASHLINE_HEADER_RE.source, "g");
  const matches = [...src.matchAll(re)];
  if (matches.length === 0) {
    const paths = extractHashlinePaths(src);
    const range = extractHashlineOpRange(src);
    for (const path of paths) {
      refs.push({ path, ...range });
    }
    return refs;
  }
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const path = match[1]?.trim().replace(/^['"]|['"]$/g, "");
    if (!path) {
      continue;
    }
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = i + 1 < matches.length ? (matches[i + 1].index ?? src.length) : src.length;
    const range = extractHashlineOpRange(src.slice(bodyStart, bodyEnd));
    refs.push({ path, ...range });
  }
  return refs;
}

function pushRef(refs: ToolFileRef[], ref: ToolFileRef): void {
  const path = ref.path.trim();
  if (!path) {
    return;
  }
  const next: ToolFileRef = { path };
  if (ref.line && ref.line >= 1) {
    next.line = Math.floor(ref.line);
    if (ref.endLine && ref.endLine >= next.line) {
      next.endLine = Math.floor(ref.endLine);
    }
  }
  const existing = refs.find((item) => item.path === next.path);
  if (!existing) {
    refs.push(next);
    return;
  }
  // Prefer a ref that has line info; merge ranges when both have lines.
  if (next.line != null) {
    if (existing.line == null) {
      existing.line = next.line;
      if (next.endLine != null) {
        existing.endLine = next.endLine;
      } else {
        delete existing.endLine;
      }
    } else {
      const start = Math.min(existing.line, next.line);
      const end = Math.max(existing.endLine ?? existing.line, next.endLine ?? next.line);
      existing.line = start;
      if (end !== start) {
        existing.endLine = end;
      } else {
        delete existing.endLine;
      }
    }
  }
}

export function collectToolFileRefs(value: unknown): ToolFileRef[] {
  const refs: ToolFileRef[] = [];

  const fromString = (raw: unknown) => {
    if (typeof raw !== "string") {
      return;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    if (HASHLINE_HEADER_RE.test(trimmed) || HASHLINE_OP_RE.test(trimmed)) {
      // reset lastIndex side effects from .test
      HASHLINE_HEADER_RE.lastIndex = 0;
      HASHLINE_OP_RE.lastIndex = 0;
      for (const ref of extractHashlineRefs(trimmed)) {
        pushRef(refs, ref);
      }
      return;
    }
    HASHLINE_HEADER_RE.lastIndex = 0;
    HASHLINE_OP_RE.lastIndex = 0;
    const split = splitPathAndSelector(trimmed);
    if (split.path) {
      pushRef(refs, split);
    }
  };

  const obj = asToolInputObject(value);
  if (!obj) {
    fromString(value);
    return refs;
  }

  // Explicit line fields from read/edit-style tools.
  const offset = positiveInt(obj.offset ?? obj.startLine ?? obj.start_line ?? obj.line);
  const limit = positiveInt(obj.limit);
  const endLineField = positiveInt(obj.endLine ?? obj.end_line ?? obj.to);
  let rangeFromFields: { line?: number; endLine?: number } = {};
  if (offset != null) {
    rangeFromFields = {
      line: offset,
      endLine:
        endLineField && endLineField >= offset
          ? endLineField
          : limit != null
            ? offset + limit - 1
            : undefined,
    };
  } else if (endLineField != null) {
    rangeFromFields = { line: endLineField, endLine: endLineField };
  } else {
    rangeFromFields = parseLineSelector(
      typeof obj.sel === "string" ? obj.sel : undefined,
    );
  }

  for (const key of TOOL_PATH_KEYS) {
    const raw = obj[key];
    if (typeof raw !== "string" || !raw.trim()) {
      continue;
    }
    const split = splitPathAndSelector(raw);
    pushRef(refs, {
      path: split.path,
      line: split.line ?? rangeFromFields.line,
      endLine: split.endLine ?? rangeFromFields.endLine,
    });
  }

  if (typeof obj.sel === "string" && obj.sel.trim()) {
    const selRange = parseLineSelector(obj.sel);
    if (selRange.line != null && refs.length > 0 && refs[0].line == null) {
      refs[0].line = selRange.line;
      refs[0].endLine = selRange.endLine;
    }
  }

  for (const key of ["input", "_input", "patch", "diff"] as const) {
    fromString(obj[key]);
  }
  if (Array.isArray(obj.paths)) {
    for (const item of obj.paths) {
      fromString(item);
    }
  }
  if (Array.isArray(obj.edits)) {
    for (const edit of obj.edits) {
      for (const ref of collectToolFileRefs(edit)) {
        pushRef(refs, ref);
      }
    }
  }

  // If we only have field ranges and a single path-less situation, nothing else to do.
  return refs;
}

export function collectToolPaths(value: unknown): string[] {
  return collectToolFileRefs(value).map((ref) => ref.path);
}

export function pickToolPath(obj: Record<string, unknown>): string | undefined {
  return collectToolPaths(obj)[0];
}

export function compactToolInput(value: unknown): unknown {
  const obj = asToolInputObject(value);
  if (!obj) {
    return value;
  }
  const bulkyKeys = new Set([
    "contents",
    "content",
    "new_string",
    "old_string",
    "text",
    "code",
    "prompt",
    "message",
    "input",
    "_input",
    "patch",
  ]);
  const pathValue = pickToolPath(obj);
  const hasBulky = Object.keys(obj).some(
    (key) => bulkyKeys.has(key) && typeof obj[key] === "string" && String(obj[key]).length > 80,
  );
  if (!pathValue || !hasBulky) {
    return obj;
  }
  const slim: Record<string, unknown> = { path: pathValue };
  for (const key of TOOL_PATH_KEYS) {
    if (typeof obj[key] === "string" && String(obj[key]).trim()) {
      slim[key] = obj[key];
    }
  }
  // Keep line navigation fields even when input is compacted.
  for (const key of ["offset", "limit", "sel", "startLine", "endLine", "start_line", "end_line", "line", "to"] as const) {
    if (obj[key] != null) {
      slim[key] = obj[key];
    }
  }
  for (const [key, raw] of Object.entries(obj)) {
    if (key in slim) {
      continue;
    }
    if (typeof raw === "string" && bulkyKeys.has(key)) {
      if ((key === "input" || key === "_input" || key === "patch") && extractHashlinePath(raw)) {
        // Keep enough of the hashline header + first op for path/line recovery.
        slim[key] = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
      } else {
        slim[key] = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
      }
      continue;
    }
    if (typeof raw === "string" && raw.length > 160) {
      slim[key] = `${raw.slice(0, 160)}…`;
      continue;
    }
    slim[key] = raw;
  }
  return slim;
}

export function preview(value: unknown, max = 400): string | undefined {
  if (value == null) {
    return undefined;
  }
  const compact = compactToolInput(value);
  const text = typeof compact === "string" ? compact : JSON.stringify(compact, null, 2);
  if (!text) {
    return undefined;
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
