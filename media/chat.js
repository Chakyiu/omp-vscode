(function () {
  const vscode = acquireVsCodeApi();
  const collapseOpenIds = new Set();
  /** Webview wall-clock for thinking blocks: id -> { startedAt, endedAt }. */
  const thinkingClock = new Map();
  let thinkingTimer = null;

  const messagesEl = document.getElementById("messages");
  const emptyEl = document.getElementById("empty");
  const statusDot = document.getElementById("statusDot");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const stopBtn = document.getElementById("stopBtn");
  const newChatBtn = document.getElementById("newChatBtn");
  const historyBtn = document.getElementById("historyBtn");
  const moreBtn = document.getElementById("moreBtn");
  const attachBtn = document.getElementById("attachBtn");
  const attachFilesBtn = document.getElementById("attachFilesBtn");
  const attachFolderBtn = document.getElementById("attachFolderBtn");
  const attachmentsEl = document.getElementById("attachments");
  const dropOverlay = document.getElementById("dropOverlay");
  const modelBtn = document.getElementById("modelBtn");
  const modeBtn = document.getElementById("modeBtn");
  const modelLabel = document.getElementById("modelLabel");
  const modeLabel = document.getElementById("modeLabel");
  const greetingTitle = document.getElementById("greetingTitle");
  const usageBtn = document.getElementById("usageBtn");
  const usageLabel = document.getElementById("usageLabel");
  const usageProgress = document.getElementById("usageProgress");
  const tabsEl = document.getElementById("tabs");
  const suggestEl = document.getElementById("suggest");
  const suggestHeaderEl = document.getElementById("suggestHeader");
  const suggestListEl = document.getElementById("suggestList");
  const uiQuestionEl = document.getElementById("uiQuestion");
  const activeQuestionEl = document.getElementById("activeQuestion");
  const imagePreviewEl = document.getElementById("imagePreview");
  const imagePreviewImg = document.getElementById("imagePreviewImg");
  const queuePanelEl = document.getElementById("queuePanel");
  const queueToggleEl = document.getElementById("queueToggle");
  const queueToggleLabelEl = document.getElementById("queueToggleLabel");
  const queueMenuEl = document.getElementById("queueMenu");
  const queueListEl = document.getElementById("queueList");

  let state = {
    status: { state: "starting", detail: "Starting…" },
    messages: [],
    attachments: [],
    showThinking: true,
    model: "Model",
    mode: "Agent",
    displayName: "",
    contextUsage: null,
    tabs: [],
    activeTabId: "",
    uiQuestion: null,
  };

  let dragDepth = 0;
  // Follow new output only while the user is already near the bottom.
  let stickToBottom = true;
  let activeTabIdForScroll = "";
  let queueMenuOpen = false;

  function isNearBottom(el, threshold) {
    if (!el) return true;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    return gap <= (threshold == null ? 80 : threshold);
  }

  function scrollMessagesToBottom(force) {
    if (!messagesEl) return;
    if (!force && !stickToBottom) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    stickToBottom = true;
  }

  const SLASH_COMMANDS = [
    { id: "new", label: "/new", detail: "Start a new chat" },
    { id: "clear", label: "/clear", detail: "Clear and start a new chat" },
    { id: "stop", label: "/stop", detail: "Stop generation" },
    { id: "restart", label: "/restart", detail: "Restart omp session" },
    { id: "model", label: "/model", detail: "Select model" },
    { id: "mode", label: "/mode", detail: "Select mode" },
    { id: "attach", label: "/attach", detail: "Attach files" },
    { id: "folder", label: "/folder", detail: "Attach a folder" },
    { id: "usage", label: "/usage", detail: "Show context usage" },
    { id: "history", label: "/history", detail: "Switch chat tabs" },
    { id: "help", label: "/help", detail: "List available commands" },
  ];

  let suggest = {
    open: false,
    kind: null, // "file" | "command"
    items: [],
    active: 0,
    start: 0,
    end: 0,
    query: "",
    requestId: 0,
  };
  let searchTimer = null;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isSafeHref(href) {
    if (!href) return false;
    const value = String(href).trim();
    if (!value) return false;
    if (/^\s*javascript:/i.test(value)) return false;
    if (/^\s*data:/i.test(value)) return false;
    return /^(https?:\/\/|vscode:|file:|mailto:|#|\/|\.\/|\.\.\/|[A-Za-z]:\\)/i.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value);
  }

  function renderInlineMarkdown(text) {
    const codes = [];
    let s = String(text == null ? "" : text);
    s = s.replace(/`([^`\n]+)`/g, function (_, code) {
      codes.push(code);
      return "\u0000CODE" + (codes.length - 1) + "\u0000";
    });
    s = escapeHtml(s);

    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, function (_, label, href, title) {
      if (!isSafeHref(href)) return label;
      const titleAttr = title ? ' title="' + escapeHtml(title) + '"' : "";
      return '<a href="' + escapeHtml(href) + '" data-href="' + escapeHtml(href) + '"' + titleAttr + ">" + label + "</a>";
    });

    s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?!\s)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)(?!\s)_(?!_)/g, "$1<em>$2</em>");

    s = s.replace(/\u0000CODE(\d+)\u0000/g, function (_, idx) {
      return "<code>" + escapeHtml(codes[Number(idx)] || "") + "</code>";
    });
    return s;
  }

  function renderCodeBlock(lang, code) {
    const clean = String(code || "").replace(/\n$/, "");
    const safe = escapeHtml(clean);
    return (
      '<div class="md-code">' +
        '<div class="md-pre" data-code="' + encodeURIComponent(clean) + '"><code data-lang="' + escapeHtml(lang || "") + '">' + safe + "</code></div>" +
        '<div class="code-actions">' +
          '<button class="mini" data-action="copy-code">Copy</button>' +
          '<button class="mini" data-action="insert-code">Insert</button>' +
        "</div>" +
      "</div>"
    );
  }

  function renderMarkdownBlocks(src) {
    const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
    let html = "";
    let i = 0;

    function flushParagraph(buf) {
      if (!buf.length) return;
      const body = buf.map(function (line) { return renderInlineMarkdown(line); }).join("<br>");
      html += '<p>' + body + "</p>";
      buf.length = 0;
    }

    while (i < lines.length) {
      const line = lines[i];
      if (!String(line).trim()) {
        i += 1;
        continue;
      }

      const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (heading) {
        const level = Math.min(heading[1].length, 4);
        html += "<h" + level + ">" + renderInlineMarkdown(heading[2]) + "</h" + level + ">";
        i += 1;
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        html += "<hr />";
        i += 1;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        html += "<blockquote>" + renderMarkdownBlocks(quote.join("\n")) + "</blockquote>";
        continue;
      }

      if (/^\s*([-*+])\s+/.test(line)) {
        html += "<ul>";
        while (i < lines.length && /^\s*([-*+])\s+/.test(lines[i])) {
          const item = lines[i].replace(/^\s*([-*+])\s+/, "");
          html += "<li>" + renderInlineMarkdown(item) + "</li>";
          i += 1;
        }
        html += "</ul>";
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        html += "<ol>";
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          const item = lines[i].replace(/^\s*\d+\.\s+/, "");
          html += "<li>" + renderInlineMarkdown(item) + "</li>";
          i += 1;
        }
        html += "</ol>";
        continue;
      }

      const para = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (!String(cur).trim()) break;
        if (/^(#{1,6})\s+/.test(cur)) break;
        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(cur)) break;
        if (/^\s*>\s?/.test(cur)) break;
        if (/^\s*([-*+])\s+/.test(cur)) break;
        if (/^\s*\d+\.\s+/.test(cur)) break;
        para.push(cur);
        i += 1;
      }
      flushParagraph(para);
    }

    return html;
  }

  function renderMarkdownish(text) {
    const raw = String(text == null ? "" : text);
    const parts = raw.split(/```/);
    let html = "";
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        html += renderMarkdownBlocks(parts[i]);
      } else {
        const block = parts[i];
        const nl = block.indexOf("\n");
        let lang = "";
        let code = block;
        if (nl >= 0) {
          lang = block.slice(0, nl).trim();
          code = block.slice(nl + 1);
        }
        html += renderCodeBlock(lang, code);
      }
    }
    return html || "<p></p>";
  }

  function hasTextPart(msg) {
    return Boolean(msg && msg.parts && msg.parts.some(function (p) { return p.kind === "text" && p.text; }));
  }

  function partsSignature(parts) {
    return (parts || []).map(function (p) {
      if (!p || !p.kind) return "?";
      if (p.kind === "tool") return "tool:" + String(p.id || p.name || "");
      return String(p.kind);
    }).join("|");
  }

  function thinkingCollapseId(msg, partIndex) {
    return "thinking:" + (msg && msg.id ? msg.id : "msg") + ":" + String(partIndex || 0);
  }

  function isThinkingLive(part, msg) {
    return (
      Boolean(msg && msg.streaming) &&
      (part.streaming === true ||
        (part.streaming !== false && !part.endedAt && hasTextPart(msg) === false))
    );
  }

  function patchThinkingPart(existing, msg, part, partIndex) {
    const collapseId = thinkingCollapseId(msg, partIndex);
    const details = existing.querySelector('[data-collapse-id="' + collapseId.replace(/"/g, "") + '"]');
    if (!details) return false;
    const pre = details.querySelector("pre.thinking-body");
    if (!pre) return false;
    const live = isThinkingLive(part, msg);
    // Only replace text when it actually changed to avoid visible flicker.
    const nextText = part.text || "";
    if (pre.textContent !== nextText) {
      pre.textContent = nextText;
    }
    details.classList.toggle("live", live);
    pre.classList.toggle("streaming", live);
    const summaryLabel = details.querySelector(".collapse-title");
    if (summaryLabel) {
      const nextLabel = thinkingLabel(part, live, collapseId);
      if (summaryLabel.textContent !== nextLabel) {
        summaryLabel.textContent = nextLabel;
      }
    }
    return true;
  }



  if (messagesEl) {
    messagesEl.addEventListener("toggle", function (event) {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("collapse")) return;
      const id = target.getAttribute("data-collapse-id");
      if (!id) return;
      if (target.open) {
        collapseOpenIds.add(id);
        collapseOpenIds.delete("closed:" + id);
      } else {
        collapseOpenIds.delete(id);
        collapseOpenIds.add("closed:" + id);
      }
    }, true);
  }

  function isCollapseOpen(id, autoOpen) {
    if (collapseOpenIds.has(id)) return true;
    if (collapseOpenIds.has("closed:" + id)) return false;
    return Boolean(autoOpen);
  }

  function collapseOpenAttr(id, autoOpen) {
    return isCollapseOpen(id, autoOpen) ? " open" : "";
  }

  function chevronIcon() {
    return (
      '<svg class="collapse-chevron" viewBox="0 0 16 16" aria-hidden="true">' +
        '<path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z"/>' +
      '</svg>'
    );
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    if (ms < 1000) return "<1s";
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + "s";
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    return rem ? min + "m " + rem + "s" : min + "m";
  }

  function thinkingDurationMs(part, collapseId) {
    if (part && Number.isFinite(Number(part.durationMs)) && Number(part.durationMs) > 0) {
      return Number(part.durationMs);
    }
    const clock = collapseId ? thinkingClock.get(collapseId) : null;
    const start = Number(part && part.startedAt != null ? part.startedAt : clock && clock.startedAt);
    const end = Number(
      part && part.endedAt != null
        ? part.endedAt
        : clock && clock.endedAt != null
          ? clock.endedAt
          : Date.now(),
    );
    if (Number.isFinite(start) && end >= start) {
      const measured = end - start;
      if (measured >= 1000) return measured;
    }
    if (clock && Number.isFinite(clock.startedAt)) {
      const localEnd = clock.endedAt != null ? clock.endedAt : Date.now();
      const local = localEnd - clock.startedAt;
      if (local >= 1000) return local;
    }
    return Number.isFinite(start) && end >= start ? Math.max(0, end - start) : 0;
  }

  function thinkingLabel(part, isLive, collapseId) {
    if (isLive) {
      if (collapseId && !thinkingClock.has(collapseId)) {
        thinkingClock.set(collapseId, { startedAt: Date.now() });
      }
      const ms = thinkingDurationMs(part, collapseId);
      const dur = formatDuration(ms);
      return dur && ms >= 1000 ? "Thinking… " + dur : "Thinking…";
    }
    if (collapseId) {
      const clock = thinkingClock.get(collapseId);
      if (clock && clock.endedAt == null) {
        clock.endedAt = Date.now();
        thinkingClock.set(collapseId, clock);
      }
    }
    const ms = thinkingDurationMs(part, collapseId);
    const dur = formatDuration(ms);
    if (dur) return "Thought for " + dur;
    return "Thought";
  }

  function syncThinkingTimer() {
    const hasLive = Boolean(document.querySelector(".collapse.thinking.live"));
    if (!hasLive) {
      if (thinkingTimer) {
        clearInterval(thinkingTimer);
        thinkingTimer = null;
      }
      return;
    }
    if (thinkingTimer) return;
    thinkingTimer = setInterval(function () {
      const nodes = document.querySelectorAll(".collapse.thinking.live");
      if (!nodes.length) {
        clearInterval(thinkingTimer);
        thinkingTimer = null;
        return;
      }
      nodes.forEach(function (details) {
        const id = details.getAttribute("data-collapse-id") || "";
        const title = details.querySelector(".collapse-title");
        if (!title) return;
        if (id && !thinkingClock.has(id)) {
          thinkingClock.set(id, { startedAt: Date.now() });
        }
        const clock = thinkingClock.get(id);
        const ms = clock ? Date.now() - clock.startedAt : 0;
        const dur = formatDuration(ms);
        title.textContent = dur && ms >= 1000 ? "Thinking… " + dur : "Thinking…";
      });
    }, 500);
  }

  function normalizeToolKey(name) {
    return String(name || "tool").trim().toLowerCase();
  }

  function toolLeafName(name) {
    let key = normalizeToolKey(name);
    // Common wrappers: mcp__server_tool, mcp_pi-agent_mcp__server_tool, server/tool
    if (key.includes("mcp__")) {
      key = key.slice(key.lastIndexOf("mcp__") + 5);
    } else if (key.includes("__")) {
      key = key.split("__").pop();
    } else if (key.includes("/")) {
      key = key.split("/").pop();
    }
    key = key.replace(/^mcp[_-]*/, "");
    return key || "tool";
  }

  function humanizeWords(value) {
    return String(value || "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function parseToolIdentity(name) {
    const leaf = toolLeafName(name);
    const prefixes = [
      ["obscura_browser_", "Browser"],
      ["obscura_", "Browser"],
      ["open_design_", "Design"],
      ["headroom_", "Headroom"],
      ["pi-agent_", ""],
      ["pi_agent_", ""],
    ];
    for (let i = 0; i < prefixes.length; i += 1) {
      const prefix = prefixes[i][0];
      const group = prefixes[i][1];
      if (leaf.indexOf(prefix) === 0) {
        return { leaf: leaf, action: leaf.slice(prefix.length), group: group };
      }
    }
    // open_design-style without trailing underscore already handled; also
    // browser_navigate / web_search style single tokens.
    return { leaf: leaf, action: leaf, group: "" };
  }

  function toolTitle(name, inputPreview) {
    const key = normalizeToolKey(name);
    const identity = parseToolIdentity(name);
    const actionKey = identity.action || identity.leaf || key;

    if (key === "bash" || key === "shell" || actionKey === "bash" || actionKey === "shell") {
      const obj = parseToolInput(inputPreview);
      const cmd = obj && (obj.command || obj.cmd);
      if (typeof cmd === "string") {
        if (/^\s*ls\b/.test(cmd)) return "Listed directory";
        if (/^\s*find\b/.test(cmd)) return "Found files";
        if (/^\s*cat\b/.test(cmd)) return "Read";
        if (/^\s*rg\b|^\s*grep\b/.test(cmd)) return "Grep";
      }
      return "Ran command";
    }

    const map = {
      read: "Read",
      read_file: "Read",
      get_file: "Read",
      grep: "Grep",
      glob: "Searched files",
      write: "Wrote",
      write_file: "Wrote",
      edit: "Edited",
      strreplace: "Edited",
      search_replace: "Edited",
      apply_patch: "Edited",
      hashline: "Edited",
      delete: "Deleted",
      delete_file: "Deleted",
      web_search: "Searched web",
      webfetch: "Fetched",
      fetch: "Fetched",
      todo: "Updated todos",
      todowrite: "Updated todos",
      navigate: "Navigate",
      browser_navigate: "Navigate",
      browser_click: "Click",
      click: "Click",
      browser_fill: "Fill",
      fill: "Fill",
      browser_type: "Type",
      type: "Type",
      browser_snapshot: "Snapshot",
      snapshot: "Snapshot",
      browser_screenshot: "Screenshot",
      screenshot: "Screenshot",
      browser_scroll: "Scroll",
      scroll: "Scroll",
      browser_wait_for: "Wait",
      wait_for: "Wait",
      browser_wait_for_text: "Wait for text",
      wait_for_text: "Wait for text",
      browser_tabs: "Browser tabs",
      browser_tab_new: "New tab",
      browser_tab_close: "Close tab",
      browser_reload: "Reload",
      browser_back: "Back",
      browser_forward: "Forward",
      get_artifact: "Get artifact",
      get_project: "Get project",
      list_files: "List files",
      list_projects: "List projects",
      search_files: "Search files",
      create_artifact: "Create artifact",
      create_project: "Create project",
      start_run: "Start run",
      get_run: "Get run",
      compress: "Compress",
      headroom_compress: "Compress",
      retrieve: "Retrieve",
      headroom_retrieve: "Retrieve",
    };

    if (map[key]) return map[key];
    if (map[identity.leaf]) return map[identity.leaf];
    if (map[actionKey]) return map[actionKey];

    const pretty = humanizeWords(actionKey);
    if (identity.group && pretty) {
      // Keep the title short: action only. Group is implied by wording.
      return pretty;
    }
    return pretty || "Tool";
  }

  function parseToolInput(preview) {
    if (!preview) return null;
    const text = String(preview).trim();
    if (!text) return null;
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch (_) {
      // fall through
    }
    return null;
  }

  var TOOL_PATH_KEYS = [
    "path",
    "file_path",
    "filePath",
    "filepath",
    "file",
    "target_notebook",
    "target",
    "entry",
    "name",
  ];

  function isFilePathTool(name) {
    const key = normalizeToolKey(name);
    const identity = parseToolIdentity(name);
    const actionKey = identity.action || identity.leaf || key;
    return (
      /^(read|write|edit|delete|get_file|write_file|delete_file|strreplace|search_replace|create_artifact|apply_patch|hashline)$/.test(actionKey) ||
      /^(read|write|edit|delete|strreplace|search_replace|apply_patch|hashline)$/.test(key)
    );
  }

  function unescapeJsonString(value) {
    try {
      return JSON.parse('"' + value + '"');
    } catch (_) {
      return String(value || "");
    }
  }

  function normalizeToolFilePath(pathValue) {
    let value = String(pathValue || "").trim();
    if (!value) return "";
    if (value.indexOf("file://") === 0) {
      try {
        value = decodeURIComponent(value.slice("file://".length));
      } catch (_) {
        value = value.slice("file://".length);
      }
      if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
    }
    return value.trim();
  }

  function extractHashlinePaths(text) {
    const src = String(text || "");
    const out = [];
    const re = /\[\s*([^\]\n#]+?)\s*#[0-9A-Fa-f]{4,}\s*\]/g;
    let match;
    while ((match = re.exec(src))) {
      const value = match[1] ? match[1].trim().replace(/^["']|["']$/g, "") : "";
      if (value) out.push(value);
    }
    return out;
  }

  function extractHashlinePath(text) {
    const all = extractHashlinePaths(text);
    return all.length ? all[0] : "";
  }

  function parseLineSelector(sel) {
    if (!sel) return {};
    const first = String(sel).split(",")[0].trim();
    if (!first || /^(raw|conflicts)$/i.test(first)) return {};
    if (!/^(\d+)(?:([-+])(\d+))?$/.test(first)) return {};
    const m = first.match(/^(\d+)(?:([-+])(\d+))?$/);
    const start = parseInt(m[1], 10);
    if (!Number.isFinite(start) || start < 1) return {};
    if (!m[2] || !m[3]) return { line: start };
    const rhs = parseInt(m[3], 10);
    if (!Number.isFinite(rhs)) return { line: start };
    if (m[2] === "+") {
      if (rhs < 1) return { line: start };
      return { line: start, endLine: start + rhs - 1 };
    }
    if (rhs < start) return { line: start };
    return { line: start, endLine: rhs };
  }

  function splitPathAndSelector(raw) {
    let path = String(raw || "").trim();
    const sels = [];
    for (let i = 0; i < 2; i += 1) {
      const idx = path.lastIndexOf(":");
      if (idx <= 0) break;
      const maybe = path.slice(idx + 1);
      if (!/^(raw|conflicts|\d+(?:[-+]\d*)?(?:,\d+(?:[-+]\d*)?)*)$/i.test(maybe)) break;
      sels.unshift(maybe);
      path = path.slice(0, idx);
    }
    const range = parseLineSelector(sels.join(":") || "");
    return { path: path, line: range.line, endLine: range.endLine };
  }

  function extractHashlineOpRange(text) {
    const re = /\b(?:SWAP(?:\.BLK)?|DEL(?:\.BLK)?|INS(?:\.BLK)?\.(?:PRE|POST)|INS\.(?:PRE|POST))\s+(\d+)(?:\.=(\d+))?/g;
    let line;
    let endLine;
    let match;
    const src = String(text || "");
    while ((match = re.exec(src))) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : start;
      if (!Number.isFinite(start) || start < 1) continue;
      line = line == null ? start : Math.min(line, start);
      const capped = Number.isFinite(end) && end >= start ? end : start;
      endLine = endLine == null ? capped : Math.max(endLine, capped);
    }
    if (line == null) return {};
    return endLine && endLine !== line ? { line: line, endLine: endLine } : { line: line };
  }

  function extractHashlineRefs(text) {
    const src = String(text || "");
    const refs = [];
    const re = /\[\s*([^\]\n#]+?)\s*#[0-9A-Fa-f]{4,}\s*\]/g;
    const matches = [];
    let match;
    while ((match = re.exec(src))) matches.push(match);
    if (!matches.length) {
      const paths = extractHashlinePaths(src);
      const range = extractHashlineOpRange(src);
      for (let i = 0; i < paths.length; i += 1) {
        refs.push({ path: paths[i], line: range.line, endLine: range.endLine });
      }
      return refs;
    }
    for (let i = 0; i < matches.length; i += 1) {
      const m = matches[i];
      const path = m[1] ? m[1].trim().replace(/^["']|["']$/g, "") : "";
      if (!path) continue;
      const bodyStart = m.index + m[0].length;
      const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : src.length;
      const range = extractHashlineOpRange(src.slice(bodyStart, bodyEnd));
      refs.push({ path: path, line: range.line, endLine: range.endLine });
    }
    return refs;
  }

  function pushToolFileRef(refs, ref) {
    const path = normalizeToolFilePath(ref && ref.path);
    if (!path) return;
    const next = { path: path };
    if (ref.line && ref.line >= 1) {
      next.line = Math.floor(ref.line);
      if (ref.endLine && ref.endLine >= next.line) next.endLine = Math.floor(ref.endLine);
    }
    for (let i = 0; i < refs.length; i += 1) {
      if (refs[i].path === next.path) {
        if (next.line != null) {
          if (refs[i].line == null) {
            refs[i].line = next.line;
            refs[i].endLine = next.endLine;
          } else {
            const start = Math.min(refs[i].line, next.line);
            const end = Math.max(refs[i].endLine || refs[i].line, next.endLine || next.line);
            refs[i].line = start;
            if (end !== start) refs[i].endLine = end;
            else delete refs[i].endLine;
          }
        }
        return;
      }
    }
    refs.push(next);
  }

  function positiveLine(value) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.floor(value);
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const n = parseInt(value.trim(), 10);
      if (n >= 1) return n;
    }
    return null;
  }

  function collectToolFileRefsFromPreview(previewText) {
    const refs = [];
    const obj = parseToolInput(previewText);
    if (!obj) {
      const text = String(previewText || "");
      if (/\[\s*[^\]\n#]+?\s*#[0-9A-Fa-f]{4,}\s*\]/.test(text) || /\b(?:SWAP|DEL|INS\.)/.test(text)) {
        extractHashlineRefs(text).forEach(function (ref) { pushToolFileRef(refs, ref); });
      } else {
        const split = splitPathAndSelector(text);
        if (split.path) pushToolFileRef(refs, split);
      }
      return refs;
    }

    const offset = positiveLine(obj.offset != null ? obj.offset : (obj.startLine != null ? obj.startLine : (obj.start_line != null ? obj.start_line : obj.line)));
    const limit = positiveLine(obj.limit);
    const endLineField = positiveLine(obj.endLine != null ? obj.endLine : (obj.end_line != null ? obj.end_line : obj.to));
    let fieldRange = {};
    if (offset != null) {
      fieldRange = {
        line: offset,
        endLine: endLineField && endLineField >= offset ? endLineField : (limit != null ? offset + limit - 1 : undefined),
      };
    } else if (typeof obj.sel === "string") {
      fieldRange = parseLineSelector(obj.sel);
    }

    for (let i = 0; i < TOOL_PATH_KEYS.length; i += 1) {
      const value = obj[TOOL_PATH_KEYS[i]];
      if (typeof value !== "string" || !value.trim()) continue;
      const split = splitPathAndSelector(value);
      pushToolFileRef(refs, {
        path: split.path,
        line: split.line || fieldRange.line,
        endLine: split.endLine || fieldRange.endLine,
      });
    }

    ["input", "_input", "patch", "diff"].forEach(function (key) {
      if (typeof obj[key] === "string" && obj[key].trim()) {
        extractHashlineRefs(obj[key]).forEach(function (ref) { pushToolFileRef(refs, ref); });
      }
    });
    if (Array.isArray(obj.paths)) {
      obj.paths.forEach(function (item) {
        if (typeof item === "string") {
          const split = splitPathAndSelector(item);
          if (split.path) pushToolFileRef(refs, split);
        }
      });
    }
    if (Array.isArray(obj.edits)) {
      obj.edits.forEach(function (edit) {
        if (edit && typeof edit === "object") {
          // Recurse via JSON preview for nested edit objects.
          collectToolFileRefsFromPreview(JSON.stringify(edit)).forEach(function (ref) {
            pushToolFileRef(refs, ref);
          });
        }
      });
    }
    return refs;
  }

  function pickToolPathFromObject(obj) {
    if (!obj || typeof obj !== "object") return "";
    for (let i = 0; i < TOOL_PATH_KEYS.length; i += 1) {
      const value = obj[TOOL_PATH_KEYS[i]];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    const nestedKeys = ["input", "_input", "patch", "diff"];
    for (let i = 0; i < nestedKeys.length; i += 1) {
      const nested = obj[nestedKeys[i]];
      if (typeof nested === "string" && nested.trim()) {
        const fromHashline = extractHashlinePath(nested);
        if (fromHashline) return fromHashline;
      }
    }
    if (Array.isArray(obj.paths)) {
      for (let i = 0; i < obj.paths.length; i += 1) {
        if (typeof obj.paths[i] === "string" && obj.paths[i].trim()) {
          return obj.paths[i].trim();
        }
      }
    }
    if (Array.isArray(obj.edits)) {
      for (let i = 0; i < obj.edits.length; i += 1) {
        const edit = obj.edits[i];
        if (edit && typeof edit === "object") {
          const nested = pickToolPathFromObject(edit);
          if (nested) return nested;
        }
      }
    }
    return "";
  }

  function extractToolFilePath(name, previewText) {
    if (!isFilePathTool(name)) return "";
    const refs = collectToolFileRefsFromPreview(previewText);
    return refs.length ? refs[0].path : "";
  }

  function formatToolFilePath(pathValue, line, endLine) {
    const value = normalizeToolFilePath(pathValue);
    if (!value) return "";
    const display = value.replace(/\\/g, "/");
    const parts = display.split("/").filter(Boolean);
    const base = parts.length ? parts[parts.length - 1] : display;
    if (line && line >= 1) {
      if (endLine && endLine > line) return base + ":" + line + "-" + endLine;
      return base + ":" + line;
    }
    return base;
  }

  function fileChipIcon() {
    return (
      '<svg class="file-link-icon" viewBox="0 0 16 16" aria-hidden="true">' +
        '<path fill="currentColor" d="M9.5 1.1H4.75A1.75 1.75 0 0 0 3 2.85v10.3c0 .97.78 1.75 1.75 1.75h6.5c.97 0 1.75-.78 1.75-1.75V5.6L9.5 1.1zm.25 1.48L12.4 5.2H9.75a.5.5 0 0 1-.5-.5V2.58zM4.75 13.4a.25.25 0 0 1-.25-.25V2.85c0-.14.11-.25.25-.25H8v2.6A2 2 0 0 0 10 7.2h2.25v5.95a.25.25 0 0 1-.25.25h-7.25z"/>' +
      "</svg>"
    );
  }

  function renderFileLink(refOrPath) {
    const ref = typeof refOrPath === "string" ? { path: refOrPath } : (refOrPath || {});
    const full = normalizeToolFilePath(ref.path);
    if (!full) return "";
    const line = ref.line && ref.line >= 1 ? Math.floor(ref.line) : 0;
    const endLine = ref.endLine && ref.endLine >= line ? Math.floor(ref.endLine) : 0;
    const display = formatToolFilePath(full, line, endLine);
    const title = line
      ? full + ":" + line + (endLine && endLine !== line ? "-" + endLine : "")
      : full;
    return (
      '<button type="button" class="file-link" data-action="open-file" data-path="' +
        escapeHtml(full) +
        '"' +
        (line ? ' data-line="' + line + '"' : "") +
        (endLine && endLine !== line ? ' data-end-line="' + endLine + '"' : "") +
        ' title="' + escapeHtml(title) + '">' +
        fileChipIcon() +
        '<span class="file-link-label">' + escapeHtml(display) + '</span>' +
      "</button>"
    );
  }

  function toolSummary(name, inputPreview) {
    const obj = parseToolInput(inputPreview);
    const key = normalizeToolKey(name);
    const identity = parseToolIdentity(name);
    const actionKey = identity.action || identity.leaf || key;
    if (!obj) {
      const one = String(inputPreview || "").replace(/\s+/g, " ").trim();
      return one.length > 72 ? one.slice(0, 72) + "…" : one;
    }
    const pick = function () {
      for (let i = 0; i < arguments.length; i += 1) {
        const v = obj[arguments[i]];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return "";
    };
    let value = "";
    if (key === "bash" || key === "shell" || actionKey === "bash" || actionKey === "shell") {
      value = pick("command", "cmd");
      if (/^\s*ls\b/.test(value)) return value;
    } else if (actionKey === "grep" || key === "grep") {
      value = pick("pattern", "query", "path");
    } else if (actionKey === "glob" || key === "glob") {
      value = pick("path", "glob_pattern", "pattern");
    } else if (
      /^(read|write|edit|delete|get_file|write_file|delete_file|strreplace|search_replace|apply_patch|hashline)$/.test(actionKey) ||
      /^(read|write|edit|delete|strreplace|search_replace|apply_patch|hashline)$/.test(key)
    ) {
      value = pick("path", "file_path", "filePath", "filepath", "file", "target_notebook", "target", "entry", "name");
      if (!value) value = extractHashlinePath(pick("input", "_input", "patch") || "");
      if (value) value = formatToolFilePath(value);
    } else if (/navigate|screenshot|snapshot|click|fill|type|scroll|wait/.test(actionKey)) {
      value = pick("url", "uri", "selector", "ref", "text", "query", "i", "name", "path");
    } else if (/artifact|project|run|file/.test(actionKey)) {
      value = pick("entry", "path", "name", "project", "runId", "url", "i");
      if (value) {
        const parts = value.split(/[\\/]/);
        if (parts.length > 2) value = parts.slice(-2).join("/");
      }
    } else {
      value = pick("path", "url", "uri", "entry", "query", "pattern", "command", "name", "selector", "text", "i");
    }
    if (!value) {
      try {
        value = JSON.stringify(obj);
      } catch (_) {
        value = String(inputPreview || "");
      }
    }
    value = value.replace(/\s+/g, " ").trim();
    return value.length > 72 ? value.slice(0, 72) + "…" : value;
  }

  function statusBadge(status) {
    const s = String(status || "done");
    if (s === "done") {
      return '<span class="badge done" title="Done">✓</span>';
    }
    if (s === "error") {
      return '<span class="badge error" title="Error">!</span>';
    }
    return '<span class="badge running" title="Running"><span class="badge-dot"></span></span>';
  }

  function renderPart(part, msg, partIndex) {
    if (part.kind === "thinking") {
      if (state.showThinking === false) return "";
      const isLive = isThinkingLive(part, msg);
      const collapseId = thinkingCollapseId(msg, partIndex);
      const openAttr = collapseOpenAttr(collapseId, isLive);
      const liveClass = isLive ? " live" : "";
      const streamClass = isLive ? " streaming" : "";
      const label = thinkingLabel(part, isLive, collapseId);
      const body = escapeHtml(part.text || "");
      return (
        '<details class="collapse thinking' + liveClass + '" data-collapse-id="' + escapeHtml(collapseId) + '"' + openAttr + '>' +
          '<summary class="collapse-summary">' +
            '<span class="collapse-row">' +
              chevronIcon() +
              '<span class="collapse-title">' + escapeHtml(label) + '</span>' +
            '</span>' +
          '</summary>' +
          '<div class="collapse-body">' +
            '<pre class="thinking-body' + streamClass + '">' + body + '</pre>' +
          '</div>' +
        '</details>'
      );
    }
    if (part.kind === "tool") {
      const running = part.status === "running";
      const collapseId = "tool:" + String(part.id || part.name || "tool");
      // Keep tool/command cards collapsed until the user expands them.
      const openAttr = collapseOpenAttr(collapseId, false);
      const liveClass = running ? " live" : "";
      const title = toolTitle(part.name, part.inputPreview) || (running ? "Running tool" : "Tool");
      const toolKey = normalizeToolKey(part.name);
      const toolIdentity = parseToolIdentity(part.name);
      const toolAction = toolIdentity.action || toolIdentity.leaf || toolKey;
      const isCommandTool =
        toolKey === "bash" ||
        toolKey === "shell" ||
        toolAction === "bash" ||
        toolAction === "shell";
      const fileRefs = [];
      const singleFileTool = isFilePathTool(part.name);
      // Ran command should show the command text, not file hyperlinks mined from argv.
      if (!isCommandTool) {
        if (Array.isArray(part.fileRefs)) {
          for (let i = 0; i < part.fileRefs.length; i += 1) {
            pushToolFileRef(fileRefs, part.fileRefs[i]);
            if (singleFileTool && fileRefs.length >= 1) break;
          }
        }
        if ((!singleFileTool || fileRefs.length === 0) && Array.isArray(part.filePaths)) {
          for (let i = 0; i < part.filePaths.length; i += 1) {
            pushToolFileRef(fileRefs, { path: part.filePaths[i] });
            if (singleFileTool && fileRefs.length >= 1) break;
          }
        }
        // Only mine the tool input for paths. Output previews (especially Read)
        // often contain other file paths from file contents and create noisy chips.
        if (fileRefs.length === 0 || !singleFileTool) {
          collectToolFileRefsFromPreview(part.inputPreview || "").forEach(function (ref) {
            if (singleFileTool && fileRefs.length >= 1) return;
            pushToolFileRef(fileRefs, ref);
          });
        }
        if (singleFileTool && fileRefs.length > 1) {
          fileRefs.length = 1;
        }
      }
      const summary = fileRefs.length ? "" : toolSummary(part.name, part.inputPreview);
      const summaryHtml = fileRefs.length
        ? '<span class="collapse-meta">' + fileRefs.map(renderFileLink).join('<span class="file-sep"> · </span>') + '</span>'
        : (summary ? '<span class="collapse-meta">' + escapeHtml(summary) + '</span>' : "");
      const sections = [];
      if (part.inputPreview) {
        sections.push(
          '<div class="tool-section">' +
            '<div class="tool-section-label">Input</div>' +
            '<pre>' + escapeHtml(part.inputPreview) + '</pre>' +
          '</div>'
        );
      }
      if (part.outputPreview) {
        sections.push(
          '<div class="tool-section">' +
            '<div class="tool-section-label">Output</div>' +
            '<pre>' + escapeHtml(part.outputPreview) + '</pre>' +
          '</div>'
        );
      }
      const body = sections.length
        ? '<div class="collapse-body tool-body">' + sections.join("") + '</div>'
        : "";
      const rowInner =
        '<span class="collapse-row">' +
          (body ? chevronIcon() : '<span class="collapse-chevron-spacer" aria-hidden="true"></span>') +
          '<span class="collapse-title">' + escapeHtml(title) + '</span>' +
          summaryHtml +
          statusBadge(part.status) +
        '</span>';
      // No input/output yet (or ever): don't render a fake expandable disclosure.
      if (!body) {
        return (
          '<div class="collapse tool flat' + liveClass + '" data-collapse-id="' + escapeHtml(collapseId) + '">' +
            '<div class="collapse-summary">' +
              rowInner +
            '</div>' +
          '</div>'
        );
      }
      return (
        '<details class="collapse tool' + liveClass + '" data-collapse-id="' + escapeHtml(collapseId) + '"' + openAttr + '>' +
          '<summary class="collapse-summary">' +
            rowInner +
          '</summary>' +
          body +
        '</details>'
      );
    }
    return '<div class="bubble">' + renderMarkdownish(part.text) + '</div>';
  }

  function renderMessageAttachments(attachments) {
    if (!attachments || attachments.length === 0) return "";
    const images = [];
    const others = [];
    attachments.forEach(function (a) {
      if (a.kind === "image") images.push(a);
      else others.push(a);
    });
    let html = "";
    if (images.length) {
      html += `<div class="msg-images">${images.map(function (a) {
        const alt = escapeHtml(a.label || "image");
        const path = escapeHtml(a.fsPath || a.path || "");
        const title = escapeHtml(a.fsPath || a.path || a.label || "Preview image");
        if (a.previewDataUrl) {
          return `<button type="button" class="msg-image-btn" data-action="preview-image" data-src="${a.previewDataUrl}" data-path="${path}" title="${title}">
            <img class="msg-image" src="${a.previewDataUrl}" alt="${alt}" />
          </button>`;
        }
        const label = escapeHtml(a.label || a.path || a.fsPath || "image");
        return `<button type="button" class="msg-image-fallback" data-action="preview-image" data-path="${path}" title="${title}">
          <span class="att-icon">${kindIcon("image")}</span>
          <span class="att-label">${label}</span>
        </button>`;
      }).join("")}</div>`;
    }
    if (others.length) {
      html += `<div class="msg-atts">${others.map(function (a) {
        const label = escapeHtml(a.label || a.path || a.fsPath || a.kind || "file");
        const title = escapeHtml(a.fsPath || a.path || a.label || "");
        return `<span class="msg-att ${escapeHtml(a.kind || "file")}" title="${title}">
          <span class="att-icon">${kindIcon(a.kind)}</span>
          <span class="att-label">${label}</span>
        </span>`;
      }).join("")}</div>`;
    }
    return html;
  }

  function renderMessage(msg) {
    const partsHtml = (msg.parts || [])
      .map(function (part, idx) {
        if (part.kind === "text") {
          const cls = msg.streaming && idx === msg.parts.length - 1 ? " streaming" : "";
          return `<div class="bubble${cls}">${renderMarkdownish(part.text || (msg.streaming ? "" : ""))}</div>`;
        }
        return renderPart(part, msg, idx);
      })
      .join("");

    const attachmentsHtml = renderMessageAttachments(msg.attachments);

    const fallback =
      msg.role === "assistant" && msg.streaming && (!msg.parts || msg.parts.length === 0)
        ? `<div class="bubble streaming"></div>`
        : "";

    const partsSig = escapeHtml(partsSignature(msg.parts));
    return `<article class="msg ${msg.role}" data-id="${msg.id}" data-parts-sig="${partsSig}">
      <div class="role">${msg.role}</div>
      ${partsHtml || fallback}
      ${attachmentsHtml}
    </article>`;
  }

  function kindIcon(kind) {
    if (kind === "folder") return "📁";
    if (kind === "image") return "🖼";
    if (kind === "selection") return "✂";
    if (kind === "context") return "📄";
    return "📄";
  }

  function renderAttachments() {
    if (state.attachments.length === 0) {
      attachmentsEl.innerHTML = "";
      return;
    }
    attachmentsEl.innerHTML = state.attachments
      .map(function (a) {
        const isImagePreview = a.kind === "image" && a.previewDataUrl;
        const path = escapeHtml(a.fsPath || a.path || "");
        const thumb = a.previewDataUrl
          ? `<img class="att-thumb" src="${a.previewDataUrl}" alt="" data-action="preview-image" data-src="${a.previewDataUrl}" data-path="${path}" title="Preview image" />`
          : `<span class="att-icon">${kindIcon(a.kind)}</span>`;
        const cls = a.kind === "context" ? "att context" : `att ${escapeHtml(a.kind || "file")}`;
        const label = isImagePreview ? "" : `<span class="att-label">${escapeHtml(a.label)}</span>`;
        return `<span class="${cls}" data-id="${a.id}" title="${escapeHtml(a.fsPath || a.path || a.label)}">
          ${thumb}
          ${label}
          <button data-action="remove-att" title="Remove">×</button>
        </span>`;
      })
      .join("");
  }


  function formatTokens(n) {
    const num = Number(n) || 0;
    if (num >= 1000000) {
      const v = num / 1000000;
      return (Math.round(v * 10) / 10) + "M";
    }
    if (num >= 1000) return Math.round(num / 1000) + "k";
    return String(Math.round(num));
  }

  function shortModelName(name) {
    const raw = String(name || "Model");
    // Keep labels compact like Cursor.
    return raw
      .replace(/^Cursor\s+/i, "")
      .replace(/^Claude\s+/i, "Claude ")
      .trim();
  }

  function updateUsage() {
    const usage = state.contextUsage;
    if (usageLabel == null || usageBtn == null) return;
    if (usage == null || !usage.contextWindow) {
      usageLabel.textContent = "0%";
      usageBtn.title = "Context usage this session";
      usageBtn.classList.remove("warn", "critical");
      if (usageProgress) {
        usageProgress.style.strokeDashoffset = String(2 * Math.PI * 11);
      }
      return;
    }
    const pct = Math.max(0, Math.min(100, Number(usage.percent) || 0));
    const label = pct < 1 ? pct.toFixed(2) + "%" : pct.toFixed(1) + "%";
    usageLabel.textContent = label;
    usageBtn.title =
      "Context: " +
      formatTokens(usage.tokens) +
      " / " +
      formatTokens(usage.contextWindow) +
      " (" +
      label +
      ")";
    usageBtn.classList.toggle("warn", pct >= 70 && pct < 90);
    usageBtn.classList.toggle("critical", pct >= 90);
    if (usageProgress) {
      const c = 2 * Math.PI * 11;
      const offset = c * (1 - pct / 100);
      usageProgress.style.strokeDasharray = String(c);
      usageProgress.style.strokeDashoffset = String(offset);
    }
  }

  function updateChrome() {
    const status = state.status || { state: "starting" };
    if (statusDot) {
      statusDot.className = `status-dot ${status.state || ""}`;
      statusDot.title = status.detail || status.state || "";
    }
    if (modelLabel) modelLabel.textContent = shortModelName(state.model || "Model");
    if (modelBtn) modelBtn.title = "Model: " + (state.model || "Default");
    if (modeLabel) modeLabel.textContent = state.mode || "Agent";
    if (greetingTitle) {
      greetingTitle.textContent = state.displayName
        ? `How can I help you, ${state.displayName}?`
        : "How can I help you?";
    }
    updateUsage();
  }

  function notBusy() {
    return state.status.state !== "busy";
  }


  let tabsSignature = "";

  function tabCloseIcon() {
    return (
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path fill="currentColor" d="M8 8.71L3.29 4 2 5.29 6.71 10 2 14.71 3.29 16 8 11.29 12.71 16 14 14.71 9.29 10 14 5.29 12.71 4 8 8.71z"/>' +
      '</svg>'
    );
  }

  function buildTabHtml(tab, activeId) {
    const active = tab.id === activeId ? " active" : "";
    const busy = tab.busy ? " busy" : "";
    return (
      '<div class="tab' + active + busy + '" role="tab" tabindex="0" aria-selected="' + (tab.id === activeId ? "true" : "false") + '" data-tab-id="' + escapeHtml(tab.id) + '" title="' + escapeHtml(tab.title) + '">' +
        '<span class="tab-label"><span class="tab-title">' + escapeHtml(tab.title) + '</span></span>' +
        '<button type="button" class="tab-close" data-action="close-tab" title="Close" aria-label="Close">' +
          tabCloseIcon() +
        '</button>' +
      '</div>'
    );
  }

  function ensureActiveTabVisible() {
    if (!tabsEl) return;
    const active = tabsEl.querySelector(".tab.active");
    if (!active || typeof active.scrollIntoView !== "function") return;
    active.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  function renderTabs() {
    if (!tabsEl) return;
    const tabs = state.tabs || [];
    const activeId = state.activeTabId || "";
    const signature =
      tabs
        .map(function (tab) {
          return tab.id + "\0" + tab.title + "\0" + (tab.busy ? "1" : "0");
        })
        .join("\n") +
      "\n@" +
      activeId;
    if (signature === tabsSignature) return;

    const existing = Array.prototype.slice.call(tabsEl.children);
    const sameOrder =
      existing.length === tabs.length &&
      tabs.every(function (tab, i) {
        return existing[i] && existing[i].getAttribute("data-tab-id") === tab.id;
      });

    if (sameOrder) {
      tabs.forEach(function (tab, i) {
        const el = existing[i];
        el.classList.toggle("active", tab.id === activeId);
        el.classList.toggle("busy", !!tab.busy);
        el.setAttribute("aria-selected", tab.id === activeId ? "true" : "false");
        el.title = tab.title;
        const titleEl = el.querySelector(".tab-title");
        if (titleEl && titleEl.textContent !== tab.title) titleEl.textContent = tab.title;
      });
      tabsSignature = signature;
      ensureActiveTabVisible();
      return;
    }

    tabsEl.innerHTML = tabs
      .map(function (tab) {
        return buildTabHtml(tab, activeId);
      })
      .join("");
    tabsSignature = signature;
    ensureActiveTabVisible();
  }

  function render() {
    try {
      updateChrome();
      renderTabs();
      const status = state.status;
      const messages = state.messages;
      const busy = status.state === "busy";
      stopBtn.hidden = notBusy();
      sendBtn.disabled = status.state === "starting";
      sendBtn.hidden = false;
      sendBtn.title = busy ? "Queue" : "Send";
      sendBtn.setAttribute("aria-label", busy ? "Queue" : "Send");
      sendBtn.classList.toggle("queue", busy);

      const transcript = getTranscriptMessages();
      const hasMessages = transcript.length > 0;
      emptyEl.classList.toggle("visible", hasMessages === false);
      messagesEl.style.display = hasMessages ? "flex" : "none";
      renderQueue();

      if (hasMessages) {
        const last = transcript[transcript.length - 1];
        const existing = messagesEl.querySelector(`.msg[data-id="${last.id}"]`);
        const canPatch =
          existing &&
          last.role === "assistant" &&
          last.streaming &&
          messagesEl.children.length === transcript.length;
        const prevScrollTop = messagesEl.scrollTop;
        const prevScrollHeight = messagesEl.scrollHeight;
        const shouldStick = stickToBottom || isNearBottom(messagesEl, 80);

        if (canPatch) {
          const signature = partsSignature(last.parts);
          const existingSig = existing.getAttribute("data-parts-sig") || "";
          // Remount when thinking/tool/text structure changes so we never write the
          // newest thinking stream into an older Thought block.
          if (signature !== existingSig) {
            existing.outerHTML = renderMessage(last);
          } else {
            let thinkingPatched = false;
            (last.parts || []).forEach(function (part, idx) {
              if (part.kind !== "thinking") return;
              if (patchThinkingPart(existing, last, part, idx)) {
                thinkingPatched = true;
              }
            });
            if (thinkingPatched) {
              syncThinkingTimer();
            }

            const textPart = Array.prototype.slice.call(last.parts || []).reverse().find(function (p) {
              return p.kind === "text";
            });
            const bubbles = existing.querySelectorAll(".bubble");
            const lastBubble = bubbles[bubbles.length - 1];
            if (textPart && lastBubble && lastBubble.closest(".thinking") == null && lastBubble.closest(".collapse") == null) {
              const nextHtml = renderMarkdownish(textPart.text || "");
              if (lastBubble.innerHTML !== nextHtml) {
                lastBubble.innerHTML = nextHtml;
              }
              lastBubble.classList.toggle("streaming", true);
            } else if (textPart && lastBubble == null) {
              existing.outerHTML = renderMessage(last);
            }
          }
        } else {
          messagesEl.innerHTML = transcript.map(renderMessage).join("");
          if (!shouldStick) {
            // Preserve the user's reading position across full re-renders.
            const delta = messagesEl.scrollHeight - prevScrollHeight;
            messagesEl.scrollTop = Math.max(0, prevScrollTop + Math.max(0, delta));
          }
        }
        if (shouldStick) {
          stickToBottom = true;
          scrollMessagesToBottom(true);
        }
      } else {
        messagesEl.innerHTML = "";
      }

      renderAttachments();
      renderActiveQuestion();
      renderUiQuestion();
      syncThinkingTimer();
    } catch (err) {
      console.error("OMP Chat render failed", err);
      if (statusDot) {
        statusDot.className = "status-dot error";
        statusDot.title = `UI error: ${err && err.message ? err.message : err}`;
      }
    }
  }




  function getRunningUserQuestion() {
    const transcript = getTranscriptMessages();
    if (!transcript.length) return null;
    const busy = state.status && state.status.state === "busy";
    const last = transcript[transcript.length - 1];
    const streaming = Boolean(last && last.role === "assistant" && last.streaming);
    if (!busy && !streaming) return null;
    for (let i = transcript.length - 1; i >= 0; i -= 1) {
      const msg = transcript[i];
      if (!msg || msg.role !== "user" || msg.queued) continue;
      const textPart = (msg.parts || []).find(function (p) { return p && p.kind === "text" && p.text; });
      const text = textPart ? String(textPart.text || "").trim() : "";
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      if (!text && !attachments.length) continue;
      return { id: msg.id, text: text, attachments: attachments };
    }
    return null;
  }

  let activeQuestionSignature = "";

  function renderActiveQuestion() {
    if (!activeQuestionEl) return;
    const q = getRunningUserQuestion();
    if (!q) {
      activeQuestionSignature = "";
      activeQuestionEl.hidden = true;
      activeQuestionEl.innerHTML = "";
      return;
    }
    const preview = q.text
      ? q.text.replace(/\s+/g, " ").trim()
      : (q.attachments.length === 1
          ? (q.attachments[0].label || "Attachment")
          : q.attachments.length + " attachments");
    const signature = q.id + "\0" + preview;
    if (signature === activeQuestionSignature && !activeQuestionEl.hidden) {
      return;
    }
    activeQuestionSignature = signature;
    activeQuestionEl.hidden = false;
    activeQuestionEl.innerHTML =
      '<div class="active-question-card" data-id="' + escapeHtml(q.id) + '">' +
        '<div class="active-question-kicker">Running</div>' +
        '<div class="active-question-text">' + escapeHtml(preview) + '</div>' +
      '</div>';
  }

  function answerUiQuestion(payload) {
    if (!payload || !payload.id) return;
    vscode.postMessage({
      type: "answerUiQuestion",
      id: payload.id,
      confirmed: payload.confirmed,
      value: payload.value,
      cancelled: payload.cancelled,
    });
  }

  let uiQuestionSignature = "";

  function renderUiQuestion() {
    if (!uiQuestionEl) return;
    const q = state.uiQuestion;
    if (!q) {
      uiQuestionSignature = "";
      uiQuestionEl.hidden = true;
      uiQuestionEl.innerHTML = "";
      return;
    }

    const signature =
      q.id +
      "\0" +
      q.method +
      "\0" +
      (q.title || "") +
      "\0" +
      (q.message || "") +
      "\0" +
      (Array.isArray(q.options) ? q.options.join("\n") : "") +
      "\0" +
      (q.placeholder || "") +
      "\0" +
      (q.prefill || "");
    if (signature === uiQuestionSignature && !uiQuestionEl.hidden) {
      return;
    }
    uiQuestionSignature = signature;

    const title = q.title || (q.method === "confirm" ? "Confirm" : "Question");
    const message = q.message || "";
    let body = "";

    if (q.method === "confirm") {
      body =
        '<div class="ui-question-actions">' +
          '<button type="button" class="ui-q-btn" data-action="confirm-no">No</button>' +
          '<button type="button" class="ui-q-btn primary" data-action="confirm-yes">Yes</button>' +
        '</div>';
    } else if (q.method === "select") {
      const options = Array.isArray(q.options) ? q.options : [];
      body =
        '<div class="ui-question-options">' +
        options
          .map(function (opt, i) {
            return (
              '<button type="button" class="ui-q-option" data-action="select-option" data-value="' +
              escapeHtml(opt) +
              '">' +
              '<span class="ui-q-option-index">' +
              (i + 1) +
              "</span>" +
              '<span class="ui-q-option-label">' +
              escapeHtml(opt) +
              "</span>" +
              "</button>"
            );
          })
          .join("") +
        "</div>" +
        '<div class="ui-question-actions">' +
          '<button type="button" class="ui-q-btn" data-action="cancel">Cancel</button>' +
        "</div>";
    } else {
      // input / editor
      body =
        '<div class="ui-question-input-wrap">' +
          '<textarea class="ui-q-input" rows="' +
          (q.method === "editor" ? "4" : "2") +
          '" placeholder="' +
          escapeHtml(q.placeholder || "Type your answer…") +
          '">' +
          escapeHtml(q.prefill || "") +
          "</textarea>" +
        "</div>" +
        '<div class="ui-question-actions">' +
          '<button type="button" class="ui-q-btn" data-action="cancel">Cancel</button>' +
          '<button type="button" class="ui-q-btn primary" data-action="submit-value">Submit</button>' +
        "</div>";
    }

    uiQuestionEl.hidden = false;
    uiQuestionEl.innerHTML =
      '<div class="ui-question-card" data-id="' +
      escapeHtml(q.id) +
      '">' +
        '<div class="ui-question-header">' +
          '<div class="ui-question-kicker">OMP needs your answer</div>' +
          '<div class="ui-question-title">' +
          escapeHtml(title) +
          "</div>" +
          (message
            ? '<div class="ui-question-message">' + escapeHtml(message) + "</div>"
            : "") +
        "</div>" +
        body +
      "</div>";

    const input = uiQuestionEl.querySelector(".ui-q-input");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function basename(pathValue) {
    const parts = String(pathValue || "").split(/[\\/]/);
    return parts[parts.length - 1] || pathValue;
  }

  function getTriggerAtCursor() {
    const value = inputEl.value;
    const cursor = inputEl.selectionStart == null ? value.length : inputEl.selectionStart;
    const before = value.slice(0, cursor);

    // Slash commands: only at start of input (optional leading whitespace)
    const slash = before.match(/^\s*\/([^\s]*)$/);
    if (slash) {
      const token = slash[0].replace(/^\s*/, "");
      const start = before.length - token.length;
      return { kind: "command", query: slash[1] || "", start: start, end: cursor };
    }

    // @file mentions: token beginning with @ after start/whitespace
    const at = before.match(/(^|[\s])@([^\s]*)$/);
    if (at) {
      const query = at[2] || "";
      const start = before.length - query.length - 1; // position of @
      return { kind: "file", query: query, start: start, end: cursor };
    }
    return null;
  }

  function closeSuggest() {
    suggest.open = false;
    suggest.kind = null;
    suggest.items = [];
    suggest.active = 0;
    if (suggestEl) suggestEl.hidden = true;
    if (suggestListEl) suggestListEl.innerHTML = "";
  }

  function renderSuggest() {
    if (!suggestEl || !suggestListEl || !suggestHeaderEl) return;
    if (!suggest.open || suggest.items.length === 0) {
      suggestEl.hidden = true;
      return;
    }
    closeQueueMenu();
    suggestEl.hidden = false;
    suggestHeaderEl.textContent = suggest.kind === "command" ? "Commands" : "Attach file or folder";
    suggestListEl.innerHTML = suggest.items.map(function (item, index) {
      const active = index === suggest.active ? " active" : "";
      const icon = suggest.kind === "command" ? "⌘" : (item.kind === "folder" ? "📁" : "📄");
      const title = escapeHtml(item.label || item.path || item.id || "");
      const detail = escapeHtml(item.detail || item.path || "");
      return (
        '<button type="button" class="suggest-item' + active + '" data-index="' + index + '" role="option">' +
          '<span class="suggest-icon">' + icon + '</span>' +
          '<span class="suggest-text">' +
            '<span class="suggest-title">' + title + '</span>' +
            (detail && detail !== title ? '<span class="suggest-detail">' + detail + '</span>' : '') +
          '</span>' +
        '</button>'
      );
    }).join("");
    const activeEl = suggestListEl.querySelector(".suggest-item.active");
    if (activeEl && activeEl.scrollIntoView) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }

  function replaceTriggerRange(replacement) {
    const value = inputEl.value;
    const start = suggest.start;
    const end = suggest.end;
    const next = value.slice(0, start) + replacement + value.slice(end);
    inputEl.value = next;
    const caret = start + replacement.length;
    inputEl.setSelectionRange(caret, caret);
    autosize();
  }

  function applySuggestItem(item) {
    if (!item) return;
    if (suggest.kind === "file") {
      replaceTriggerRange("");
      closeSuggest();
      if (item.fsPath) {
        vscode.postMessage({ type: "attachPaths", paths: [item.fsPath] });
      }
      inputEl.focus();
      return;
    }
    if (suggest.kind === "command") {
      replaceTriggerRange("");
      closeSuggest();
      vscode.postMessage({ type: "runSlashCommand", command: item.id });
      inputEl.focus();
    }
  }

  function updateCommandSuggest(query) {
    const q = String(query || "").toLowerCase();
    const items = SLASH_COMMANDS.filter(function (cmd) {
      if (!q) return true;
      return cmd.id.indexOf(q) === 0 || cmd.label.indexOf(q) >= 0 || (cmd.detail && cmd.detail.toLowerCase().indexOf(q) >= 0);
    }).map(function (cmd) {
      return { id: cmd.id, label: cmd.label, detail: cmd.detail, kind: "command" };
    });
    suggest.items = items;
    suggest.active = 0;
    suggest.open = items.length > 0;
    renderSuggest();
  }

  function requestFileSuggest(query) {
    suggest.requestId += 1;
    const requestId = suggest.requestId;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      vscode.postMessage({ type: "searchFiles", query: query || "", requestId: requestId });
    }, 80);
  }

  function refreshSuggestFromInput() {
    const trigger = getTriggerAtCursor();
    if (!trigger) {
      closeSuggest();
      return;
    }
    if (suggest.kind !== trigger.kind) {
      suggest.items = [];
      suggest.active = 0;
    }
    suggest.kind = trigger.kind;
    suggest.start = trigger.start;
    suggest.end = trigger.end;
    suggest.query = trigger.query;
    if (trigger.kind === "command") {
      updateCommandSuggest(trigger.query);
      return;
    }
    suggest.open = true;
    requestFileSuggest(trigger.query);
    // Keep previous items visible while waiting; header updates immediately.
    if (suggestHeaderEl) suggestHeaderEl.textContent = "Attach file or folder";
    if (suggestEl) suggestEl.hidden = suggest.items.length === 0;
  }


  function queuedMessageText(msg) {
    if (!msg || !msg.parts) return "";
    return msg.parts
      .filter(function (part) { return part.kind === "text"; })
      .map(function (part) { return part.text || ""; })
      .join("\n");
  }

  function getQueuedMessages() {
    return (state.messages || []).filter(function (m) { return m && m.queued; });
  }

  function getTranscriptMessages() {
    return (state.messages || []).filter(function (m) { return m && !m.queued; });
  }

  function queuePreviewText(msg) {
    const text = queuedMessageText(msg).replace(/\s+/g, " ").trim();
    if (text) return text;
    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    if (atts.length === 1) return atts[0].label || "Attachment";
    if (atts.length > 1) return atts.length + " attachments";
    return "Queued message";
  }

  function closeQueueMenu() {
    queueMenuOpen = false;
    if (queueMenuEl) queueMenuEl.hidden = true;
    if (queueToggleEl) queueToggleEl.setAttribute("aria-expanded", "false");
  }

  function openQueueMenu() {
    if (!queueMenuEl || !queueToggleEl) return;
    if (!getQueuedMessages().length) {
      closeQueueMenu();
      return;
    }
    // Keep only one composer popover open at a time.
    if (suggestEl) suggestEl.hidden = true;
    if (typeof suggest !== "undefined") suggest.open = false;
    queueMenuOpen = true;
    queueMenuEl.hidden = false;
    queueToggleEl.setAttribute("aria-expanded", "true");
  }

  function toggleQueueMenu() {
    if (queueMenuOpen) closeQueueMenu();
    else openQueueMenu();
  }

  function renderQueue() {
    const queued = getQueuedMessages();
    if (!queuePanelEl || !queueToggleEl || !queueToggleLabelEl || !queueListEl) return;

    if (!queued.length) {
      queuePanelEl.hidden = true;
      closeQueueMenu();
      queueListEl.innerHTML = "";
      queueToggleLabelEl.textContent = "0 queued";
      return;
    }

    queuePanelEl.hidden = false;
    const countLabel = queued.length === 1 ? "1 queued" : queued.length + " queued";
    const newest = queuePreviewText(queued[queued.length - 1]);
    const short = newest.length > 42 ? newest.slice(0, 42) + "…" : newest;
    queueToggleLabelEl.textContent = queued.length === 1 ? short : countLabel;
    queueToggleEl.title = countLabel + (queued.length === 1 ? "" : " — " + short);

    queueListEl.innerHTML = queued.map(function (msg) {
      const text = queuedMessageText(msg);
      const preview = escapeHtml(queuePreviewText(msg));
      const title = escapeHtml(text.trim() ? "Edit queued message" : "Queued message");
      const id = escapeHtml(msg.id || "");
      const attCount = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
      const attNote = attCount
        ? '<div class="queue-item-title">' + attCount + (attCount === 1 ? " attachment" : " attachments") + "</div>"
        : "";
      return (
        '<div class="queue-item" role="menuitem" data-id="' + id + '">' +
          '<button type="button" class="queue-item-main" data-action="edit-queued" data-id="' + id + '" title="' + title + '">' +
            attNote +
            '<div class="queue-item-preview">' + preview + '</div>' +
          '</button>' +
          '<div class="queue-item-actions">' +
            '<button type="button" class="queue-item-btn" data-action="edit-queued" data-id="' + id + '" title="Edit">✎</button>' +
            '<button type="button" class="queue-item-btn danger" data-action="remove-queued" data-id="' + id + '" title="Remove">×</button>' +
          '</div>' +
        '</div>'
      );
    }).join("");

    if (queueMenuOpen) openQueueMenu();
    else closeQueueMenu();
  }

  function applyComposerPrefill(text) {
    inputEl.value = text == null ? "" : String(text);
    autosize();
    inputEl.focus();
    try {
      const len = inputEl.value.length;
      inputEl.setSelectionRange(len, len);
    } catch (_) {}
  }

  function recallQueuedMessage(id) {
    const msgId = String(id || "");
    if (!msgId) return;
    const msg = (state.messages || []).find(function (m) { return m.id === msgId && m.queued; });
    const text = msg ? queuedMessageText(msg) : "";
    if (msg) {
      applyComposerPrefill(text);
      state.messages = state.messages.filter(function (m) { return m.id !== msgId; });
      closeQueueMenu();
      render();
    }
    vscode.postMessage({ type: "recallQueued", id: msgId, text: text });
  }

  function removeQueuedMessage(id) {
    const msgId = String(id || "");
    if (!msgId) return;
    const msg = (state.messages || []).find(function (m) { return m.id === msgId && m.queued; });
    const text = msg ? queuedMessageText(msg) : "";
    state.messages = (state.messages || []).filter(function (m) { return m.id !== msgId; });
    if (!getQueuedMessages().length) closeQueueMenu();
    render();
    vscode.postMessage({ type: "removeQueued", id: msgId, text: text });
  }

  function send() {
    const text = inputEl.value;
    if (text.trim() === "" && state.attachments.length === 0) return;
    stickToBottom = true;
    const busy = state.status.state === "busy";
    if (text.trim() || state.attachments.length) {
      state.messages = state.messages.concat({
        id: `local-${Date.now()}`,
        role: "user",
        createdAt: Date.now(),
        parts: text.trim() ? [{ kind: "text", text: text }] : [],
        attachments: state.attachments.slice(),
        queued: busy,
      });
      if (!busy) {
        state.status = { state: "busy", detail: "Sending…" };
      }
      // Clear local attachment chips immediately; host owns the real send/queue.
      state.attachments = [];
      render();
      scrollMessagesToBottom(true);
    }
    vscode.postMessage({ type: "send", text: text });
    inputEl.value = "";
    autosize();
  }

  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const result = String(reader.result || "");
        const idx = result.indexOf(",");
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = function () { reject(reader.error || new Error("Failed to read file")); };
      reader.readAsDataURL(file);
    });
  }

  function fileToText(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || "")); };
      reader.onerror = function () { reject(reader.error || new Error("Failed to read file")); };
      reader.readAsText(file);
    });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const paths = files.map(function (f) { return f.path; }).filter(Boolean);
    if (paths.length) {
      vscode.postMessage({ type: "attachPaths", paths: paths });
      return;
    }

    for (const file of files) {
      if (file.type && file.type.indexOf("image/") === 0) {
        const base64 = await fileToBase64(file);
        vscode.postMessage({
          type: "attachImage",
          name: file.name || `image-${Date.now()}.png`,
          mimeType: file.type || "image/png",
          base64: base64,
        });
        continue;
      }
      const content = await fileToText(file);
      vscode.postMessage({
        type: "attachTextFile",
        name: file.name || "dropped.txt",
        content: content,
      });
    }
  }

  sendBtn.addEventListener("click", send);

  if (queueToggleEl) {
    queueToggleEl.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleQueueMenu();
    });
  }
  if (queuePanelEl) {
    queuePanelEl.addEventListener("click", function (e) {
      const closeBtn = e.target.closest('[data-action="close-queue-menu"]');
      if (closeBtn) {
        e.preventDefault();
        closeQueueMenu();
        return;
      }
      const actionBtn = e.target.closest('[data-action="edit-queued"], [data-action="remove-queued"]');
      if (!actionBtn) return;
      e.preventDefault();
      e.stopPropagation();
      const action = actionBtn.getAttribute("data-action");
      const id = actionBtn.getAttribute("data-id") || "";
      if (action === "edit-queued") recallQueuedMessage(id);
      if (action === "remove-queued") removeQueuedMessage(id);
    });
  }
  document.addEventListener("mousedown", function (e) {
    if (!queueMenuOpen || !queuePanelEl) return;
    if (queuePanelEl.contains(e.target)) return;
    closeQueueMenu();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && queueMenuOpen) {
      closeQueueMenu();
    }
  });

  if (messagesEl) {
    messagesEl.addEventListener("scroll", function () {
      stickToBottom = isNearBottom(messagesEl, 80);
    }, { passive: true });
  }
  stopBtn.addEventListener("click", function () { vscode.postMessage({ type: "stop" }); });
  if (newChatBtn) newChatBtn.addEventListener("click", function () { vscode.postMessage({ type: "newChat" }); });
  if (historyBtn) historyBtn.addEventListener("click", function () { vscode.postMessage({ type: "history" }); });
  if (moreBtn) moreBtn.addEventListener("click", function () { vscode.postMessage({ type: "moreMenu" }); });
  attachBtn.addEventListener("click", function () { vscode.postMessage({ type: "attachMenu" }); });
  attachFilesBtn.addEventListener("click", function () { vscode.postMessage({ type: "attachFiles" }); });
  attachFolderBtn.addEventListener("click", function () { vscode.postMessage({ type: "attachFolder" }); });
  modelBtn.addEventListener("click", function () { vscode.postMessage({ type: "pickModel" }); });
  if (usageBtn) usageBtn.addEventListener("click", function () { vscode.postMessage({ type: "showUsage" }); });
  modeBtn.addEventListener("click", function () { vscode.postMessage({ type: "pickMode" }); });

  inputEl.addEventListener("keydown", function (e) {
    if (suggest.open && suggest.items.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        suggest.active = (suggest.active + 1) % suggest.items.length;
        renderSuggest();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        suggest.active = (suggest.active - 1 + suggest.items.length) % suggest.items.length;
        renderSuggest();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applySuggestItem(suggest.items[suggest.active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSuggest();
        return;
      }
    }
    if (e.key === "Enter" && e.shiftKey === false) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("input", function () {
    autosize();
    refreshSuggestFromInput();
  });
  inputEl.addEventListener("click", refreshSuggestFromInput);
  inputEl.addEventListener("keyup", function (e) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      refreshSuggestFromInput();
    }
  });

  inputEl.addEventListener("paste", async function (e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (items == null || items.length === 0) return;
    const imageItems = Array.from(items).filter(function (item) {
      return item.type && item.type.indexOf("image/") === 0;
    });
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file == null) continue;
      const base64 = await fileToBase64(file);
      vscode.postMessage({
        type: "attachImage",
        name: `paste-${Date.now()}.png`,
        mimeType: file.type || "image/png",
        base64: base64,
      });
    }
  });

  emptyEl.addEventListener("click", function (e) {
    const btn = e.target.closest(".chip");
    if (btn == null) return;
    inputEl.value = btn.getAttribute("data-prompt") || "";
    autosize();
    inputEl.focus();
  });

  function openFileFromEvent(e) {
    const fileBtn = e.target.closest("button[data-action='open-file']");
    if (!fileBtn || !messagesEl.contains(fileBtn)) return false;
    e.preventDefault();
    e.stopPropagation();
    const filePath = fileBtn.getAttribute("data-path") || "";
    if (!filePath) return true;
    const lineAttr = fileBtn.getAttribute("data-line");
    const endAttr = fileBtn.getAttribute("data-end-line");
    const msg = { type: "openFile", path: filePath };
    if (lineAttr && /^\d+$/.test(lineAttr)) msg.line = parseInt(lineAttr, 10);
    if (endAttr && /^\d+$/.test(endAttr)) msg.endLine = parseInt(endAttr, 10);
    vscode.postMessage(msg);
    return true;
  }

  messagesEl.addEventListener("click", function (e) {
    if (openFileFromEvent(e)) return;
  }, true);

  messagesEl.addEventListener("click", function (e) {
    if (handleImagePreviewClick(e)) return;
    if (openFileFromEvent(e)) return;

    const link = e.target.closest("a[data-href], a[href]");
    if (link && messagesEl.contains(link)) {
      const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
      if (href) {
        e.preventDefault();
        vscode.postMessage({ type: "openExternal", url: href });
        return;
      }
    }

    const btn = e.target.closest("button[data-action]");
    if (btn == null) return;
    const action = btn.getAttribute("data-action");
    const codeRoot = btn.closest(".md-code");
    const pre = (codeRoot && codeRoot.querySelector(".md-pre")) ||
      (btn.parentElement && btn.parentElement.previousElementSibling);
    const encoded = pre && pre.getAttribute && pre.getAttribute("data-code");
    const text = encoded ? decodeURIComponent(encoded) : "";
    if (action === "copy-code" && text) vscode.postMessage({ type: "copy", text: text });
    if (action === "insert-code" && text) vscode.postMessage({ type: "insert", text: text });
  });


  let imagePreviewPath = "";

  function closeImagePreview() {
    imagePreviewPath = "";
    if (imagePreviewImg) {
      imagePreviewImg.removeAttribute("src");
      imagePreviewImg.alt = "Preview";
    }
    if (imagePreviewEl) {
      imagePreviewEl.hidden = true;
      const openBtn = imagePreviewEl.querySelector('[data-action="open-image-file"]');
      if (openBtn) openBtn.hidden = true;
    }
  }

  function openImagePreview(src, path, alt) {
    const filePath = String(path || "").trim();
    const dataUrl = String(src || "").trim();
    if (!dataUrl && filePath) {
      vscode.postMessage({ type: "openFile", path: filePath });
      return;
    }
    if (!dataUrl || !imagePreviewEl || !imagePreviewImg) return;
    imagePreviewPath = filePath;
    imagePreviewImg.src = dataUrl;
    imagePreviewImg.alt = alt || "Preview";
    const openBtn = imagePreviewEl.querySelector('[data-action="open-image-file"]');
    if (openBtn) openBtn.hidden = !filePath;
    imagePreviewEl.hidden = false;
  }

  function handleImagePreviewClick(e) {
    const closeBtn = e.target.closest('[data-action="close-image-preview"]');
    if (closeBtn) {
      e.preventDefault();
      closeImagePreview();
      return true;
    }
    const openBtn = e.target.closest('[data-action="open-image-file"]');
    if (openBtn) {
      e.preventDefault();
      if (imagePreviewPath) {
        vscode.postMessage({ type: "openFile", path: imagePreviewPath });
      }
      return true;
    }
    const previewBtn = e.target.closest('[data-action="preview-image"]');
    if (!previewBtn) return false;
    e.preventDefault();
    e.stopPropagation();
    openImagePreview(
      previewBtn.getAttribute("data-src") || "",
      previewBtn.getAttribute("data-path") || "",
      (previewBtn.querySelector("img") && previewBtn.querySelector("img").alt) || "Preview"
    );
    return true;
  }

  attachmentsEl.addEventListener("click", function (e) {
    if (handleImagePreviewClick(e)) return;
    const btn = e.target.closest("button[data-action='remove-att']");
    if (btn == null) return;
    const id = btn.parentElement && btn.parentElement.getAttribute("data-id");
    if (id) vscode.postMessage({ type: "removeAttachment", id: id });
  });

  if (imagePreviewEl) {
    imagePreviewEl.addEventListener("click", function (e) {
      handleImagePreviewClick(e);
    });
  }

  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && imagePreviewEl && !imagePreviewEl.hidden) {
      closeImagePreview();
    }
  });

  if (suggestListEl) {
    suggestListEl.addEventListener("mousedown", function (e) {
      // Prevent textarea blur before click applies.
      e.preventDefault();
    });
    suggestListEl.addEventListener("click", function (e) {
      const btn = e.target.closest(".suggest-item");
      if (btn == null) return;
      const index = Number(btn.getAttribute("data-index"));
      if (!Number.isNaN(index) && suggest.items[index]) {
        applySuggestItem(suggest.items[index]);
      }
    });
  }


  function setDropVisible(show) {
    if (dropOverlay == null) return;
    dropOverlay.hidden = show === false;
  }

  ["dragenter", "dragover"].forEach(function (evt) {
    window.addEventListener(evt, function (e) {
      e.preventDefault();
      dragDepth += 1;
      setDropVisible(true);
    });
  });
  window.addEventListener("dragleave", function (e) {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDropVisible(false);
  });
  window.addEventListener("drop", async function (e) {
    e.preventDefault();
    dragDepth = 0;
    setDropVisible(false);
    if (e.dataTransfer && e.dataTransfer.files) {
      await handleFiles(e.dataTransfer.files);
    }
  });


  if (tabsEl) {
    // Vertical wheel / trackpad gestures scroll the tab strip horizontally.
    tabsEl.addEventListener(
      "wheel",
      function (e) {
        if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        e.preventDefault();
        tabsEl.scrollLeft += e.deltaY;
      },
      { passive: false },
    );
    // Switch on pointerdown so streaming re-renders cannot swallow the click.
    tabsEl.addEventListener("pointerdown", function (e) {
      if (e.button != null && e.button !== 0) return;
      // Close is handled on click to avoid the mouseup falling through onto the next tab.
      if (e.target.closest("[data-action='close-tab']")) return;
      var tabEl = e.target.closest(".tab");
      if (!tabEl || !tabsEl.contains(tabEl)) return;
      var id = tabEl.getAttribute("data-tab-id");
      if (!id || id === state.activeTabId) return;
      e.preventDefault();
      vscode.postMessage({ type: "switchTab", id: id });
    });

    tabsEl.addEventListener("click", function (e) {
      var closeBtn = e.target.closest("[data-action='close-tab']");
      if (!closeBtn) return;
      var tabEl = e.target.closest(".tab");
      if (!tabEl || !tabsEl.contains(tabEl)) return;
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: "closeTab", id: tabEl.getAttribute("data-tab-id") });
    });

    tabsEl.addEventListener("keydown", function (e) {
      var tabEl = e.target.closest(".tab");
      if (!tabEl || !tabsEl.contains(tabEl)) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      var id = tabEl.getAttribute("data-tab-id");
      if (!id || id === state.activeTabId) return;
      vscode.postMessage({ type: "switchTab", id: id });
    });
  }


  if (uiQuestionEl) {
    uiQuestionEl.addEventListener("click", function (e) {
      const btn = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
      if (!btn) return;
      const card = uiQuestionEl.querySelector(".ui-question-card");
      const id = card && card.getAttribute("data-id");
      if (!id) return;
      const action = btn.getAttribute("data-action");
      if (action === "confirm-yes") {
        answerUiQuestion({ id: id, confirmed: true });
      } else if (action === "confirm-no") {
        answerUiQuestion({ id: id, confirmed: false });
      } else if (action === "select-option") {
        answerUiQuestion({ id: id, value: btn.getAttribute("data-value") || "" });
      } else if (action === "submit-value") {
        const input = uiQuestionEl.querySelector(".ui-q-input");
        answerUiQuestion({ id: id, value: input ? input.value : "" });
      } else if (action === "cancel") {
        answerUiQuestion({ id: id, cancelled: true });
      }
    });
    uiQuestionEl.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.shiftKey) return;
      const input = e.target && e.target.classList && e.target.classList.contains("ui-q-input") ? e.target : null;
      if (!input) return;
      e.preventDefault();
      const card = uiQuestionEl.querySelector(".ui-question-card");
      const id = card && card.getAttribute("data-id");
      if (!id) return;
      answerUiQuestion({ id: id, value: input.value });
    });
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg == null || msg.type == null) return;
    if (msg.type === "ready") {
      const nextTabId = msg.activeTabId || "";
      if (nextTabId !== activeTabIdForScroll) {
        stickToBottom = true;
        activeTabIdForScroll = nextTabId;
      }
      state = {
        status: msg.status,
        messages: msg.messages || [],
        attachments: msg.attachments || [],
        showThinking: msg.showThinking !== false,
        model: msg.model || state.model,
        mode: msg.mode || state.mode,
        displayName: msg.displayName || state.displayName,
        contextUsage: msg.contextUsage != null ? msg.contextUsage : state.contextUsage,
        tabs: msg.tabs || [],
        activeTabId: nextTabId,
        uiQuestion: msg.uiQuestion !== undefined ? msg.uiQuestion : null,
      };
      render();
      return;
    }
    if (msg.type === "status") {
      state.status = msg.status;
      render();
      return;
    }
    if (msg.type === "messages") {
      state.messages = msg.messages || [];
      render();
      return;
    }
    if (msg.type === "attachments") {
      state.attachments = msg.attachments || [];
      render();
      return;
    }
    if (msg.type === "composerPrefill") {
      applyComposerPrefill(msg.text || "");
      return;
    }
    if (msg.type === "config") {
      if (msg.showThinking != null) state.showThinking = msg.showThinking !== false;
      if (msg.model != null) state.model = msg.model;
      if (msg.mode != null) state.mode = msg.mode;
      if (msg.displayName != null) state.displayName = msg.displayName;
      if (msg.contextUsage !== undefined) state.contextUsage = msg.contextUsage;
      if (msg.tabs) state.tabs = msg.tabs;
      if (msg.activeTabId) state.activeTabId = msg.activeTabId;
      if (msg.uiQuestion !== undefined) state.uiQuestion = msg.uiQuestion;
      render();
      return;
    }
    if (msg.type === "uiQuestion") {
      state.uiQuestion = msg.question || null;
      render();
      return;
    }
    if (msg.type === "tabs") {
      state.tabs = msg.tabs || [];
      const nextTabId = msg.activeTabId || state.activeTabId || "";
      if (nextTabId !== activeTabIdForScroll) {
        stickToBottom = true;
        activeTabIdForScroll = nextTabId;
      }
      state.activeTabId = nextTabId;
      render();
      return;
    }
    if (msg.type === "contextUsage") {
      state.contextUsage = msg.contextUsage;
      if (msg.model != null) state.model = msg.model;
      updateChrome();
      return;
    }
    if (msg.type === "fileResults") {
      if (msg.requestId !== suggest.requestId || suggest.kind !== "file") return;
      suggest.items = (msg.files || []).map(function (f) {
        return {
          path: f.path,
          fsPath: f.fsPath,
          kind: f.kind || "file",
          label: f.label || basename(f.path),
          detail: f.detail || f.path,
        };
      });
      suggest.active = 0;
      suggest.open = suggest.items.length > 0;
      renderSuggest();
      return;
    }
    if (msg.type === "error") {
      state.status = { state: "error", detail: msg.message };
      render();
    }
  });

  vscode.postMessage({ type: "ready" });
  render();
})();
