(function () {
  const vscode = acquireVsCodeApi();
  const collapseOpenIds = new Set();

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
  };

  let dragDepth = 0;
  // Follow new output only while the user is already near the bottom.
  let stickToBottom = true;
  let activeTabIdForScroll = "";

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

  function thinkingLabel(part, isLive) {
    if (isLive) return "Thinking…";
    const start = Number(part.startedAt);
    const end = Number(part.endedAt || Date.now());
    if (Number.isFinite(start) && end >= start) {
      const dur = formatDuration(end - start);
      if (dur) return "Thought for " + dur;
    }
    return "Thought";
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

  function isFilePathTool(name) {
    const key = normalizeToolKey(name);
    const identity = parseToolIdentity(name);
    const actionKey = identity.action || identity.leaf || key;
    return (
      /^(read|write|edit|delete|get_file|write_file|delete_file|strreplace|search_replace|create_artifact)$/.test(actionKey) ||
      /^(read|write|edit|delete|strreplace|search_replace)$/.test(key)
    );
  }

  function unescapeJsonString(value) {
    try {
      return JSON.parse('"' + value + '"');
    } catch (_) {
      return String(value || "");
    }
  }

  function extractToolFilePath(name, inputPreview) {
    if (!isFilePathTool(name)) return "";
    const obj = parseToolInput(inputPreview);
    if (obj) {
      const keys = ["path", "file", "target_notebook", "target", "entry", "name"];
      for (let i = 0; i < keys.length; i += 1) {
        const value = obj[keys[i]];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
    // Recover path from truncated JSON previews (common for write/edit payloads).
    const text = String(inputPreview || "");
    const match = text.match(/"(?:path|file|target_notebook|target|entry)"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (match && match[1]) return unescapeJsonString(match[1]).trim();
    const nameMatch = text.match(/"name"\s*:\s*"((?:\\.|[^"\\])*(?:\/|\\)(?:\\.|[^"\\])*)"/);
    if (nameMatch && nameMatch[1]) return unescapeJsonString(nameMatch[1]).trim();
    return "";
  }

  function formatToolFilePath(pathValue) {
    let value = String(pathValue || "").trim();
    if (!value) return "";
    if (value.indexOf("file://") === 0) {
      value = value.slice("file://".length);
      if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
    }
    const display = value.replace(/\\/g, "/");
    const parts = display.split("/").filter(Boolean);
    if (parts.length <= 3) return parts.join("/") || display;
    return "…/" + parts.slice(-3).join("/");
  }

  function renderFileLink(pathValue) {
    const full = String(pathValue || "").trim();
    if (!full) return "";
    const display = formatToolFilePath(full);
    return (
      '<button type="button" class="file-link" data-action="open-file" data-path="' +
        escapeHtml(full) +
        '" title="Open ' + escapeHtml(full) + '">' +
        escapeHtml(display) +
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
      /^(read|write|edit|delete|get_file|write_file|delete_file|strreplace|search_replace)$/.test(actionKey) ||
      /^(read|write|edit|delete|strreplace|search_replace)$/.test(key)
    ) {
      value = pick("path", "file", "target_notebook", "target", "entry", "name");
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
      const isLive =
        Boolean(msg && msg.streaming) &&
        (part.streaming === true || (part.streaming !== false && !part.endedAt && hasTextPart(msg) === false));
      const collapseId = "thinking:" + (msg && msg.id ? msg.id : "msg") + ":" + String(partIndex || 0);
      const openAttr = collapseOpenAttr(collapseId, isLive);
      const liveClass = isLive ? " live" : "";
      const streamClass = isLive ? " streaming" : "";
      const label = thinkingLabel(part, isLive);
      const body = escapeHtml(part.text || "");
      return (
        '<details class="collapse thinking' + liveClass + '" data-collapse-id="' + escapeHtml(collapseId) + '"' + openAttr + '>' +
          '<summary class="collapse-summary">' +
            chevronIcon() +
            '<span class="collapse-title">' + escapeHtml(label) + '</span>' +
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
      const openAttr = collapseOpenAttr(collapseId, running);
      const liveClass = running ? " live" : "";
      const title = toolTitle(part.name, part.inputPreview);
      const filePath = extractToolFilePath(part.name, part.inputPreview);
      const summary = filePath ? "" : toolSummary(part.name, part.inputPreview);
      const summaryHtml = filePath
        ? '<span class="collapse-meta">' + renderFileLink(filePath) + '</span>'
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
      return (
        '<details class="collapse tool' + liveClass + '" data-collapse-id="' + escapeHtml(collapseId) + '"' + openAttr + '>' +
          '<summary class="collapse-summary">' +
            chevronIcon() +
            '<span class="collapse-title">' + escapeHtml(title) + '</span>' +
            summaryHtml +
            statusBadge(part.status) +
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
      if (a.kind === "image" && a.previewDataUrl) images.push(a);
      else others.push(a);
    });
    let html = "";
    if (images.length) {
      html += `<div class="msg-images">${images.map(function (a) {
        const alt = escapeHtml(a.label || "image");
        const title = escapeHtml(a.fsPath || a.path || a.label || "");
        return `<img class="msg-image" src="${a.previewDataUrl}" alt="${alt}" title="${title}" />`;
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

    return `<article class="msg ${msg.role}" data-id="${msg.id}">
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
        const thumb = a.previewDataUrl
          ? `<img class="att-thumb" src="${a.previewDataUrl}" alt="" />`
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
      sendBtn.disabled = busy || status.state === "starting";
      sendBtn.hidden = busy;

      const hasMessages = messages.length > 0;
      emptyEl.classList.toggle("visible", hasMessages === false);
      messagesEl.style.display = hasMessages ? "flex" : "none";

      if (hasMessages) {
        const last = messages[messages.length - 1];
        const existing = messagesEl.querySelector(`.msg[data-id="${last.id}"]`);
        const canPatch =
          existing &&
          last.role === "assistant" &&
          last.streaming &&
          messagesEl.children.length === messages.length;
        const prevScrollTop = messagesEl.scrollTop;
        const prevScrollHeight = messagesEl.scrollHeight;
        const shouldStick = stickToBottom || isNearBottom(messagesEl, 80);

        if (canPatch) {
          const thinkingPart = Array.prototype.slice.call(last.parts).reverse().find(function (p) { return p.kind === "thinking"; });
          const textPart = Array.prototype.slice.call(last.parts).reverse().find(function (p) { return p.kind === "text"; });
          const thinkingPre = existing.querySelector("pre.thinking-body");
          const thinkingDetails = existing.querySelector("details.thinking, details.collapse.thinking");
          if (thinkingPart && thinkingPre && thinkingDetails) {
            thinkingPre.textContent = thinkingPart.text || "";
            // Keep the user's expand/collapse choice; only auto-open while live if not closed.
            const live = thinkingPart.streaming !== false && textPart == null;
            thinkingDetails.classList.toggle("live", live);
            const summaryLabel = thinkingDetails.querySelector(".collapse-label, .thinking-label");
            if (summaryLabel) {
              summaryLabel.textContent = live ? "Thinking…" : (summaryLabel.textContent || "Thinking");
            }
            thinkingPre.classList.toggle("streaming", live);
          } else if (thinkingPart && thinkingPre == null) {
            existing.outerHTML = renderMessage(last);
          }

          const bubbles = existing.querySelectorAll(".bubble");
          const lastBubble = bubbles[bubbles.length - 1];
          if (textPart && lastBubble && lastBubble.closest(".thinking") == null && lastBubble.closest(".collapse") == null) {
            lastBubble.innerHTML = renderMarkdownish(textPart.text || "");
            lastBubble.classList.toggle("streaming", true);
          } else if (textPart && lastBubble == null) {
            existing.outerHTML = renderMessage(last);
          }
        } else {
          messagesEl.innerHTML = messages.map(renderMessage).join("");
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
    } catch (err) {
      console.error("OMP Chat render failed", err);
      if (statusDot) {
        statusDot.className = "status-dot error";
        statusDot.title = `UI error: ${err && err.message ? err.message : err}`;
      }
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

  function send() {
    const text = inputEl.value;
    if (text.trim() === "" && state.attachments.length === 0) return;
    stickToBottom = true;
    if (text.trim()) {
      state.messages = state.messages.concat({
        id: `local-${Date.now()}`,
        role: "user",
        createdAt: Date.now(),
        parts: [{ kind: "text", text: text }],
      });
      state.status = { state: "busy", detail: "Sending…" };
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

  messagesEl.addEventListener("click", function (e) {
    const fileBtn = e.target.closest("button[data-action='open-file']");
    if (fileBtn && messagesEl.contains(fileBtn)) {
      e.preventDefault();
      e.stopPropagation();
      const filePath = fileBtn.getAttribute("data-path") || "";
      if (filePath) vscode.postMessage({ type: "openFile", path: filePath });
      return;
    }

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

  attachmentsEl.addEventListener("click", function (e) {
    const btn = e.target.closest("button[data-action='remove-att']");
    if (btn == null) return;
    const id = btn.parentElement && btn.parentElement.getAttribute("data-id");
    if (id) vscode.postMessage({ type: "removeAttachment", id: id });
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
    if (msg.type === "config") {
      if (msg.showThinking != null) state.showThinking = msg.showThinking !== false;
      if (msg.model != null) state.model = msg.model;
      if (msg.mode != null) state.mode = msg.mode;
      if (msg.displayName != null) state.displayName = msg.displayName;
      if (msg.contextUsage !== undefined) state.contextUsage = msg.contextUsage;
      if (msg.tabs) state.tabs = msg.tabs;
      if (msg.activeTabId) state.activeTabId = msg.activeTabId;
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
