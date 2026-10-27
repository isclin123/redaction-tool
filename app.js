/* 文件脱敏：界面逻辑。识别和导出都在本机完成（engine/），不保存任何文件；只有敏感词库存在本机（store.js）。 */
(function () {
  "use strict";

  const { buildPreview, applyRedactions, parseCustomTerms } = window.RedactionRules;
  const { WordDocument, textToDocx, DOCX_TYPE, MAX_UPLOAD } = window.RedactionWord;
  const Store = window.RedactionStore;
  const PAGE_SIZE = 50;

  const $ = (selector) => document.querySelector(selector);
  const els = {
    nav: $("#moduleNav"),
    file: $("#redactionFile"),
    documentInfo: $("#documentInfo"),
    customTerms: $("#customTerms"),
    libraryHint: $("#libraryHint"),
    sourceText: $("#sourceText"),
    previewButton: $("#previewButton"),
    exportButton: $("#exportButton"),
    workStatus: $("#workStatus"),
    matchList: $("#matchList"),
    reviewList: $("#reviewList"),
    copyButton: $("#copyResultButton"),
    resultNotice: $("#resultNotice"),
    redactedText: $("#redactedText"),
    termForm: $("#termForm"),
    newTerms: $("#newTerms"),
    termStatus: $("#termStatus"),
    termList: $("#termList"),
    updateBanner: $("#updateBanner"),
    unsupportedBanner: $("#unsupportedBanner"),
  };

  const state = {
    source: null, // Word：{ filename, bytes, word }；粘贴文字时为 null
    sourceText: "",
    preview: null,
    page: 1,
    terms: [],
    revision: 0,
    waitingWorker: null,
    updating: false,
  };

  // ---------------------------------------------------------------- 工具

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
  }

  // 让「识别中…」先显示出来再做耗时的识别；不用 requestAnimationFrame，页面在后台时它不会触发。
  function nextFrame() {
    return new Promise((resolve) => setTimeout(resolve, 16));
  }

  function setStatus(node, text, isError = false) {
    node.textContent = text;
    node.classList.toggle("error", isError);
  }

  function setNotice(tone, text) {
    els.resultNotice.className = `result-notice ${tone}`.trim();
    els.resultNotice.textContent = text;
  }

  function showToast(message) {
    let toast = $("#globalToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "globalToast";
      toast.className = "global-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.append(toast);
    }
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 1500);
  }

  // ---------------------------------------------------------------- 页面切换

  function showView(view) {
    for (const module of document.querySelectorAll("[data-module]")) module.classList.toggle("hidden", module.dataset.module !== view);
    for (const button of els.nav.querySelectorAll("[data-view]")) {
      const active = button.dataset.view === view;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (view === "terms") renderTerms();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- 原文

  function updateFileHint() {
    const hint = els.file.closest("[data-file-upload-control]").querySelector("[data-file-upload-name]");
    const name = state.source ? state.source.filename : "";
    hint.textContent = name || hint.dataset.emptyLabel;
    hint.classList.toggle("has-file", Boolean(name));
  }

  function invalidate(message = "请预览并确认需要脱敏的内容。") {
    state.revision += 1;
    state.preview = null;
    els.exportButton.disabled = true;
    els.copyButton.disabled = true;
    els.matchList.innerHTML = `<p class="empty">${escapeHtml(message)}</p>`;
    els.reviewList.innerHTML = "";
    els.redactedText.value = "";
    setNotice("", "请重新预览后再导出 Word。");
  }

  function loadDocument(filename, bytes) {
    const word = new WordDocument(filename, bytes);
    state.source = { filename, bytes, word };
    els.sourceText.value = word.text;
    els.sourceText.readOnly = true;
    const info = word.info();
    els.documentInfo.hidden = false;
    els.documentInfo.innerHTML = `
      <p class="meta-line">已导入 ${escapeHtml(filename)} · ${info.characters.toLocaleString("zh-CN")} 字。下方原文仅供校对。</p>
      <button type="button" id="clearDocumentButton" class="ghost">移除文档</button>
      ${info.warnings.map((message) => `<p class="status">${escapeHtml(message)}</p>`).join("")}`;
    updateFileHint();
  }

  function clearSource() {
    state.source = null;
    els.file.value = "";
    els.sourceText.readOnly = false;
    els.sourceText.value = "";
    els.documentInfo.hidden = true;
    els.documentInfo.innerHTML = "";
    updateFileHint();
  }

  async function importFile() {
    const file = els.file.files && els.file.files[0];
    if (!file) return;
    invalidate();
    const revision = state.revision;
    setStatus(els.workStatus, `正在读取 ${file.name}…`);
    try {
      if (/\.doc$/i.test(file.name)) throw new Error("这是旧版 .doc 文件。请先在 Word 或 WPS 中「另存为」.docx，再导入。");
      if (!/\.docx$/i.test(file.name)) throw new Error("请选择 .docx 格式的 Word 文档。");
      if (file.size > MAX_UPLOAD) throw new Error("Word 文档不能超过 15 MB。");
      const bytes = await file.arrayBuffer();
      if (revision !== state.revision) return;
      loadDocument(file.name, bytes);
      setStatus(els.workStatus, "Word 已导入。可补充敏感词，再点击「预览脱敏」。");
    } catch (error) {
      if (revision !== state.revision) return;
      clearSource();
      setStatus(els.workStatus, error.message, true);
    }
  }

  // ---------------------------------------------------------------- 预览与确认

  function allTerms() {
    return parseCustomTerms([...parseCustomTerms(els.customTerms.value), ...state.terms]);
  }

  async function runPreview() {
    invalidate();
    const revision = state.revision;
    const text = state.source ? state.source.word.text : els.sourceText.value;
    setStatus(els.workStatus, "识别中…");
    setNotice("is-working", "正在识别敏感信息…");
    await nextFrame();
    if (revision !== state.revision) return;
    try {
      const preview = buildPreview(text, { customTerms: allTerms(), document: state.source ? state.source.word : null });
      state.sourceText = text;
      state.preview = preview;
      state.page = 1;
      renderPreview();
      setStatus(els.workStatus, `识别到 ${preview.matches.length} 处敏感信息。`);
    } catch (error) {
      setStatus(els.workStatus, error.message, true);
      setNotice("is-error", error.message);
    }
  }

  function renderPreview() {
    const { matches } = state.preview;
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const first = (state.page - 1) * PAGE_SIZE;
    const items = matches.slice(first, first + PAGE_SIZE);
    els.matchList.innerHTML = matches.length ? `
      <table class="table responsive-table redaction-table">
        <thead><tr><th>脱敏</th><th>类型</th><th>原文</th><th>替换为</th></tr></thead>
        <tbody>
          ${items.map((item) => `
            <tr>
              <td data-label="脱敏"><label class="check-row"><input type="checkbox" data-toggle="${escapeHtml(item.id)}" ${item.enabled ? "checked" : ""} aria-label="脱敏：${escapeHtml(item.type)} ${escapeHtml(item.value)}" /></label></td>
              <td data-label="类型">${escapeHtml(item.type)}${item.location ? `<span class="meta-line">${escapeHtml(item.location)}</span>` : ""}</td>
              <td data-label="原文">${escapeHtml(item.value)}</td>
              <td data-label="替换为"><span>${escapeHtml(item.mask)}</span></td>
            </tr>`).join("")}
        </tbody>
      </table>
      ${pages > 1 ? `
        <div class="pagination client-pagination">
          <span class="meta-line">第 ${state.page} / ${pages} 页 · ${first + 1}-${first + items.length} / ${matches.length} 处</span>
          <div class="inline-actions">
            <button type="button" class="ghost" data-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""}>上一页</button>
            <button type="button" class="ghost" data-page="${state.page + 1}" ${state.page >= pages ? "disabled" : ""}>下一页</button>
          </div>
        </div>` : ""}`
      : `<div class="empty-state"><strong>未识别到内置敏感信息</strong><p>如有需要保护的名称或编号，请填入「本次自定义敏感词」后重新预览。</p></div>`;
    const { warnings, reviewChecklist } = state.preview;
    els.reviewList.innerHTML = `
      ${warnings.length ? `<article class="rule-check"><span class="badge amber">风险</span><strong>脱敏复核提示</strong><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></article>` : ""}
      <article class="rule-check"><span class="badge">清单</span><strong>导出前检查</strong><ul>${reviewChecklist.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></article>`;
    updateRedactedText();
    els.exportButton.disabled = false;
    els.copyButton.disabled = false;
    setNotice("is-ready", `脱敏预览已生成：${matches.length} 处敏感信息，可检查后导出。`);
  }

  function updateRedactedText() {
    els.redactedText.value = applyRedactions(state.sourceText, state.preview.matches);
  }

  // ---------------------------------------------------------------- 导出与记录

  function exportBytes() {
    const { matches } = state.preview;
    if (!state.source) return { bytes: textToDocx(applyRedactions(state.sourceText, matches)), filename: `脱敏文档_${new Date().toISOString().slice(0, 10)}.docx` };
    // 每次导出都从原文件重新读取一份，导出不会改动原文件。
    const word = new WordDocument(state.source.filename, state.source.bytes);
    if (word.text !== state.sourceText) throw new Error("文档已变化，请重新预览。");
    return { bytes: word.export(matches), filename: state.source.filename.replace(/\.docx$/i, "_脱敏.docx") };
  }

  /** 手机/平板用系统分享（可存到「文件」或发到微信），电脑直接下载。 */
  async function deliver(bytes, filename) {
    const blob = new Blob([bytes], { type: DOCX_TYPE });
    const file = typeof File === "function" ? new File([blob], filename, { type: DOCX_TYPE }) : null;
    const touch = window.matchMedia("(pointer: coarse)").matches;
    if (touch && file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return true;
      } catch (error) {
        if (error && error.name === "AbortError") return false;
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }

  async function exportWord() {
    if (!state.preview) return;
    let output;
    try {
      output = exportBytes(); // 同步完成，保证手机上的分享仍算用户点击触发
    } catch (error) {
      setStatus(els.workStatus, error.message, true);
      return;
    }
    const delivered = await deliver(output.bytes, output.filename);
    setStatus(els.workStatus, delivered ? `已导出 ${output.filename}。` : "已取消导出。");
  }

  // ---------------------------------------------------------------- 敏感词库

  function renderTermHint() {
    els.libraryHint.textContent = state.terms.length ? `敏感词库的 ${state.terms.length} 个词也会自动识别。` : "敏感词库还没有词。";
  }

  function renderTerms() {
    renderTermHint();
    els.termList.innerHTML = state.terms.length
      ? `<p class="meta-line">共 ${state.terms.length} 个词</p><ul class="term-list">${state.terms.map((term) => `
          <li><span>${escapeHtml(term)}</span><button type="button" class="icon-button" data-term-delete="${escapeHtml(term)}" data-icon="x" aria-label="从词库删除：${escapeHtml(term)}" title="删除"></button></li>`).join("")}</ul>`
      : `<div class="empty-state"><strong>词库还是空的</strong><p>在上方添加常用的当事人姓名、公司简称等，以后每次脱敏都会自动识别。</p></div>`;
  }

  async function saveTerms(terms) {
    state.terms = terms;
    await Store.saveTerms(terms);
    renderTermHint();
    if (state.preview) invalidate("敏感词库有变化，请重新预览。");
  }

  async function addTerms(value, statusNode) {
    const added = parseCustomTerms(value).filter((term) => !state.terms.includes(term));
    if (!added.length) {
      setStatus(statusNode, parseCustomTerms(value).length ? "这些词已经在词库里了。" : "请先填写要加入词库的词。", !parseCustomTerms(value).length);
      return false;
    }
    try {
      await saveTerms([...state.terms, ...added]);
    } catch (error) {
      setStatus(statusNode, `没能保存词库：${error.message || error}`, true);
      return false;
    }
    setStatus(statusNode, `已加入词库：${added.join("、")}`);
    return true;
  }

  // ---------------------------------------------------------------- 安装与更新

  function registerServiceWorker() {
    const version = document.querySelector('meta[name="app-version"]').content;
    if (version === "dev" || !("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register("sw.js").then((registration) => {
      const offer = (worker) => {
        if (!worker || !navigator.serviceWorker.controller) return;
        state.waitingWorker = worker;
        els.updateBanner.hidden = false;
      };
      offer(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (worker) worker.addEventListener("statechange", () => worker.state === "installed" && offer(worker));
      });
      registration.update().catch(() => {});
    }).catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (state.updating) location.reload();
    });
  }

  function unsupportedReason() {
    try {
      new RegExp("(?<![a])b", "d");
      if (!String.prototype.matchAll || !window.DOMParser || !window.TextDecoder || !window.Blob) throw new Error("missing");
      return "";
    } catch (error) {
      return "这台设备的系统或浏览器版本太旧，无法运行文件脱敏。iPhone、iPad 请升级到 iOS 16.4 或更新版本；电脑请使用最新版 Edge、Chrome 或 Safari。";
    }
  }

  // ---------------------------------------------------------------- 事件

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.view) showView(target.dataset.view);
    else if (target.id === "previewButton") runPreview();
    else if (target.id === "exportButton") exportWord();
    else if (target.id === "clearDocumentButton") {
      clearSource();
      invalidate();
      setStatus(els.workStatus, "可重新选择 Word 文档，或粘贴文字。");
    } else if (target.id === "copyResultButton") {
      try {
        await navigator.clipboard.writeText(els.redactedText.value);
        showToast("已复制脱敏文字");
      } catch (error) {
        els.redactedText.select();
        showToast("请长按或按 ⌘C / Ctrl+C 复制");
      }
    } else if (target.id === "saveTermsButton") addTerms(els.customTerms.value, els.workStatus);
    else if (target.dataset.page) {
      state.page = Number(target.dataset.page);
      renderPreview();
      els.matchList.scrollIntoView({ block: "nearest" });
    } else if (target.dataset.termDelete) {
      await saveTerms(state.terms.filter((term) => term !== target.dataset.termDelete));
      renderTerms();
    } else if (target.id === "applyUpdateButton" && state.waitingWorker) {
      state.updating = true;
      state.waitingWorker.postMessage({ type: "skip-waiting" });
    }
  });

  els.matchList.addEventListener("change", (event) => {
    const id = event.target.dataset.toggle;
    const item = id && state.preview && state.preview.matches.find((match) => match.id === id);
    if (!item) return;
    item.enabled = event.target.checked;
    updateRedactedText();
  });

  els.file.addEventListener("change", importFile);
  els.sourceText.addEventListener("input", () => {
    if (state.preview) invalidate();
  });
  els.sourceText.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) runPreview();
  });
  els.customTerms.addEventListener("keydown", (event) => {
    if (event.key === "Enter") runPreview();
  });
  els.termForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (await addTerms(els.newTerms.value, els.termStatus)) {
      els.newTerms.value = "";
      renderTerms();
    }
  });

  // ---------------------------------------------------------------- 启动

  const reason = unsupportedReason();
  if (reason) {
    els.unsupportedBanner.textContent = reason;
    els.unsupportedBanner.hidden = false;
    els.previewButton.disabled = true;
    els.file.disabled = true;
  }
  Store.getTerms().then((terms) => {
    state.terms = terms;
    renderTermHint();
  }).catch(() => {});
  registerServiceWorker();
})();
