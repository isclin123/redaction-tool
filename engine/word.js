/* Word（.docx）读取、清理与导出，不经过任何转换服务，直接改 OOXML 副本。
 *
 * 移植自案件管理系统的 word_redaction.py（tests/ 里有逐份对照测试）。依赖 vendor/fflate（zip）
 * 和浏览器自带的 DOMParser / XMLSerializer。不能在原始 XML 上做正则替换：Word 会把一个词拆进多个带样式的片段。
 */
(function (root) {
  "use strict";

  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const XML_NS = "http://www.w3.org/XML/1998/namespace";
  const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const MAX_UPLOAD = 15 * 1024 * 1024;
  const MAX_EXPANDED = 80 * 1024 * 1024;
  const MAX_TEXT = 1000000;
  const STORY = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
  const REMOVED_PART = /^word\/(?:_rels\/)?(comments|people)/;
  const SAFE_FIELD = /^\s*(?:PAGE|NUMPAGES|SECTIONPAGES)(?:\s+\\\*\s+(?:MERGEFORMAT|Arabic))?\s*$/i;
  const SECTION_LABELS = { document: "正文", header: "页眉", footer: "页脚", footnotes: "脚注", endnotes: "尾注" };
  const ELEMENT = 1;
  const TEXT = 3;
  const CDATA = 4;

  function fail(message) {
    throw new Error(message);
  }

  function elements(rootNode) {
    return Array.from(rootNode.getElementsByTagName("*"));
  }

  function remove(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
  }

  function unwrap(node) {
    const parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  }

  function isW(node, ...names) {
    return node && node.nodeType === ELEMENT && node.namespaceURI === W && (!names.length || names.includes(node.localName));
  }

  function textOf(node, types = [TEXT, CDATA]) {
    let value = "";
    for (const child of node.childNodes) if (types.includes(child.nodeType)) value += child.data;
    return value;
  }

  // ---- zip ----

  function readDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new RangeError("no end of central directory");
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    const decoder = new TextDecoder("utf-8");
    const entries = [];
    for (let index = 0; index < count; index += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new RangeError("bad central directory");
      const nameLength = view.getUint16(offset + 28, true);
      entries.push({
        flags: view.getUint16(offset + 8, true),
        size: view.getUint32(offset + 24, true),
        name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      });
      offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    return entries;
  }

  function unzipParts(bytes) {
    let entries;
    let files;
    try {
      entries = readDirectory(bytes);
    } catch (error) {
      fail("无法读取 Word 文档；请确认文件未加密，且为真正的 .docx 文件。");
    }
    if (entries.length > 2000 || entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_EXPANDED) fail("文档解压后过大，请拆分后上传。");
    if (new Set(entries.map((entry) => entry.name)).size !== entries.length) fail("Word 文档包含重复部件，请另存为新文档后再试。");
    for (const entry of entries) {
      if (entry.flags & 1 || entry.name.split("/").includes("..") || entry.name.startsWith("/")) fail("不支持加密或结构异常的 Word 文档。");
    }
    try {
      files = root.fflate.unzipSync(bytes);
    } catch (error) {
      fail("无法读取 Word 文档；请确认文件未加密，且为真正的 .docx 文件。");
    }
    // 按中央目录顺序保存，导出时保持原有部件顺序。
    const parts = new Map();
    for (const entry of entries) {
      if (entry.name.endsWith("/") && !files[entry.name]) continue;
      parts.set(entry.name, files[entry.name] || new Uint8Array());
    }
    return parts;
  }

  // ---- xml ----

  function decodeXml(raw) {
    let encoding = "utf-8";
    if (raw[0] === 0xff && raw[1] === 0xfe) encoding = "utf-16le";
    else if (raw[0] === 0xfe && raw[1] === 0xff) encoding = "utf-16be";
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(raw);
    } catch (error) {
      fail("Word 文档结构损坏，请用 Word 打开后另存为 .docx 再试。");
    }
  }

  function parseXml(raw) {
    const text = decodeXml(raw);
    // Office 文档从来不需要 DTD/实体声明。
    const upper = text.replace(/\0/g, "").toUpperCase();
    if (upper.includes("<!DOCTYPE") || upper.includes("<!ENTITY")) fail("文档包含不支持的 XML 声明，请用 Word 另存为新的 .docx 文件。");
    const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ""), "application/xml");
    if (doc.getElementsByTagName("parsererror").length || !doc.documentElement) fail("Word 文档结构损坏，请用 Word 打开后另存为 .docx 再试。");
    return doc;
  }

  function serializeXml(doc) {
    const text = new XMLSerializer().serializeToString(doc);
    return new TextEncoder().encode(text.startsWith("<?xml") ? text : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${text}`);
  }

  // ---- 路径（posixpath 的等价实现）----

  function dirname(path) {
    const index = path.lastIndexOf("/");
    return index < 0 ? "" : path.slice(0, index);
  }

  function normpath(path) {
    const parts = [];
    for (const segment of path.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push(segment);
    }
    return parts.join("/") || ".";
  }

  function joinpath(base, target) {
    if (!base) return target;
    return base.endsWith("/") ? base + target : `${base}/${target}`;
  }

  // ---- 文档 ----

  class WordDocument {
    /** @param {string} filename  @param {ArrayBuffer|Uint8Array} data */
    constructor(filename, data) {
      if (!/\.docx$/i.test(String(filename))) fail("请选择 .docx 格式的 Word 文档；旧版 .doc 请先在 Word 中另存为 .docx。");
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || new ArrayBuffer(0));
      if (!bytes.length || bytes.length > MAX_UPLOAD) fail("Word 文档为空或超过 15 MB。");
      this.filename = filename;
      this.parts = unzipParts(bytes);
      if (!this.parts.has("word/document.xml") || !this.parts.has("[Content_Types].xml")) fail("这不是有效的 Word .docx 文档。");
      const blocked = ["word/embeddings/", "word/activeX/", "word/charts/", "word/diagrams/"];
      for (const name of this.parts.keys()) {
        if (blocked.some((prefix) => name.startsWith(prefix)) || name.toLowerCase().includes("vbaproject") || name.toLowerCase().includes("afchunk")) {
          fail("文档含嵌入附件、图表、SmartArt 或宏，无法完整检查其中的文字。请先移除这些对象或转成普通文字，再上传。");
        }
      }
      this.xml = new Map();
      for (const [name, raw] of this.parts) if (name.endsWith(".xml") || name.endsWith(".rels")) this.xml.set(name, parseXml(raw));
      if (this.xml.get("word/document.xml").documentElement.namespaceURI !== W) fail("请在 Word 中另存为标准 Word 文档（.docx），再上传。");
      this.warnings = [];
      this.sanitize();
      this.collectText();
    }

    sanitize() {
      const removed = new Set([...this.parts.keys()].filter((name) => /^(docProps|customXml|_xmlsignatures)\//.test(name) || REMOVED_PART.test(name)));
      let hadRevisions = false;
      let hadFields = false;
      const hasImages = [...this.parts.keys()].some((name) => name.startsWith("word/media/"));
      for (const [name, doc] of this.xml) {
        // 页码类自动域保留；其它域压平成当前显示的文字，指令里不能留下原文。
        const safeNodes = new Set();
        const stack = [];
        for (const node of elements(doc)) {
          if (node.namespaceURI !== W) continue;
          if (node.localName === "fldChar" && node.getAttributeNS(W, "fldCharType") === "begin") stack.push({ nodes: [], instruction: "" });
          if (stack.length) {
            const field = stack[stack.length - 1];
            field.nodes.push(node);
            if (node.localName === "instrText") field.instruction += textOf(node, [TEXT]);
            if (node.localName === "fldChar" && node.getAttributeNS(W, "fldCharType") === "end") {
              const finished = stack.pop();
              if (SAFE_FIELD.test(finished.instruction)) finished.nodes.forEach((part) => safeNodes.add(part));
            }
          }
          if (node.localName === "fldSimple" && SAFE_FIELD.test(node.getAttributeNS(W, "instr") || "")) safeNodes.add(node);
        }
        for (const node of elements(doc)) {
          const tag = node.localName;
          if (node.namespaceURI === W) {
            if (["altChunk", "object", "subDoc", "contentPart"].includes(tag)) fail("文档包含尚不能完整读取的嵌入内容，请将其转为普通文字后上传。");
            if (["cellDel", "cellMerge", "cellIns"].includes(tag) || (tag === "del" && ["trPr", "rPr"].includes(node.parentNode && node.parentNode.localName))) {
              fail("文档含表格或段落结构修订，请先在 Word 中接受或拒绝这些修订后再上传。");
            }
            if (["del", "moveFrom", "numberingChange"].includes(tag) || tag.endsWith("PrChange")) {
              hadRevisions = true;
              remove(node);
              continue;
            }
            if (tag === "ins" || tag === "moveTo") {
              hadRevisions = true;
              unwrap(node);
              continue;
            }
            if (["comment", "moveFromRange", "moveToRange", "customXml"].some((prefix) => tag.startsWith(prefix))
              || ["dataBinding", "docVars", "attachedTemplate", "trackRevisions", "alias", "tag"].includes(tag)) {
              remove(node);
              continue;
            }
            if (["instrText", "delInstrText", "delText", "fldChar", "ffData"].includes(tag) && !safeNodes.has(node)) {
              hadFields = true;
              remove(node);
              continue;
            }
            if (tag === "hyperlink" || (tag === "fldSimple" && !safeNodes.has(node))) {
              hadFields = hadFields || tag === "fldSimple";
              unwrap(node);
              continue;
            }
          }
          if (node.namespaceURI === DRAWING && tag === "t") fail("文档含图形内文字，请先转换成普通文字或文本框后再上传。");
          // 去掉隐藏的作者、日期、对象描述和修订编号。
          for (const attr of Array.from(node.attributes)) {
            if (["author", "initials", "date", "descr", "title"].includes(attr.localName) || attr.localName.startsWith("rsid")) node.removeAttributeNode(attr);
          }
          if (tag === "bookmarkStart") node.setAttributeNS(W, "w:name", `Bookmark${node.getAttributeNS(W, "id") || ""}`);
          if ((tag === "docPr" || tag === "cNvPr") && node.hasAttribute("name")) node.setAttribute("name", "Object");
          if (tag === "Relationship") {
            const target = node.getAttribute("Target") || "";
            if (node.getAttribute("TargetMode") === "External") {
              const type = node.getAttribute("Type") || "";
              if (!type.endsWith("/hyperlink") && !type.endsWith("/attachedTemplate")) fail("文档引用了外部图片或外部内容，请先在 Word 中将其嵌入或移除后再上传。");
              remove(node);
              continue;
            }
            const base = name !== "_rels/.rels" ? dirname(name.replaceAll("/_rels/", "/").replace(/\.rels$/, "")) : "";
            const resolved = target.startsWith("/") ? target.replace(/^\/+/, "") : normpath(joinpath(base, target));
            if (removed.has(resolved)) remove(node);
          }
          if (name === "[Content_Types].xml" && removed.has((node.getAttribute("PartName") || "").replace(/^\/+/, ""))) remove(node);
        }
      }
      for (const name of removed) {
        this.parts.delete(name);
        this.xml.delete(name);
      }
      // 每个带文字的部件都必须出现在预览里，不能悄悄原样带出去。
      for (const [name, doc] of this.xml) {
        if (!STORY.test(name) && doc.getElementsByTagNameNS(W, "t").length) fail("文档包含正文以外的特殊文字部件，请用 Word 另存为普通文档后再试。");
      }
      if (hasImages) this.warnings.push("图片会保留，图片里的文字、印章和签名需另行检查；本次仅处理可编辑文字。");
      if (hadRevisions) this.warnings.push("导出将接受现有修订，删除修订历史，仅保留当前版本。");
      if (hadFields) this.warnings.push("除页码外的域将按当前显示内容保留为普通文字，不再自动更新。");
    }

    collectText() {
      this.spans = [];
      this.boundaries = [];
      this.sections = [];
      const chunks = [];
      let offset = 0;
      const append = (text, node = null) => {
        if (!text) return;
        if (node) this.spans.push({ start: offset, end: offset + text.length, node, text });
        chunks.push(text);
        offset += text.length;
      };
      const walk = (node) => {
        if (node.nodeType !== ELEMENT) return;
        const tag = node.namespaceURI === W ? node.localName : "";
        if (tag === "t") {
          append(textOf(node), node);
          return;
        }
        if (tag === "tab" || tag === "br" || tag === "cr") {
          append(tag === "tab" ? "\t" : "\n", node);
          return;
        }
        for (const child of Array.from(node.childNodes)) walk(child);
        if (tag === "p") {
          const cell = node.parentNode;
          if (isW(cell, "tc")) {
            const siblings = Array.from(cell.childNodes);
            const remaining = siblings.slice(siblings.indexOf(node) + 1);
            const cells = Array.from(cell.parentNode.childNodes).filter((child) => isW(child, "tc"));
            // 相邻的「标签格/内容格」之间用制表符相连，字段规则仍能看出它们的关系。
            if (!remaining.some((child) => child.nodeType === ELEMENT) && cells[cells.length - 1] !== cell) {
              this.boundaries.push(offset);
              append("\t");
              return;
            }
          }
          append("\n");
        }
      };
      const ordered = ["word/document.xml", ...[...this.xml.keys()].filter((name) => STORY.test(name) && name !== "word/document.xml").sort()];
      for (const name of ordered) {
        const start = offset;
        walk(this.xml.get(name).documentElement);
        const key = name.split("/").pop().split(".")[0].replace(/\d/g, "");
        this.sections.push({ name: SECTION_LABELS[key] || key, start, end: offset });
      }
      this.text = chunks.join("");
      if (!this.text.trim()) fail("没有找到可编辑文字。如果文档只有扫描图片，请先在 Word 中转换成可编辑文字。");
      if (this.text.length > MAX_TEXT) fail("文档文字超过 100 万字，请拆分后上传。");
    }

    info() {
      return { text: this.text, characters: Array.from(this.text).length, warnings: this.warnings.slice(), sections: this.sections.slice() };
    }

    /** 按确认后的识别项生成脱敏 Word（Uint8Array）。同一个 WordDocument 只能导出一次，再导出请重新读取。 */
    export(matches) {
      validateMatches(this.text, matches);
      const enabled = matches.filter((item) => item.enabled !== false).sort((a, b) => a.start - b.start);
      let pointer = 0;
      for (const span of this.spans) {
        let { node } = span;
        const { start, end, text: original } = span;
        while (pointer < enabled.length && enabled[pointer].end <= start) pointer += 1;
        let cursor = start;
        let value = "";
        for (let index = pointer; index < enabled.length && enabled[index].start < end; index += 1) {
          const item = enabled[index];
          const left = Math.max(start, item.start);
          value += original.slice(cursor - start, left - start);
          if (start <= item.start && item.start < end) value += item.mask;
          cursor = Math.min(end, item.end);
        }
        value += original.slice(cursor - start);
        if (node.localName !== "t") {
          if (value === original) continue;
          if (!value) {
            remove(node);
            continue;
          }
          const replacement = node.ownerDocument.createElementNS(W, "w:t");
          node.parentNode.replaceChild(replacement, node);
          node = replacement;
        }
        while (node.firstChild) node.removeChild(node.firstChild);
        node.appendChild(node.ownerDocument.createTextNode(value));
        node.setAttributeNS(XML_NS, "xml:space", "preserve");
      }
      const files = {};
      for (const [name, raw] of this.parts) files[name] = this.xml.has(name) ? serializeXml(this.xml.get(name)) : raw;
      return root.fflate.zipSync(files, { level: 6 });
    }
  }

  function validateMatches(text, matches) {
    if (!Array.isArray(matches) || matches.some((item) => !item || !Number.isInteger(item.start) || !Number.isInteger(item.end))) {
      fail("脱敏识别项无效，请重新预览。");
    }
    let cursor = 0;
    for (const item of matches.slice().sort((a, b) => a.start - b.start)) {
      if (item.start < cursor || item.end <= item.start || item.end > text.length) fail("脱敏识别项位置无效，请重新预览。");
      if (item.value !== text.slice(item.start, item.end) || typeof item.mask !== "string" || (item.enabled !== undefined && typeof item.enabled !== "boolean")) {
        fail("脱敏识别项已变化，请重新预览。");
      }
      cursor = item.end;
    }
  }

  // ---- 粘贴文字导出为 Word（与案件管理系统 build_docx 的版式一致，但不开启修订跟踪）----

  function escapeXml(value) {
    return value.replace(/[^\t\n\r -￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function textToDocx(text) {
    const paragraphs = text.split("\n").map((line) => `<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>${line ? `<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>` : ""}</w:p>`);
    const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const files = {
      "[Content_Types].xml": `${header}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${DOCX_TYPE}.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      "_rels/.rels": `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      "word/document.xml": `${header}<w:document xmlns:w="${W}"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>`,
      "word/_rels/document.xml.rels": `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      "word/styles.xml": `${header}<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Body"><w:name w:val="Body"/><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="SimSun" w:eastAsia="SimSun" w:hAnsi="SimSun"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style></w:styles>`,
    };
    const encoder = new TextEncoder();
    return root.fflate.zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, encoder.encode(value)])), { level: 6 });
  }

  root.RedactionWord = { WordDocument, validateMatches, textToDocx, DOCX_TYPE, MAX_UPLOAD };
})(typeof window !== "undefined" ? window : globalThis);
