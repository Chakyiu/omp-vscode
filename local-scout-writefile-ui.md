
===== data-href / early click helpers (100-150) =====
100|    if (!value) return false;
101|    if (/^\s*javascript:/i.test(value)) return false;
102|    if (/^\s*data:/i.test(value)) return false;
103|    return /^(https?:\/\/|vscode:|file:|mailto:|#|\/|\.\/|\.\.\/|[A-Za-z]:\\)/i.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value);
104|  }
105|
106|  function renderInlineMarkdown(text) {
107|    const codes = [];
108|    let s = String(text == null ? "" : text);
109|    s = s.replace(/`([^`\n]+)`/g, function (_, code) {
110|      codes.push(code);
111|      return "\u0000CODE" + (codes.length - 1) + "\u0000";
112|    });
113|    s = escapeHtml(s);
114|
115|    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, function (_, label, href, title) {
116|      if (!isSafeHref(href)) return label;
117|      const titleAttr = title ? ' title="' + escapeHtml(title) + '"' : "";
118|      return '<a href="' + escapeHtml(href) + '" data-href="' + escapeHtml(href) + '"' + titleAttr + ">" + label + "</a>";
119|    });
120|
121|    s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
122|    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
123|    s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
124|    s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?!\s)\*(?!\*)/g, "$1<em>$2</em>");
125|    s = s.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)(?!\s)_(?!_)/g, "$1<em>$2</em>");
126|
127|    s = s.replace(/\u0000CODE(\d+)\u0000/g, function (_, idx) {
128|      return "<code>" + escapeHtml(codes[Number(idx)] || "") + "</code>";
129|    });
130|    return s;
131|  }
132|
133|  function renderCodeBlock(lang, code) {
134|    const clean = String(code || "").replace(/\n$/, "");
135|    const safe = escapeHtml(clean);
136|    return (
137|      '<div class="md-code">' +
138|        '<div class="md-pre" data-code="' + encodeURIComponent(clean) + '"><code data-lang="' + escapeHtml(lang || "") + '">' + safe + "</code></div>" +
139|        '<div class="code-actions">' +
140|          '<button class="mini" data-action="copy-code">Copy</button>' +
141|          '<button class="mini" data-action="insert-code">Insert</button>' +
142|        "</div>" +
143|      "</div>"
144|    );
145|  }
146|
147|  function renderMarkdownBlocks(src) {
148|    const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
149|    let html = "";
150|    let i = 0;

===== toolTitle map + write/edit labels (355-420) =====
355|    }
356|    // open_design-style without trailing underscore already handled; also
357|    // browser_navigate / web_search style single tokens.
358|    return { leaf: leaf, action: leaf, group: "" };
359|  }
360|
361|  function toolTitle(name, inputPreview) {
362|    const key = normalizeToolKey(name);
363|    const identity = parseToolIdentity(name);
364|    const actionKey = identity.action || identity.leaf || key;
365|
366|    if (key === "bash" || key === "shell" || actionKey === "bash" || actionKey === "shell") {
367|      const obj = parseToolInput(inputPreview);
368|      const cmd = obj && (obj.command || obj.cmd);
369|      if (typeof cmd === "string") {
370|        if (/^\s*ls\b/.test(cmd)) return "Listed directory";
371|        if (/^\s*find\b/.test(cmd)) return "Found files";
372|        if (/^\s*cat\b/.test(cmd)) return "Read";
373|        if (/^\s*rg\b|^\s*grep\b/.test(cmd)) return "Grep";
374|      }
375|      return "Ran command";
376|    }
377|
378|    const map = {
379|      read: "Read",
380|      read_file: "Read",
381|      get_file: "Read",
382|      grep: "Grep",
383|      glob: "Searched files",
384|      write: "Wrote",
385|      write_file: "Wrote",
386|      edit: "Edited",
387|      strreplace: "Edited",
388|      search_replace: "Edited",
389|      delete: "Deleted",
390|      delete_file: "Deleted",
391|      web_search: "Searched web",
392|      webfetch: "Fetched",
393|      fetch: "Fetched",
394|      todo: "Updated todos",
395|      todowrite: "Updated todos",
396|      navigate: "Navigate",
397|      browser_navigate: "Navigate",
398|      browser_click: "Click",
399|      click: "Click",
400|      browser_fill: "Fill",
401|      fill: "Fill",
402|      browser_type: "Type",
403|      type: "Type",
404|      browser_snapshot: "Snapshot",
405|      snapshot: "Snapshot",
406|      browser_screenshot: "Screenshot",
407|      screenshot: "Screenshot",
408|      browser_scroll: "Scroll",
409|      scroll: "Scroll",
410|      browser_wait_for: "Wait",
411|      wait_for: "Wait",
412|      browser_wait_for_text: "Wait for text",
413|      wait_for_text: "Wait for text",
414|      browser_tabs: "Browser tabs",
415|      browser_tab_new: "New tab",
416|      browser_tab_close: "Close tab",
417|      browser_reload: "Reload",
418|      browser_back: "Back",
419|      browser_forward: "Forward",
420|      get_artifact: "Get artifact",

===== path extract + renderFileLink + toolSummary (450-540) =====
450|    if (!text) return null;
451|    try {
452|      const obj = JSON.parse(text);
453|      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
454|    } catch (_) {
455|      // fall through
456|    }
457|    return null;
458|  }
459|
460|  function isFilePathTool(name) {
461|    const key = normalizeToolKey(name);
462|    const identity = parseToolIdentity(name);
463|    const actionKey = identity.action || identity.leaf || key;
464|    return (
465|      /^(read|write|edit|delete|get_file|write_file|delete_file|strreplace|search_replace|create_artifact)$/.test(actionKey) ||
466|      /^(read|write|edit|delete|strreplace|search_replace)$/.test(key)
467|    );
468|  }
469|
470|  function unescapeJsonString(value) {
471|    try {
472|      return JSON.parse('"' + value + '"');
473|    } catch (_) {
474|      return String(value || "");
475|    }
476|  }
477|
478|  function extractToolFilePath(name, inputPreview) {
479|    if (!isFilePathTool(name)) return "";
480|    const obj = parseToolInput(inputPreview);
481|    if (obj) {
482|      const keys = ["path", "file", "target_notebook", "target", "entry", "name"];
483|      for (let i = 0; i < keys.length; i += 1) {
484|        const value = obj[keys[i]];
485|        if (typeof value === "string" && value.trim()) return value.trim();
486|      }
487|    }
488|    // Recover path from truncated JSON previews (common for write/edit payloads).
489|    const text = String(inputPreview || "");
490|    const match = text.match(/"(?:path|file|target_notebook|target|entry)"\s*:\s*"((?:\\.|[^"\\])*)"/);
491|    if (match && match[1]) return unescapeJsonString(match[1]).trim();
492|    const nameMatch = text.match(/"name"\s*:\s*"((?:\\.|[^"\\])*(?:\/|\\)(?:\\.|[^"\\])*)"/);
493|    if (nameMatch && nameMatch[1]) return unescapeJsonString(nameMatch[1]).trim();
494|    return "";
495|  }
496|
497|  function formatToolFilePath(pathValue) {
498|    let value = String(pathValue || "").trim();
499|    if (!value) return "";
500|    if (value.indexOf("file://") === 0) {
501|      value = value.slice("file://".length);
502|      if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
503|    }
504|    const display = value.replace(/\\/g, "/");
505|    const parts = display.split("/").filter(Boolean);
506|    if (parts.length <= 3) return parts.join("/") || display;
507|    return "…/" + parts.slice(-3).join("/");
508|  }
509|
510|  function renderFileLink(pathValue) {
511|    const full = String(pathValue || "").trim();
512|    if (!full) return "";
513|    const display = formatToolFilePath(full);
514|    return (
515|      '<button type="button" class="file-link" data-action="open-file" data-path="' +
516|        escapeHtml(full) +
517|        '" title="Open ' + escapeHtml(full) + '">' +
518|        escapeHtml(display) +
519|      "</button>"
520|    );
521|  }
522|
523|  function toolSummary(name, inputPreview) {
524|    const obj = parseToolInput(inputPreview);
525|    const key = normalizeToolKey(name);
526|    const identity = parseToolIdentity(name);
527|    const actionKey = identity.action || identity.leaf || key;
528|    if (!obj) {
529|      const one = String(inputPreview || "").replace(/\s+/g, " ").trim();
530|      return one.length > 72 ? one.slice(0, 72) + "…" : one;
531|    }
532|    const pick = function () {
533|      for (let i = 0; i < arguments.length; i += 1) {
534|        const v = obj[arguments[i]];
535|        if (typeof v === "string" && v.trim()) return v.trim();
536|      }
537|      return "";
538|    };
539|    let value = "";
540|    if (key === "bash" || key === "shell" || actionKey === "bash" || actionKey === "shell") {

===== renderPart tool HTML (580-700) =====
580|    if (s === "error") {
581|      return '<span class="badge error" title="Error">!</span>';
582|    }
583|    return '<span class="badge running" title="Running"><span class="badge-dot"></span></span>';
584|  }
585|
586|  function renderPart(part, msg, partIndex) {
587|    if (part.kind === "thinking") {
588|      if (state.showThinking === false) return "";
589|      const isLive =
590|        Boolean(msg && msg.streaming) &&
591|        (part.streaming === true || (part.streaming !== false && !part.endedAt && hasTextPart(msg) === false));
592|      const collapseId = "thinking:" + (msg && msg.id ? msg.id : "msg") + ":" + String(partIndex || 0);
593|      const openAttr = collapseOpenAttr(collapseId, isLive);
594|      const liveClass = isLive ? " live" : "";
595|      const streamClass = isLive ? " streaming" : "";
596|      const label = thinkingLabel(part, isLive);
597|      const body = escapeHtml(part.text || "");
598|      return (
599|        '<details class="collapse thinking' + liveClass + '" data-collapse-id="' + escapeHtml(collapseId) + '"' + openAttr + '>' +
600|          '<summary class="collapse-summary">' +
601|            chevronIcon() +
602|            '<span class="collapse-title">' + escapeHtml(label) + '</span>' +
603|          '</summary>' +
604|          '<div class="collapse-body">' +
605|            '<pre class="thinking-body' + streamClass + '">' + body + '</pre>' +
606|          '</div>' +
607|        '</details>'
608|      );
609|    }
610|    if (part.kind === "tool") {
611|      const running = part.status === "running";
612|      const collapseId = "tool:" + String(part.id || part.name || "tool");
613|      const openAttr = collapseOpenAttr(collapseId, running);
614|      const liveClass = running ? " live" : "";
615|      const title = toolTitle(part.name, part.inputPreview);
616|      const filePath = extractToolFilePath(part.name, part.inputPreview);
617|      const summary = filePath ? "" : toolSummary(part.name, part.inputPreview);
618|      const summaryHtml = filePath
619|        ? '<span class="collapse-meta">' + renderFileLink(filePath) + '</span>'
620|        : (summary ? '<span class="collapse-meta">' + escapeHtml(summary) + '</span>' : "");
621|      const sections = [];
622|      if (part.inputPreview) {
623|        sections.push(
624|          '<div class="tool-section">' +
625|            '<div class="tool-section-label">Input</div>' +
626|            '<pre>' + escapeHtml(part.inputPreview) + '</pre>' +
627|          '</div>'
628|        );
629|      }
630|      if (part.outputPreview) {
631|        sections.push(
632|          '<div class="tool-section">' +
633|            '<div class="tool-section-label">Output</div>' +
634|            '<pre>' + escapeHtml(part.outputPreview) + '</pre>' +
635|          '</div>'
636|        );
637|      }
638|      const body = sections.length
639|        ? '<div class="collapse-body tool-body">' + sections.join("") + '</div>'
640|        : "";
641|      return (
642|        '<details class="collapse tool' + liveClass + '" data-collapse-id="' + escapeHtml(collapseId) + '"' + openAttr + '>' +
643|          '<summary class="collapse-summary">' +
644|            chevronIcon() +
645|            '<span class="collapse-title">' + escapeHtml(title) + '</span>' +
646|            summaryHtml +
647|            statusBadge(part.status) +
648|          '</summary>' +
649|          body +
650|        '</details>'
651|      );
652|    }
653|    return '<div class="bubble">' + renderMarkdownish(part.text) + '</div>';
654|  }
655|
656|  function renderMessageAttachments(attachments) {
657|    if (!attachments || attachments.length === 0) return "";
658|    const images = [];
659|    const others = [];
660|    attachments.forEach(function (a) {
661|      if (a.kind === "image" && a.previewDataUrl) images.push(a);
662|      else others.push(a);
663|    });
664|    let html = "";
665|    if (images.length) {
666|      html += `<div class="msg-images">${images.map(function (a) {
667|        const alt = escapeHtml(a.label || "image");
668|        const title = escapeHtml(a.fsPath || a.path || a.label || "");
669|        return `<img class="msg-image" src="${a.previewDataUrl}" alt="${alt}" title="${title}" />`;
670|      }).join("")}</div>`;
671|    }
672|    if (others.length) {
673|      html += `<div class="msg-atts">${others.map(function (a) {
674|        const label = escapeHtml(a.label || a.path || a.fsPath || a.kind || "file");
675|        const title = escapeHtml(a.fsPath || a.path || a.label || "");
676|        return `<span class="msg-att ${escapeHtml(a.kind || "file")}" title="${title}">
677|          <span class="att-icon">${kindIcon(a.kind)}</span>
678|          <span class="att-label">${label}</span>
679|        </span>`;
680|      }).join("")}</div>`;
681|    }
682|    return html;
683|  }
684|
685|  function renderMessage(msg) {
686|    const partsHtml = (msg.parts || [])
687|      .map(function (part, idx) {
688|        if (part.kind === "text") {
689|          const cls = msg.streaming && idx === msg.parts.length - 1 ? " streaming" : "";
690|          return `<div class="bubble${cls}">${renderMarkdownish(part.text || (msg.streaming ? "" : ""))}</div>`;
691|        }
692|        return renderPart(part, msg, idx);
693|      })
694|      .join("");
695|
696|    const attachmentsHtml = renderMessageAttachments(msg.attachments);
697|
698|    const fallback =
699|      msg.role === "assistant" && msg.streaming && (!msg.parts || msg.parts.length === 0)
700|        ? `<div class="bubble streaming"></div>`

===== more data-action HTML (720-850) =====
720|      attachmentsEl.innerHTML = "";
721|      return;
722|    }
723|    attachmentsEl.innerHTML = state.attachments
724|      .map(function (a) {
725|        const isImagePreview = a.kind === "image" && a.previewDataUrl;
726|        const thumb = a.previewDataUrl
727|          ? `<img class="att-thumb" src="${a.previewDataUrl}" alt="" />`
728|          : `<span class="att-icon">${kindIcon(a.kind)}</span>`;
729|        const cls = a.kind === "context" ? "att context" : `att ${escapeHtml(a.kind || "file")}`;
730|        const label = isImagePreview ? "" : `<span class="att-label">${escapeHtml(a.label)}</span>`;
731|        return `<span class="${cls}" data-id="${a.id}" title="${escapeHtml(a.fsPath || a.path || a.label)}">
732|          ${thumb}
733|          ${label}
734|          <button data-action="remove-att" title="Remove">×</button>
735|        </span>`;
736|      })
737|      .join("");
738|  }
739|
740|
741|  function formatTokens(n) {
742|    const num = Number(n) || 0;
743|    if (num >= 1000000) {
744|      const v = num / 1000000;
745|      return (Math.round(v * 10) / 10) + "M";
746|    }
747|    if (num >= 1000) return Math.round(num / 1000) + "k";
748|    return String(Math.round(num));
749|  }
750|
751|  function shortModelName(name) {
752|    const raw = String(name || "Model");
753|    // Keep labels compact like Cursor.
754|    return raw
755|      .replace(/^Cursor\s+/i, "")
756|      .replace(/^Claude\s+/i, "Claude ")
757|      .trim();
758|  }
759|
760|  function updateUsage() {
761|    const usage = state.contextUsage;
762|    if (usageLabel == null || usageBtn == null) return;
763|    if (usage == null || !usage.contextWindow) {
764|      usageLabel.textContent = "0%";
765|      usageBtn.title = "Context usage this session";
766|      usageBtn.classList.remove("warn", "critical");
767|      if (usageProgress) {
768|        usageProgress.style.strokeDashoffset = String(2 * Math.PI * 11);
769|      }
770|      return;
771|    }
772|    const pct = Math.max(0, Math.min(100, Number(usage.percent) || 0));
773|    const label = pct < 1 ? pct.toFixed(2) + "%" : pct.toFixed(1) + "%";
774|    usageLabel.textContent = label;
775|    usageBtn.title =
776|      "Context: " +
777|      formatTokens(usage.tokens) +
778|      " / " +
779|      formatTokens(usage.contextWindow) +
780|      " (" +
781|      label +
782|      ")";
783|    usageBtn.classList.toggle("warn", pct >= 70 && pct < 90);
784|    usageBtn.classList.toggle("critical", pct >= 90);
785|    if (usageProgress) {
786|      const c = 2 * Math.PI * 11;
787|      const offset = c * (1 - pct / 100);
788|      usageProgress.style.strokeDasharray = String(c);
789|      usageProgress.style.strokeDashoffset = String(offset);
790|    }
791|  }
792|
793|  function updateChrome() {
794|    const status = state.status || { state: "starting" };
795|    if (statusDot) {
796|      statusDot.className = `status-dot ${status.state || ""}`;
797|      statusDot.title = status.detail || status.state || "";
798|    }
799|    if (modelLabel) modelLabel.textContent = shortModelName(state.model || "Model");
800|    if (modelBtn) modelBtn.title = "Model: " + (state.model || "Default");
801|    if (modeLabel) modeLabel.textContent = state.mode || "Agent";
802|    if (greetingTitle) {
803|      greetingTitle.textContent = state.displayName
804|        ? `How can I help you, ${state.displayName}?`
805|        : "How can I help you?";
806|    }
807|    updateUsage();
808|  }
809|
810|  function notBusy() {
811|    return state.status.state !== "busy";
812|  }
813|
814|
815|  let tabsSignature = "";
816|
817|  function tabCloseIcon() {
818|    return (
819|      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
820|        '<path fill="currentColor" d="M8 8.71L3.29 4 2 5.29 6.71 10 2 14.71 3.29 16 8 11.29 12.71 16 14 14.71 9.29 10 14 5.29 12.71 4 8 8.71z"/>' +
821|      '</svg>'
822|    );
823|  }
824|
825|  function buildTabHtml(tab, activeId) {
826|    const active = tab.id === activeId ? " active" : "";
827|    const busy = tab.busy ? " busy" : "";
828|    return (
829|      '<div class="tab' + active + busy + '" role="tab" tabindex="0" aria-selected="' + (tab.id === activeId ? "true" : "false") + '" data-tab-id="' + escapeHtml(tab.id) + '" title="' + escapeHtml(tab.title) + '">' +
830|        '<span class="tab-label"><span class="tab-title">' + escapeHtml(tab.title) + '</span></span>' +
831|        '<button type="button" class="tab-close" data-action="close-tab" title="Close" aria-label="Close">' +
832|          tabCloseIcon() +
833|        '</button>' +
834|      '</div>'
835|    );
836|  }
837|
838|  function ensureActiveTabVisible() {
839|    if (!tabsEl) return;
840|    const active = tabsEl.querySelector(".tab.active");
841|    if (!active || typeof active.scrollIntoView !== "function") return;
842|    active.scrollIntoView({ inline: "nearest", block: "nearest" });
843|  }
844|
845|  function renderTabs() {
846|    if (!tabsEl) return;
847|    const tabs = state.tabs || [];
848|    const activeId = state.activeTabId || "";
849|    const signature =
850|      tabs

===== click handlers openFile/openExternal (1270-1320) =====
1270|  });
1271|
1272|  emptyEl.addEventListener("click", function (e) {
1273|    const btn = e.target.closest(".chip");
1274|    if (btn == null) return;
1275|    inputEl.value = btn.getAttribute("data-prompt") || "";
1276|    autosize();
1277|    inputEl.focus();
1278|  });
1279|
1280|  messagesEl.addEventListener("click", function (e) {
1281|    const fileBtn = e.target.closest("button[data-action='open-file']");
1282|    if (fileBtn && messagesEl.contains(fileBtn)) {
1283|      e.preventDefault();
1284|      e.stopPropagation();
1285|      const filePath = fileBtn.getAttribute("data-path") || "";
1286|      if (filePath) vscode.postMessage({ type: "openFile", path: filePath });
1287|      return;
1288|    }
1289|
1290|    const link = e.target.closest("a[data-href], a[href]");
1291|    if (link && messagesEl.contains(link)) {
1292|      const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
1293|      if (href) {
1294|        e.preventDefault();
1295|        vscode.postMessage({ type: "openExternal", url: href });
1296|        return;
1297|      }
1298|    }
1299|
1300|    const btn = e.target.closest("button[data-action]");
1301|    if (btn == null) return;
1302|    const action = btn.getAttribute("data-action");
1303|    const codeRoot = btn.closest(".md-code");
1304|    const pre = (codeRoot && codeRoot.querySelector(".md-pre")) ||
1305|      (btn.parentElement && btn.parentElement.previousElementSibling);
1306|    const encoded = pre && pre.getAttribute && pre.getAttribute("data-code");
1307|    const text = encoded ? decodeURIComponent(encoded) : "";
1308|    if (action === "copy-code" && text) vscode.postMessage({ type: "copy", text: text });
1309|    if (action === "insert-code" && text) vscode.postMessage({ type: "insert", text: text });
1310|  });
1311|
1312|  attachmentsEl.addEventListener("click", function (e) {
1313|    const btn = e.target.closest("button[data-action='remove-att']");
1314|    if (btn == null) return;
1315|    const id = btn.parentElement && btn.parentElement.getAttribute("data-id");
1316|    if (id) vscode.postMessage({ type: "removeAttachment", id: id });
1317|  });
1318|
1319|  if (suggestListEl) {
1320|    suggestListEl.addEventListener("mousedown", function (e) {

===== more click handlers (1365-1400) =====
1365|      "wheel",
1366|      function (e) {
1367|        if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
1368|        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
1369|        e.preventDefault();
1370|        tabsEl.scrollLeft += e.deltaY;
1371|      },
1372|      { passive: false },
1373|    );
1374|    // Switch on pointerdown so streaming re-renders cannot swallow the click.
1375|    tabsEl.addEventListener("pointerdown", function (e) {
1376|      if (e.button != null && e.button !== 0) return;
1377|      // Close is handled on click to avoid the mouseup falling through onto the next tab.
1378|      if (e.target.closest("[data-action='close-tab']")) return;
1379|      var tabEl = e.target.closest(".tab");
1380|      if (!tabEl || !tabsEl.contains(tabEl)) return;
1381|      var id = tabEl.getAttribute("data-tab-id");
1382|      if (!id || id === state.activeTabId) return;
1383|      e.preventDefault();
1384|      vscode.postMessage({ type: "switchTab", id: id });
1385|    });
1386|
1387|    tabsEl.addEventListener("click", function (e) {
1388|      var closeBtn = e.target.closest("[data-action='close-tab']");
1389|      if (!closeBtn) return;
1390|      var tabEl = e.target.closest(".tab");
1391|      if (!tabEl || !tabsEl.contains(tabEl)) return;
1392|      e.preventDefault();
1393|      e.stopPropagation();
1394|      vscode.postMessage({ type: "closeTab", id: tabEl.getAttribute("data-tab-id") });
1395|    });
1396|
1397|    tabsEl.addEventListener("keydown", function (e) {
1398|      var tabEl = e.target.closest(".tab");
1399|      if (!tabEl || !tabsEl.contains(tabEl)) return;
1400|      if (e.key !== "Enter" && e.key !== " ") return;

===== FileLink / file-link hits =====
media/chat.css:173:.collapse-meta .file-link {
media/chat.css:193:.collapse-meta .file-link:hover {
media/chat.css:197:.tool > .collapse-summary .collapse-meta .file-link {
media/chat.js:510:function renderFileLink(pathValue) {
media/chat.js:515:'<button type="button" class="file-link" data-action="open-file" data-path="' +
media/chat.js:619:? '<span class="collapse-meta">' + renderFileLink(filePath) + '</span>'

===== toolSummary full (523-575) =====
523|  function toolSummary(name, inputPreview) {
524|    const obj = parseToolInput(inputPreview);
525|    const key = normalizeToolKey(name);
526|    const identity = parseToolIdentity(name);
527|    const actionKey = identity.action || identity.leaf || key;
528|    if (!obj) {
529|      const one = String(inputPreview || "").replace(/\s+/g, " ").trim();
530|      return one.length > 72 ? one.slice(0, 72) + "…" : one;
531|    }
532|    const pick = function () {
533|      for (let i = 0; i < arguments.length; i += 1) {
534|        const v = obj[arguments[i]];
535|        if (typeof v === "string" && v.trim()) return v.trim();
536|      }
537|      return "";
538|    };
539|    let value = "";
540|    if (key === "bash" || key === "shell" || actionKey === "bash" || actionKey === "shell") {
541|      value = pick("command", "cmd");
542|      if (/^\s*ls\b/.test(value)) return value;
543|    } else if (actionKey === "grep" || key === "grep") {
544|      value = pick("pattern", "query", "path");
545|    } else if (actionKey === "glob" || key === "glob") {
546|      value = pick("path", "glob_pattern", "pattern");
547|    } else if (
548|      /^(read|write|edit|delete|get_file|write_file|delete_file|strreplace|search_replace)$/.test(actionKey) ||
549|      /^(read|write|edit|delete|strreplace|search_replace)$/.test(key)
550|    ) {
551|      value = pick("path", "file", "target_notebook", "target", "entry", "name");
552|      if (value) value = formatToolFilePath(value);
553|    } else if (/navigate|screenshot|snapshot|click|fill|type|scroll|wait/.test(actionKey)) {
554|      value = pick("url", "uri", "selector", "ref", "text", "query", "i", "name", "path");
555|    } else if (/artifact|project|run|file/.test(actionKey)) {
556|      value = pick("entry", "path", "name", "project", "runId", "url", "i");
557|      if (value) {
558|        const parts = value.split(/[\\/]/);
559|        if (parts.length > 2) value = parts.slice(-2).join("/");
560|      }
561|    } else {
562|      value = pick("path", "url", "uri", "entry", "query", "pattern", "command", "name", "selector", "text", "i");
563|    }
564|    if (!value) {
565|      try {
566|        value = JSON.stringify(obj);
567|      } catch (_) {
568|        value = String(inputPreview || "");
569|      }
570|    }
571|    value = value.replace(/\s+/g, " ").trim();
572|    return value.length > 72 ? value.slice(0, 72) + "…" : value;
573|  }
574|
575|  function statusBadge(status) {

===== renderPart tool HTML (586-700) =====
586|  function renderPart(part, msg, partIndex) {
587|    if (part.kind === "thinking") {
588|      if (state.showThinking === false) return "";
589|      const isLive =
590|        Boolean(msg && msg.streaming) &&
591|        (part.streaming === true || (part.streaming !== false && !part.endedAt && hasTextPart(msg) === false));
592|      const collapseId = "thinking:" + (msg && msg.id ? msg.id : "msg") + ":" + String(partIndex || 0);
593|      const openAttr = collapseOpenAttr(collapseId, isLive);
594|      const liveClass = isLive ? " live" : "";
595|      const streamClass = isLive ? " streaming" : "";
596|      const label = thinkingLabel(part, isLive);
597|      const body = escapeHtml(part.text || "");
598|      return (
599|        '<details class="collapse thinking' + liveClass + '" data-collapse-id="' + escapeHtml(collapseId) + '"' + openAttr + '>' +
600|          '<summary class="collapse-summary">' +
601|            chevronIcon() +
602|            '<span class="collapse-title">' + escapeHtml(label) + '</span>' +
603|          '</summary>' +
604|          '<div class="collapse-body">' +
605|            '<pre class="thinking-body' + streamClass + '">' + body + '</pre>' +
606|          '</div>' +
607|        '</details>'
608|      );
609|    }
610|    if (part.kind === "tool") {
611|      const running = part.status === "running";
612|      const collapseId = "tool:" + String(part.id || part.name || "tool");
613|      const openAttr = collapseOpenAttr(collapseId, running);
614|      const liveClass = running ? " live" : "";
615|      const title = toolTitle(part.name, part.inputPreview);
616|      const filePath = extractToolFilePath(part.name, part.inputPreview);
617|      const summary = filePath ? "" : toolSummary(part.name, part.inputPreview);
618|      const summaryHtml = filePath
619|        ? '<span class="collapse-meta">' + renderFileLink(filePath) + '</span>'
620|        : (summary ? '<span class="collapse-meta">' + escapeHtml(summary) + '</span>' : "");
621|      const sections = [];
622|      if (part.inputPreview) {
623|        sections.push(
624|          '<div class="tool-section">' +
625|            '<div class="tool-section-label">Input</div>' +
626|            '<pre>' + escapeHtml(part.inputPreview) + '</pre>' +
627|          '</div>'
628|        );
629|      }
630|      if (part.outputPreview) {
631|        sections.push(
632|          '<div class="tool-section">' +
633|            '<div class="tool-section-label">Output</div>' +
634|            '<pre>' + escapeHtml(part.outputPreview) + '</pre>' +
635|          '</div>'
636|        );
637|      }
638|      const body = sections.length
639|        ? '<div class="collapse-body tool-body">' + sections.join("") + '</div>'
640|        : "";
641|      return (
642|        '<details class="collapse tool' + liveClass + '" data-collapse-id="' + escapeHtml(collapseId) + '"' + openAttr + '>' +
643|          '<summary class="collapse-summary">' +
644|            chevronIcon() +
645|            '<span class="collapse-title">' + escapeHtml(title) + '</span>' +
646|            summaryHtml +
647|            statusBadge(part.status) +
648|          '</summary>' +
649|          body +
650|        '</details>'
651|      );
652|    }
653|    return '<div class="bubble">' + renderMarkdownish(part.text) + '</div>';
654|  }
655|
656|  function renderMessageAttachments(attachments) {
657|    if (!attachments || attachments.length === 0) return "";
658|    const images = [];
659|    const others = [];
660|    attachments.forEach(function (a) {
661|      if (a.kind === "image" && a.previewDataUrl) images.push(a);
662|      else others.push(a);
663|    });
664|    let html = "";
665|    if (images.length) {
666|      html += `<div class="msg-images">${images.map(function (a) {
667|        const alt = escapeHtml(a.label || "image");
668|        const title = escapeHtml(a.fsPath || a.path || a.label || "");
669|        return `<img class="msg-image" src="${a.previewDataUrl}" alt="${alt}" title="${title}" />`;
670|      }).join("")}</div>`;
671|    }
672|    if (others.length) {
673|      html += `<div class="msg-atts">${others.map(function (a) {
674|        const label = escapeHtml(a.label || a.path || a.fsPath || a.kind || "file");
675|        const title = escapeHtml(a.fsPath || a.path || a.label || "");
676|        return `<span class="msg-att ${escapeHtml(a.kind || "file")}" title="${title}">
677|          <span class="att-icon">${kindIcon(a.kind)}</span>
678|          <span class="att-label">${label}</span>
679|        </span>`;
680|      }).join("")}</div>`;
681|    }
682|    return html;
683|  }
684|
685|  function renderMessage(msg) {
686|    const partsHtml = (msg.parts || [])
687|      .map(function (part, idx) {
688|        if (part.kind === "text") {
689|          const cls = msg.streaming && idx === msg.parts.length - 1 ? " streaming" : "";
690|          return `<div class="bubble${cls}">${renderMarkdownish(part.text || (msg.streaming ? "" : ""))}</div>`;
691|        }
692|        return renderPart(part, msg, idx);
693|      })
694|      .join("");
695|
696|    const attachmentsHtml = renderMessageAttachments(msg.attachments);
697|
698|    const fallback =
699|      msg.role === "assistant" && msg.streaming && (!msg.parts || msg.parts.length === 0)
700|        ? `<div class="bubble streaming"></div>`

===== click handlers (1270-1325) =====
1270|  });
1271|
1272|  emptyEl.addEventListener("click", function (e) {
1273|    const btn = e.target.closest(".chip");
1274|    if (btn == null) return;
1275|    inputEl.value = btn.getAttribute("data-prompt") || "";
1276|    autosize();
1277|    inputEl.focus();
1278|  });
1279|
1280|  messagesEl.addEventListener("click", function (e) {
1281|    const fileBtn = e.target.closest("button[data-action='open-file']");
1282|    if (fileBtn && messagesEl.contains(fileBtn)) {
1283|      e.preventDefault();
1284|      e.stopPropagation();
1285|      const filePath = fileBtn.getAttribute("data-path") || "";
1286|      if (filePath) vscode.postMessage({ type: "openFile", path: filePath });
1287|      return;
1288|    }
1289|
1290|    const link = e.target.closest("a[data-href], a[href]");
1291|    if (link && messagesEl.contains(link)) {
1292|      const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
1293|      if (href) {
1294|        e.preventDefault();
1295|        vscode.postMessage({ type: "openExternal", url: href });
1296|        return;
1297|      }
1298|    }
1299|
1300|    const btn = e.target.closest("button[data-action]");
1301|    if (btn == null) return;
1302|    const action = btn.getAttribute("data-action");
1303|    const codeRoot = btn.closest(".md-code");
1304|    const pre = (codeRoot && codeRoot.querySelector(".md-pre")) ||
1305|      (btn.parentElement && btn.parentElement.previousElementSibling);
1306|    const encoded = pre && pre.getAttribute && pre.getAttribute("data-code");
1307|    const text = encoded ? decodeURIComponent(encoded) : "";
1308|    if (action === "copy-code" && text) vscode.postMessage({ type: "copy", text: text });
1309|    if (action === "insert-code" && text) vscode.postMessage({ type: "insert", text: text });
1310|  });
1311|
1312|  attachmentsEl.addEventListener("click", function (e) {
1313|    const btn = e.target.closest("button[data-action='remove-att']");
1314|    if (btn == null) return;
1315|    const id = btn.parentElement && btn.parentElement.getAttribute("data-id");
1316|    if (id) vscode.postMessage({ type: "removeAttachment", id: id });
1317|  });
1318|
1319|  if (suggestListEl) {
1320|    suggestListEl.addEventListener("mousedown", function (e) {
1321|      // Prevent textarea blur before click applies.
1322|      e.preventDefault();
1323|    });
1324|    suggestListEl.addEventListener("click", function (e) {
1325|      const btn = e.target.closest(".suggest-item");

===== chat.css related =====
115|.msg .collapse.tool,
162|.collapse-meta {
173|.collapse-meta .file-link {
193|.collapse-meta .file-link:hover {
197|.tool > .collapse-summary .collapse-meta .file-link {
208|.tool.live > .collapse-summary {
212|.tool > .collapse-summary {
216|.tool > .collapse-summary .collapse-title,
217|.thinking > .collapse-summary .collapse-meta,
218|.tool > .collapse-summary .collapse-meta {
222|.tool > .collapse-summary:hover {
235|.tool-body {
240|.tool-section-label {
248|.tool-body pre {