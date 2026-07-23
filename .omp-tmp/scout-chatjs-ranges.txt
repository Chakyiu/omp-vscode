=== media/chat.js 361-521 ===
   361	  function toolTitle(name, inputPreview) {
   362	    const key = normalizeToolKey(name);
   363	    const identity = parseToolIdentity(name);
   364	    const actionKey = identity.action || identity.leaf || key;
   365	
   366	    if (key === "bash" || key === "shell" || actionKey === "bash" || actionKey === "shell") {
   367	      const obj = parseToolInput(inputPreview);
   368	      const cmd = obj && (obj.command || obj.cmd);
   369	      if (typeof cmd === "string") {
   370	        if (/^\s*ls\b/.test(cmd)) return "Listed directory";
   371	        if (/^\s*find\b/.test(cmd)) return "Found files";
   372	        if (/^\s*cat\b/.test(cmd)) return "Read";
   373	        if (/^\s*rg\b|^\s*grep\b/.test(cmd)) return "Grep";
   374	      }
   375	      return "Ran command";
   376	    }
   377	
   378	    const map = {
   379	      read: "Read",
   380	      read_file: "Read",
   381	      get_file: "Read",
   382	      grep: "Grep",
   383	      glob: "Searched files",
   384	      write: "Wrote",
   385	      write_file: "Wrote",
   386	      edit: "Edited",
   387	      strreplace: "Edited",
   388	      search_replace: "Edited",
   389	      delete: "Deleted",
   390	      delete_file: "Deleted",
   391	      web_search: "Searched web",
   392	      webfetch: "Fetched",
   393	      fetch: "Fetched",
   394	      todo: "Updated todos",
   395	      todowrite: "Updated todos",
   396	      navigate: "Navigate",
   397	      browser_navigate: "Navigate",
   398	      browser_click: "Click",
   399	      click: "Click",
   400	      browser_fill: "Fill",
   401	      fill: "Fill",
   402	      browser_type: "Type",
   403	      type: "Type",
   404	      browser_snapshot: "Snapshot",
   405	      snapshot: "Snapshot",
   406	      browser_screenshot: "Screenshot",
   407	      screenshot: "Screenshot",
   408	      browser_scroll: "Scroll",
   409	      scroll: "Scroll",
   410	      browser_wait_for: "Wait",
   411	      wait_for: "Wait",
   412	      browser_wait_for_text: "Wait for text",
   413	      wait_for_text: "Wait for text",
   414	      browser_tabs: "Browser tabs",
   415	      browser_tab_new: "New tab",
   416	      browser_tab_close: "Close tab",
   417	      browser_reload: "Reload",
   418	      browser_back: "Back",
   419	      browser_forward: "Forward",
   420	      get_artifact: "Get artifact",
   421	      get_project: "Get project",
   422	      list_files: "List files",
   423	      list_projects: "List projects",
   424	      search_files: "Search files",
   425	      create_artifact: "Create artifact",
   426	      create_project: "Create project",
   427	      start_run: "Start run",
   428	      get_run: "Get run",
   429	      compress: "Compress",
   430	      headroom_compress: "Compress",
   431	      retrieve: "Retrieve",
   432	      headroom_retrieve: "Retrieve",
   433	    };
   434	
   435	    if (map[key]) return map[key];
   436	    if (map[identity.leaf]) return map[identity.leaf];
   437	    if (map[actionKey]) return map[actionKey];
   438	
   439	    const pretty = humanizeWords(actionKey);
   440	    if (identity.group && pretty) {
   441	      // Keep the title short: action only. Group is implied by wording.
   442	      return pretty;
   443	    }
   444	    return pretty || "Tool";
   445	  }
   446	
   447	  function parseToolInput(preview) {
   448	    if (!preview) return null;
   449	    const text = String(preview).trim();
   450	    if (!text) return null;
   451	    try {
   452	      const obj = JSON.parse(text);
   453	      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
   454	    } catch (_) {
   455	      // fall through
   456	    }
   457	    return null;
   458	  }
   459	
   460	  function isFilePathTool(name) {
   461	    const key = normalizeToolKey(name);
   462	    const identity = parseToolIdentity(name);
   463	    const actionKey = identity.action || identity.leaf || key;
   464	    return (
   465	      /^(read|write|edit|delete|get_file|write_file|delete_file|strreplace|search_replace|create_artifact)$/.test(actionKey) ||
   466	      /^(read|write|edit|delete|strreplace|search_replace)$/.test(key)
   467	    );
   468	  }
   469	
   470	  function unescapeJsonString(value) {
   471	    try {
   472	      return JSON.parse('"' + value + '"');
   473	    } catch (_) {
   474	      return String(value || "");
   475	    }
   476	  }
   477	
   478	  function extractToolFilePath(name, inputPreview) {
   479	    if (!isFilePathTool(name)) return "";
   480	    const obj = parseToolInput(inputPreview);
   481	    if (obj) {
   482	      const keys = ["path", "file", "target_notebook", "target", "entry", "name"];
   483	      for (let i = 0; i < keys.length; i += 1) {
   484	        const value = obj[keys[i]];
   485	        if (typeof value === "string" && value.trim()) return value.trim();
   486	      }
   487	    }
   488	    // Recover path from truncated JSON previews (common for write/edit payloads).
   489	    const text = String(inputPreview || "");
   490	    const match = text.match(/"(?:path|file|target_notebook|target|entry)"\s*:\s*"((?:\\.|[^"\\])*)"/);
   491	    if (match && match[1]) return unescapeJsonString(match[1]).trim();
   492	    const nameMatch = text.match(/"name"\s*:\s*"((?:\\.|[^"\\])*(?:\/|\\)(?:\\.|[^"\\])*)"/);
   493	    if (nameMatch && nameMatch[1]) return unescapeJsonString(nameMatch[1]).trim();
   494	    return "";
   495	  }
   496	
   497	  function formatToolFilePath(pathValue) {
   498	    let value = String(pathValue || "").trim();
   499	    if (!value) return "";
   500	    if (value.indexOf("file://") === 0) {
   501	      value = value.slice("file://".length);
   502	      if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
   503	    }
   504	    const display = value.replace(/\\/g, "/");
   505	    const parts = display.split("/").filter(Boolean);
   506	    if (parts.length <= 3) return parts.join("/") || display;
   507	    return "…/" + parts.slice(-3).join("/");
   508	  }
   509	
   510	  function renderFileLink(pathValue) {
   511	    const full = String(pathValue || "").trim();
   512	    if (!full) return "";
   513	    const display = formatToolFilePath(full);
   514	    return (
   515	      '<button type="button" class="file-link" data-action="open-file" data-path="' +
   516	        escapeHtml(full) +
   517	        '" title="Open ' + escapeHtml(full) + '">' +
   518	        escapeHtml(display) +
   519	      "</button>"
   520	    );
   521	  }

