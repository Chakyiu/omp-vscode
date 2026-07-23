(function () {
  const vscode = acquireVsCodeApi();

  const appEl = document.getElementById("app");
  const messagesEl = document.getElementById("messages");
  const emptyEl = document.getElementById("empty");
  const statusEl = document.getElementById("status");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const stopBtn = document.getElementById("stopBtn");
  const newChatBtn = document.getElementById("newChatBtn");
  const restartBtn = document.getElementById("restartBtn");
  const attachBtn = document.getElementById("attachBtn");
  const attachFilesBtn = document.getElementById("attachFilesBtn");
  const attachFolderBtn = document.getElementById("attachFolderBtn");
  const attachmentsEl = document.getElementById("attachments");
  const dropOverlay = document.getElementById("dropOverlay");

  let state = {
    status: { state: "starting", detail: "Starting…" },
    messages: [],
    attachments: [],
    showThinking: true,
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

  function renderPart(part) {
    if (part.kind === "thinking") {
      if (!state.showThinking) return "";
      return `<details class="thinking"><summary>Thinking</summary><pre>${escapeHtml(part.text)}</pre></details>`;
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
      .map((part, idx) => {
        if (part.kind === "text") {
          const cls = msg.streaming && idx === msg.parts.length - 1 ? "streaming" : "";
          return `<div class="bubble ${cls}">${renderMarkdownish(part.text || (msg.streaming ? "" : ""))}</div>`;
        }
        return renderPart(part);
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
    if (kind === "image") return "🖼️";
    if (kind === "selection") return "✂️";
    return "📄";
  }

  function renderAttachments() {
    if (!state.attachments.length) {
      attachmentsEl.innerHTML = "";
      return;
    }
    attachmentsEl.innerHTML = state.attachments
      .map((a) => {
        const thumb = a.previewDataUrl
          ? `<img class="att-thumb" src="${a.previewDataUrl}" alt="" />`
          : `<span class="att-icon">${kindIcon(a.kind)}</span>`;
        return `<span class="att ${escapeHtml(a.kind || "file")}" data-id="${a.id}" title="${escapeHtml(a.fsPath || a.path || a.label)}">
          ${thumb}
          <span class="att-label">${escapeHtml(a.label)}</span>
          <button data-action="remove-att" title="Remove">×</button>
        </span>`;
      })
      .join("");
  }

  function render() {
    try {
      const { status, messages } = state;
      statusEl.textContent = status.detail || status.state;
      statusEl.className = `status ${status.state}`;

      const busy = status.state === "busy";
      stopBtn.hidden = __omp_shell("busy;")
      sendBtn.disabled = busy || status.state === "starting";

      const hasMessages = messages.length > 0;
      emptyEl.classList.toggle("visible", !hasMessages);
      messagesEl.style.display = hasMessages ? "flex" : "none";
      messagesEl.innerHTML = messages.map(renderMessage).join("");
      renderAttachments();

      if (hasMessages) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    } catch (err) {
      console.error("Oh My Pi Chat render failed", err);
      statusEl.textContent = `UI error: ${err && err.message ? err.message : err}`;
      statusEl.className = "status error";
    }
  }

  function send() {
    const text = inputEl.value;
    if (!text.trim() && state.attachments.length === 0) return;
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
    vscode.postMessage({ type: "send", text });
    inputEl.value = "";
    autosize();
  }

  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const idx = result.indexOf(",");
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  function fileToText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
      reader.readAsText(file);
    });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const paths = files.map((f) => f.path).filter(Boolean);
    if (paths.length) {
      vscode.postMessage({ type: "attachPaths", paths });
      return;
    }

    for (const file of files) {
      if (file.type && file.type.startsWith("image/")) {
        const base64 = await fileToBase64(file);
        vscode.postMessage({
          type: "attachImage",
          name: file.name || `image-${Date.now()}.png`,
          mimeType: file.type || "image/png",
          base64,
        });
        continue;
      }
      const content = await fileToText(file);
      vscode.postMessage({
        type: "attachTextFile",
        name: file.name || "dropped.txt",
        content,
      });
    }
  }

  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  newChatBtn.addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
  restartBtn.addEventListener("click", () => vscode.postMessage({ type: "restart" }));
  attachBtn.addEventListener("click", () => vscode.postMessage({ type: "attachMenu" }));
  attachFilesBtn.addEventListener("click", () => vscode.postMessage({ type: "attachFiles" }));
  attachFolderBtn.addEventListener("click", () => vscode.postMessage({ type: "attachFolder" }));

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("input", autosize);

  inputEl.addEventListener("paste", async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items || !items.length) return;

    const imageItems = Array.from(items).filter((item) => item.type && item.type.startsWith("image/"));
    if (!imageItems.length) return;

    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const base64 = await fileToBase64(file);
      const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
      vscode.postMessage({
        type: "attachImage",
        name: file.name || `paste-${Date.now()}.${ext}`,
        mimeType: file.type || "image/png",
        base64,
      });
    }
  });

  emptyEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    inputEl.value = btn.getAttribute("data-prompt") || "";
    autosize();
    inputEl.focus();
  });

  messagesEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const pre = btn.parentElement && btn.parentElement.previousElementSibling;
    const encoded = pre && pre.getAttribute && pre.getAttribute("data-code");
    const text = encoded ? decodeURIComponent(encoded) : "";
    if (action === "copy-code" && text) {
      vscode.postMessage({ type: "copy", text });
    }
    if (action === "insert-code" && text) {
      vscode.postMessage({ type: "insert", text });
    }
  });

  attachmentsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action='remove-att']");
    if (!btn) return;
    const id = btn.parentElement && btn.parentElement.getAttribute("data-id");
    if (id) vscode.postMessage({ type: "removeAttachment", id });
  });

  function showDrop(show) {
    if (!dropOverlay) return;
    dropOverlay.hidden = __omp_shell("show;")
  }

  ["dragenter", "dragover"].forEach((evt) => {
    appEl.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (evt === "dragenter") dragDepth += 1;
      showDrop(true);
    });
  });
  appEl.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDrop(false);
  });
  appEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    showDrop(false);
    try {
      await handleFiles(e.dataTransfer && e.dataTransfer.files);
    } catch (err) {
      console.error(err);
      state.status = { state: "error", detail: err && err.message ? err.message : String(err) };
      render();
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    if (msg.type === "ready") {
      state = {
        status: msg.status,
        messages: msg.messages || [],
        attachments: msg.attachments || [],
        showThinking: msg.showThinking !== false,
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
      state.showThinking = msg.showThinking !== false;
      render();
      return;
    }
    if (msg.type === "error") {
      state.status = { state: "error", detail: msg.message };
      sendBtn.disabled = false;
      render();
    }
  });

  vscode.postMessage({ type: "ready" });
  render();
})();
