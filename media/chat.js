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
  const imageBtn = document.getElementById("imageBtn");
  const attachFilesBtn = document.getElementById("attachFilesBtn");
  const attachFolderBtn = document.getElementById("attachFolderBtn");
  const attachmentsEl = document.getElementById("attachments");
  const dropOverlay = document.getElementById("dropOverlay");
  const modelBtn = document.getElementById("modelBtn");
  const modeBtn = document.getElementById("modeBtn");
  const modeTopBtn = document.getElementById("modeTopBtn");
  const modelLabel = document.getElementById("modelLabel");
  const modeLabel = document.getElementById("modeLabel");
  const modeTopLabel = document.getElementById("modeTopLabel");
  const greetingTitle = document.getElementById("greetingTitle");
  const usageBtn = document.getElementById("usageBtn");
  const usageLabel = document.getElementById("usageLabel");
  const usageProgress = document.getElementById("usageProgress");
  const tabsEl = document.getElementById("tabs");
  const addTabBtn = document.getElementById("addTabBtn");

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

  function renderMessage(msg) {
    const partsHtml = msg.parts
      .map(function (part, idx) {
        if (part.kind === "text") {
          const cls = msg.streaming && idx === msg.parts.length - 1 ? " streaming" : "";
          return `<div class="bubble${cls}">${renderMarkdownish(part.text || (msg.streaming ? "" : ""))}</div>`;
        }
        return renderPart(part, msg);
      })
      .join("");

    const fallback =
      msg.role === "assistant" && msg.streaming && msg.parts.length === 0
        ? `<div class="bubble streaming"></div>`
        : "";

    return `<article class="msg ${msg.role}" data-id="${msg.id}">
      <div class="role">${msg.role}</div>
      ${partsHtml || fallback}
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
        const thumb = a.previewDataUrl
          ? `<img class="att-thumb" src="${a.previewDataUrl}" alt="" />`
          : `<span class="att-icon">${kindIcon(a.kind)}</span>`;
        const cls = a.kind === "context" ? "att context" : `att ${escapeHtml(a.kind || "file")}`;
        return `<span class="${cls}" data-id="${a.id}" title="${escapeHtml(a.fsPath || a.path || a.label)}">
          ${thumb}
          <span class="att-label">${escapeHtml(a.label)}</span>
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
    if (modeTopLabel) modeTopLabel.textContent = state.mode || "Agent";
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


  function renderTabs() {
    if (!tabsEl) return;
    const tabs = state.tabs || [];
    const activeId = state.activeTabId || "";
    tabsEl.innerHTML = tabs
      .map(function (tab) {
        const active = tab.id === activeId ? " active" : "";
        const busy = tab.busy ? " busy" : "";
        return (
          '<button class="tab' + active + busy + '" data-tab-id="' + escapeHtml(tab.id) + '" title="' + escapeHtml(tab.title) + '">' +
            '<span class="tab-label"><span class="tab-title">' + escapeHtml(tab.title) + '</span></span>' +
            '<span class="tab-close" data-action="close-tab" title="Close" aria-label="Close">' +
              '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
                '<path fill="currentColor" d="M8 8.71L3.29 4 2 5.29 6.71 10 2 14.71 3.29 16 8 11.29 12.71 16 14 14.71 9.29 10 14 5.29 12.71 4 8 8.71z"/>' +
              '</svg>' +
            '</span>' +
          '</button>'
        );
      })
      .join("");
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
  newChatBtn.addEventListener("click", function () { vscode.postMessage({ type: "newChat" }); });
  historyBtn.addEventListener("click", function () { vscode.postMessage({ type: "history" }); });
  moreBtn.addEventListener("click", function () { vscode.postMessage({ type: "moreMenu" }); });
  attachBtn.addEventListener("click", function () { vscode.postMessage({ type: "attachMenu" }); });
  imageBtn.addEventListener("click", function () { vscode.postMessage({ type: "attachFiles" }); });
  attachFilesBtn.addEventListener("click", function () { vscode.postMessage({ type: "attachFiles" }); });
  attachFolderBtn.addEventListener("click", function () { vscode.postMessage({ type: "attachFolder" }); });
  modelBtn.addEventListener("click", function () { vscode.postMessage({ type: "pickModel" }); });
  if (usageBtn) usageBtn.addEventListener("click", function () { vscode.postMessage({ type: "showUsage" }); });
  modeBtn.addEventListener("click", function () { vscode.postMessage({ type: "pickMode" }); });
  modeTopBtn.addEventListener("click", function () { vscode.postMessage({ type: "pickMode" }); });

  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.shiftKey === false) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("input", autosize);

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


  if (addTabBtn) {
    addTabBtn.addEventListener("click", function () {
      vscode.postMessage({ type: "newChat" });
    });
  }

  if (tabsEl) {
    tabsEl.addEventListener("click", function (e) {
      var closeBtn = e.target.closest("[data-action='close-tab']");
      var tabBtn = e.target.closest("button.tab");
      if (closeBtn && tabBtn) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "closeTab", id: tabBtn.getAttribute("data-tab-id") });
        return;
      }
      if (tabBtn) {
        vscode.postMessage({ type: "switchTab", id: tabBtn.getAttribute("data-tab-id") });
      }
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
    if (msg.type === "error") {
      state.status = { state: "error", detail: msg.message };
      render();
    }
  });

  vscode.postMessage({ type: "ready" });
  render();
})();