=== media/chat.js 610-651 ===
   610	    if (part.kind === "tool") {
   611	      const running = part.status === "running";
   612	      const collapseId = "tool:" + String(part.id || part.name || "tool");
   613	      const openAttr = collapseOpenAttr(collapseId, running);
   614	      const liveClass = running ? " live" : "";
   615	      const title = toolTitle(part.name, part.inputPreview);
   616	      const filePath = extractToolFilePath(part.name, part.inputPreview);
   617	      const summary = filePath ? "" : toolSummary(part.name, part.inputPreview);
   618	      const summaryHtml = filePath
   619	        ? '<span class="collapse-meta">' + renderFileLink(filePath) + '</span>'
   620	        : (summary ? '<span class="collapse-meta">' + escapeHtml(summary) + '</span>' : "");
   621	      const sections = [];
   622	      if (part.inputPreview) {
   623	        sections.push(
   624	          '<div class="tool-section">' +
   625	            '<div class="tool-section-label">Input</div>' +
   626	            '<pre>' + escapeHtml(part.inputPreview) + '</pre>' +
   627	          '</div>'
   628	        );
   629	      }
   630	      if (part.outputPreview) {
   631	        sections.push(
   632	          '<div class="tool-section">' +
   633	            '<div class="tool-section-label">Output</div>' +
   634	            '<pre>' + escapeHtml(part.outputPreview) + '</pre>' +
   635	          '</div>'
   636	        );
   637	      }
   638	      const body = sections.length
   639	        ? '<div class="collapse-body tool-body">' + sections.join("") + '</div>'
   640	        : "";
   641	      return (
   642	        '<details class="collapse tool' + liveClass + '" data-collapse-id="' + escapeHtml(collapseId) + '"' + openAttr + '>' +
   643	          '<summary class="collapse-summary">' +
   644	            chevronIcon() +
   645	            '<span class="collapse-title">' + escapeHtml(title) + '</span>' +
   646	            summaryHtml +
   647	            statusBadge(part.status) +
   648	          '</summary>' +
   649	          body +
   650	        '</details>'
   651	      );

=== media/chat.js 1275-1290 ===
  1275	    inputEl.value = btn.getAttribute("data-prompt") || "";
  1276	    autosize();
  1277	    inputEl.focus();
  1278	  });
  1279	
  1280	  messagesEl.addEventListener("click", function (e) {
  1281	    const fileBtn = e.target.closest("button[data-action='open-file']");
  1282	    if (fileBtn && messagesEl.contains(fileBtn)) {
  1283	      e.preventDefault();
  1284	      e.stopPropagation();
  1285	      const filePath = fileBtn.getAttribute("data-path") || "";
  1286	      if (filePath) vscode.postMessage({ type: "openFile", path: filePath });
  1287	      return;
  1288	    }
  1289	
  1290	    const link = e.target.closest("a[data-href], a[href]");
