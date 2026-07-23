(function () {
  const vscode = acquireVsCodeApi();

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

  function renderMarkdownish(text) {
    const parts = String(text).split(/```/);
    let html = "";
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        html += escapeHtml(parts[i]);
      } else {
        const raw = parts[i];
        const nl = raw.indexOf("\n");
        let lang = "";
        let code = raw;
        if (nl >= 0) {
          lang = raw.slice(0, nl).trim();
          code = raw.slice(nl + 1);
        }
        const safe = escapeHtml(code.replace(/\n$/, ""));
        html += `<div class="md-pre" data-code="${encodeURIComponent(code)}"><code data-lang="${escapeHtml(lang)}">${safe}</code></div>`;
        html += `<div class="code-actions">
          <button class="mini" data-action="copy-code">Copy</button>
          <button class="mini" data-action="insert-code">Insert</button>
        </div>`;
      }
    }
    return html;
  }

  function hasTextPart(msg) {
    return Boolean(msg && msg.parts && msg.parts.some(function (p) { return p.kind === "text" && p.text; }));
  }

  function renderPart(part, msg) {
    if (part.kind === "thinking") {
      if (state.showThinking === false) return "";
      const isLive =
        Boolean(msg && msg.streaming) &&
        (part.streaming === true || (part.streaming !== false && hasTextPart(msg) === false));
      const openAttr = isLive ? " open" : "";
      const liveClass = isLive ? " live" : "";
      const streamClass = isLive ? " streaming" : "";
      const label = isLive ? "Thinking…" : "Thinking";
      const body = escapeHtml(part.text || (isLive ? "" : ""));
      return `<details class="thinking${liveClass}"${openAttr}>
        <summary>${label}</summary>
        <pre class="thinking-body${streamClass}">${body}</pre>
      </details>`;
    }
    if (part.kind === "tool") {
      const out = part.outputPreview
        ? `<pre>${escapeHtml(part.outputPreview)}</pre>`
        : part.inputPreview
          ? `<pre>${escapeHtml(part.inputPreview)}</pre>`
          : "";
      return `<div class="tool">
        <div class="tool-head">
          <div class="tool-name">${escapeHtml(part.name)}</div>
          <div class="badge ${escapeHtml(part.status)}">${escapeHtml(part.status)}</div>
        </div>
        ${out}
      </div>`;
    }
    return `<div class="bubble">${renderMarkdownish(part.text)}</div>`;
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
        return renderPart(part, msg);
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
      return;
    }

    tabsEl.innerHTML = tabs
      .map(function (tab) {
        return buildTabHtml(tab, activeId);
      })
      .join("");
    tabsSignature = signature;
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

        if (canPatch) {
          const thinkingPart = Array.prototype.slice.call(last.parts).reverse().find(function (p) { return p.kind === "thinking"; });
          const textPart = Array.prototype.slice.call(last.parts).reverse().find(function (p) { return p.kind === "text"; });
          const thinkingPre = existing.querySelector("pre.thinking-body");
          const thinkingDetails = existing.querySelector("details.thinking");
          if (thinkingPart && thinkingPre && thinkingDetails) {
            thinkingPre.textContent = thinkingPart.text || "";
            thinkingDetails.open = thinkingPart.streaming !== false && textPart == null;
            thinkingDetails.classList.toggle("live", thinkingDetails.open);
            const summary = thinkingDetails.querySelector("summary");
            if (summary) summary.textContent = thinkingDetails.open ? "Thinking…" : "Thinking";
            thinkingPre.classList.toggle("streaming", thinkingDetails.open);
          } else if (thinkingPart && thinkingPre == null) {
            existing.outerHTML = renderMessage(last);
          }

          const bubbles = existing.querySelectorAll(".bubble");
          const lastBubble = bubbles[bubbles.length - 1];
          if (textPart && lastBubble && lastBubble.closest(".thinking") == null) {
            lastBubble.innerHTML = renderMarkdownish(textPart.text || "");
            lastBubble.classList.toggle("streaming", true);
          } else if (textPart && lastBubble == null) {
            existing.outerHTML = renderMessage(last);
          }
        } else {
          messagesEl.innerHTML = messages.map(renderMessage).join("");
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else {
        messagesEl.innerHTML = "";
      }

      renderAttachments();
    } catch (err) {
      console.error("Oh My Pi Chat render failed", err);
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
    if (text.trim()) {
      state.messages = state.messages.concat({
        id: `local-${Date.now()}`,
        role: "user",
        createdAt: Date.now(),
        parts: [{ kind: "text", text: text }],
      });
      state.status = { state: "busy", detail: "Sending…" };
      render();
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
    const btn = e.target.closest("button[data-action]");
    if (btn == null) return;
    const action = btn.getAttribute("data-action");
    const pre = btn.parentElement && btn.parentElement.previousElementSibling;
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
        activeTabId: msg.activeTabId || "",
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
      state.activeTabId = msg.activeTabId || "";
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
