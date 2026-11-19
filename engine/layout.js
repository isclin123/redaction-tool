/* PDF 文字层和图片文字识别的结果 → 段落 → 可脱敏的全文和新的 Word。
 *
 * PDF 和图片没有 Word 那样的段落，只有一块块带位置的文字。这里按位置拼成行，再按缩进、行尾是否到边、行距
 * 拼成段落，得到和 Word 一样的「全文 + 位置」，识别规则（rules.js）不用改。导出时按段落写一份新的 Word：
 * 只有文字，原文件的图片、印章、签名和版式都不带出去。
 * 纯计算，不碰页面，Node 里也能测（tests/layout_regression.mjs）。
 */
(function (root) {
  "use strict";

  const LATIN_END = /[A-Za-z0-9%)\]'",.;:!?-]$/;
  const LATIN_START = /^[A-Za-z0-9([@#'"]/;
  const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff60]/;
  const CJK_ALL = /[\u2e80-\u9fff\uf900-\ufaff]/g;
  // 行尾是这些标点，说明一句话写完了，下一行另起。
  const CLAUSE_END = /[。；：！？;:!?）)」』】]$/;
  // 「电话：」「法定代表人：」这类标签开头的行另起一段。
  const LABEL_START = /^[\u4e00-\u9fa5]{1,8}[（(]?[\u4e00-\u9fa5]{0,4}[)）]?[：:]/;
  const LIST_MARKER = /^(?:第[一二三四五六七八九十百零〇\d]+[条章节款项部分]|[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十\d]{1,3}[)）]|\d{1,2}[、．](?!\d)|\d{1,2}\.(?!\d)|[①-⑳⑴-⒇])/;
  const PAGE_NUMBER = /^(?:[-—–_·•\s]*\d{1,4}[-—–_·•\s]*|第\s*\d+\s*页(?:\s*[，,/]?\s*共\s*\d+\s*页)?|共\s*\d+\s*页\s*[，,]?\s*第\s*\d+\s*页|\d+\s*\/\s*\d+|page\s*\d+(?:\s*of\s*\d+)?)$/i;
  // 识别结果里夹在汉字中间的半角标点换成全角，导出的 Word 读起来才像原文。
  const HALF_TO_FULL = { ",": "，", ":": "：", ";": "；", "(": "（", ")": "）", "!": "！", "?": "？" };

  function fail(message) {
    throw new Error(message);
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function quantile(values, q) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
  }

  /** 去掉控制字符和零宽字符；康熙部首、兼容汉字（有些 PDF 用「⼈」代替「人」）换成普通汉字，否则规则认不出。 */
  function cleanText(text, { ocr = false } = {}) {
    let value = String(text || "")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, "")
      .replace(/[\u00a0\u2000-\u200a\u202f\u205f]/g, " ")
      .replace(/[\u2e80-\u2fdf\uf900-\ufaff]/g, (char) => char.normalize("NFKC"))
      .replace(/\t/g, " ")
      // 两端对齐的中文，PDF 里字与字之间会读出空格。
      .replace(/([\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff60]) {1,2}(?=[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff60])/g, "$1");
    if (ocr) {
      value = value.replace(/[,:;()!?]/g, (char, index, whole) => {
        const before = whole[index - 1] || "";
        const after = whole[index + 1] || "";
        return CJK.test(before) || CJK.test(after) ? HALF_TO_FULL[char] : char;
      });
    }
    return value;
  }

  /** 两段文字之间要不要空格：中文为主的文字里换行处从不加（号码、日期被折到下一行时要接回去），英文单词之间加。 */
  function joiner(left, right) {
    if (!LATIN_END.test(left) || !LATIN_START.test(right)) return "";
    const sample = left.slice(-40) + right.slice(0, 40);
    const cjk = (sample.match(CJK_ALL) || []).length;
    if (cjk * 4 >= sample.replace(/\s/g, "").length) return "";
    return /[A-Za-z,.;:!?)]$/.test(left) || /^[A-Za-z(]/.test(right) ? " " : "";
  }

  /**
   * 一页的文字块 → 行（从上到下）。
   * @param {{x0:number,x1:number,cy:number,h:number,text:string}[]} fragments  坐标以页面左上角为原点，cy 是文字竖直中线，h 是字高
   */
  function buildLines(fragments, { height = 0, ocr = false } = {}) {
    const items = [];
    const seen = new Map();
    for (const raw of fragments || []) {
      const text = cleanText(raw.text, { ocr }).trim();
      const h = Math.max(1, Number(raw.h) || 0);
      if (!text || !(raw.x1 >= raw.x0) || !Number.isFinite(raw.cy)) continue;
      // 伪粗体：同样的字在几乎同一位置画两遍，只留一份。
      const twins = seen.get(text) || [];
      if (twins.some((other) => Math.abs(other.x0 - raw.x0) < 0.4 * h && Math.abs(other.cy - raw.cy) < 0.4 * h)) continue;
      const item = { x0: raw.x0, x1: raw.x1, cy: raw.cy, h, text };
      twins.push(item);
      seen.set(text, twins);
      items.push(item);
    }

    // 1. 拼行：竖直方向重叠一半以上、横向不打架的块算同一行。
    items.sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
    const rows = [];
    for (const item of items) {
      let target = null;
      for (let index = rows.length - 1; index >= 0 && index >= rows.length - 6; index -= 1) {
        const row = rows[index];
        const overlap = Math.min(row.cy + row.h / 2, item.cy + item.h / 2) - Math.max(row.cy - row.h / 2, item.cy - item.h / 2);
        if (overlap < 0.5 * Math.min(row.h, item.h)) continue;
        const clash = row.items.some((other) => {
          const shared = Math.min(other.x1, item.x1) - Math.max(other.x0, item.x0);
          return shared > 0.5 * Math.max(1, Math.min(other.x1 - other.x0, item.x1 - item.x0));
        });
        if (clash) continue;
        target = row;
        break;
      }
      if (target) {
        const count = target.items.length;
        target.cy = (target.cy * count + item.cy) / (count + 1);
        target.h = (target.h * count + item.h) / (count + 1);
        target.items.push(item);
      } else {
        rows.push({ items: [item], cy: item.cy, h: item.h });
      }
    }

    // 2. 行内按左右顺序连成文字。中文两端对齐时字距会拉开，空出一个字以上才算空格；
    //    隔得很远（表格的两栏、「姓名      张三」）用制表符隔开，识别规则把它当成栏与栏的分界。
    const lines = rows.map((row) => {
      const parts = row.items.sort((a, b) => a.x0 - b.x0);
      const h = median(parts.map((part) => part.h));
      let text = parts[0].text;
      let right = parts[0].x1;
      for (const part of parts.slice(1)) {
        const gap = part.x0 - right;
        const cjk = CJK.test(text.slice(-1)) || CJK.test(part.text[0]);
        if (gap > 2.5 * h) text += "\t";
        else if (gap > (cjk ? 1.2 : 0.2) * h) text += " ";
        text += part.text;
        right = Math.max(right, part.x1);
      }
      return { text, x0: parts[0].x0, x1: right, cy: row.cy, h };
    }).sort((a, b) => a.cy - b.cy);

    // 页眉页脚里只有页码的行不要（不含个人信息，留着会把跨页的段落切断）。
    return height > 0 ? lines.filter((line) => !((line.cy < height * 0.08 || line.cy > height * 0.92) && PAGE_NUMBER.test(line.text.trim()))) : lines;
  }

  /** 版心左右边界：行数够多的页才算得准。 */
  function pageMargins(lines) {
    if (lines.length < 6) return null;
    return { left: quantile(lines.map((line) => line.x0), 0.1), right: quantile(lines.map((line) => line.x1), 0.9) };
  }

  /**
   * 行 → 段落。行少的页（最后一页只剩落款）用 margins（同一文件其它页的版心）判断居中、右对齐；
   * 没有可参照的页时按左右页边距相等估计。
   */
  function paragraphsFromLines(lines, { width = 0, margins = null } = {}) {
    if (!lines.length) return { paragraphs: [], startsFresh: true, endsOpen: false };

    // 3. 正文左右边界和常见字高、行距。
    const charH = median(lines.map((line) => line.h));
    let left;
    let right;
    const own = pageMargins(lines);
    if (own) ({ left, right } = own);
    else if (margins) ({ left, right } = margins);
    else {
      const minX = Math.min(...lines.map((line) => line.x0));
      const maxX = Math.max(...lines.map((line) => line.x1));
      left = width > maxX ? Math.min(minX, width - maxX) : minX;
      right = width > maxX ? Math.max(maxX, width - minX) : maxX;
    }
    const pitches = [];
    for (let index = 1; index < lines.length; index += 1) {
      const pitch = lines[index].cy - lines[index - 1].cy;
      if (pitch > 0.5 * charH && pitch < 3 * charH) pitches.push(pitch);
    }
    const pitch = median(pitches) || charH * 1.5;
    const middle = (left + right) / 2;

    for (const line of lines) {
      const h = Math.max(line.h, charH * 0.6);
      const offset = line.x0 - left;
      line.tabbed = line.text.includes("\t");
      line.centered = !line.tabbed && Math.abs((line.x0 + line.x1) / 2 - middle) < 1.5 * h && line.x0 > left + 2 * h && line.x1 < right - 2 * h;
      line.right = !line.centered && !line.tabbed && offset > 4 * h && Math.abs(line.x1 - right) < 2 * h;
      line.floating = !line.centered && !line.right && offset > 4 * h;
      line.indented = !line.centered && offset > 0.9 * h && offset <= 4 * h;
      line.short = line.x1 < right - 1.5 * h;
      line.heading = line.h > 1.25 * charH && (line.centered || line.short);
      line.listed = LIST_MARKER.test(line.text);
      line.h = h;
    }

    // 聊天气泡、窄栏里的折行：本行和下一行左边对齐、本行是这一小块里最宽的、没有写完一句话，下一行也不是新标签。
    const wrapsLocally = (previous, line) => previous.short
      && Math.abs(line.x0 - previous.x0) < 0.6 * previous.h
      && line.cy - previous.cy <= 1.7 * pitch
      && previous.x1 - previous.x0 >= 8 * previous.h
      && line.x1 <= previous.x1 + 0.5 * previous.h
      && !CLAUSE_END.test(previous.text)
      && !LABEL_START.test(line.text);

    // 4. 拼段落。
    const paragraphs = [];
    let current = null;
    lines.forEach((line, index) => {
      const previous = lines[index - 1];
      const wrapped = Boolean(previous) && wrapsLocally(previous, line);
      const fresh = !current
        || (previous.short && !wrapped)
        || previous.tabbed || previous.centered || previous.heading || previous.right || (previous.floating && !wrapped)
        || (!wrapped && (line.indented || line.floating))
        || line.centered || line.heading || line.tabbed || line.listed || line.right
        || line.cy - previous.cy > 1.7 * pitch;
      if (fresh) {
        current = { text: line.text, align: line.centered ? "center" : line.right ? "right" : "", indent: line.indented, heading: line.heading };
        paragraphs.push(current);
      } else {
        current.text += joiner(current.text, line.text) + line.text;
      }
    });
    const first = lines[0];
    const last = lines[lines.length - 1];
    return {
      paragraphs,
      startsFresh: first.indented || first.centered || first.heading || first.tabbed || first.listed || first.right || first.floating,
      endsOpen: !last.short && !last.tabbed && !last.centered && !last.heading && !last.right && !last.floating,
    };
  }

  function layoutPage(fragments, options = {}) {
    return paragraphsFromLines(buildLines(fragments, options), options);
  }

  // ---- 读出来的文档（PDF / 图片）----

  class ExtractedDocument {
    /**
     * @param {{filename:string, kind:"pdf"|"image", pages:{label:string, fragments:object[], height?:number, ocr?:boolean}[], warnings?:string[]}} options
     */
    constructor({ filename, kind, pages, warnings = [] }) {
      this.filename = filename;
      this.kind = kind;
      this.pageCount = pages.length;
      this.ocrPages = pages.filter((page) => page.ocr).map((page) => page.label);
      this.warnings = warnings.slice();
      this.checklist = this.ocrPages.length
        ? "对照原件逐行核对识别出的文字；导出的 Word 由这些文字新建，不带原文件的图片、印章、签名和文档属性。"
        : "导出的 Word 由读出的文字新建，不带原 PDF 的图片、印章、签名、批注和文档属性。";

      // 跨页：上一页最后一行写到了右边、这一页第一行没有缩进，就是同一段接着写。
      const paragraphs = [];
      const marks = [];
      let previous = null;
      const built = pages.map((page) => buildLines(page.fragments, { height: page.height, ocr: page.ocr }));
      const references = pages.map((page, index) => ({ width: page.width || 0, margins: pageMargins(built[index]) })).filter((item) => item.margins);
      for (const [index, page] of pages.entries()) {
        const similar = references.filter((item) => Math.abs(item.width - (page.width || 0)) <= 0.1 * Math.max(1, page.width || 0));
        const margins = similar.length ? { left: median(similar.map((item) => item.margins.left)), right: median(similar.map((item) => item.margins.right)) } : null;
        const result = paragraphsFromLines(built[index], { width: page.width, margins });
        const list = result.paragraphs.map((paragraph) => ({ ...paragraph }));
        const last = paragraphs[paragraphs.length - 1];
        if (list.length && last && previous && previous.endsOpen && !result.startsFresh && !last.align && !last.heading) {
          const head = list.shift();
          const glue = joiner(last.text, head.text);
          marks.push({ label: page.label, paragraph: paragraphs.length - 1, offset: last.text.length + glue.length });
          last.text += glue + head.text;
        } else {
          marks.push({ label: page.label, paragraph: paragraphs.length, offset: 0 });
        }
        paragraphs.push(...list);
        if (result.paragraphs.length) previous = result;
      }

      let offset = 0;
      for (const paragraph of paragraphs) {
        paragraph.start = offset;
        paragraph.end = offset + paragraph.text.length;
        offset = paragraph.end + 1;
      }
      this.paragraphs = paragraphs;
      this.text = paragraphs.map((paragraph) => `${paragraph.text}\n`).join("");
      if (!this.text.trim()) {
        fail(kind === "pdf" ? "这个 PDF 里没有读到文字。" : "图片里没有识别到文字。请换一张更清楚、文字端正的照片再试。");
      }
      if (this.text.length > 1000000) fail("文字超过 100 万字，请拆分后再导入。");

      const starts = marks.map((mark) => (mark.paragraph < paragraphs.length ? paragraphs[mark.paragraph].start + mark.offset : this.text.length));
      this.sections = pages.length > 1
        ? marks.map((mark, index) => ({ name: mark.label, start: starts[index], end: index + 1 < marks.length ? starts[index + 1] : this.text.length })).filter((part) => part.end > part.start)
        : [{ name: "正文", start: 0, end: this.text.length }];
      this.boundaries = [];
      for (let index = this.text.indexOf("\t"); index >= 0; index = this.text.indexOf("\t", index + 1)) this.boundaries.push(index);
    }

    info() {
      return {
        text: this.text,
        characters: Array.from(this.text.replace(/\s/g, "")).length,
        pages: this.pageCount,
        ocrPages: this.ocrPages.slice(),
        warnings: this.warnings.slice(),
        sections: this.sections.slice(),
      };
    }

    /** 按确认后的识别项生成只含文字的 Word（Uint8Array）。不改动本对象，可以反复导出。 */
    export(matches) {
      const Word = root.RedactionWord;
      Word.validateMatches(this.text, matches);
      const enabled = matches.filter((item) => item.enabled !== false).sort((a, b) => a.start - b.start);
      let pointer = 0;
      const output = this.paragraphs.map((paragraph) => {
        const { start, end } = paragraph;
        while (pointer < enabled.length && enabled[pointer].end <= start) pointer += 1;
        let cursor = start;
        let value = "";
        for (let index = pointer; index < enabled.length && enabled[index].start < end; index += 1) {
          const item = enabled[index];
          value += this.text.slice(cursor, Math.max(start, item.start));
          if (item.start >= start) value += item.mask;
          cursor = Math.min(end, item.end);
        }
        value += this.text.slice(cursor, end);
        return { text: value, align: paragraph.align, indent: paragraph.indent, heading: paragraph.heading };
      });
      return Word.paragraphsToDocx(output);
    }
  }

  root.RedactionLayout = { layoutPage, buildLines, paragraphsFromLines, cleanText, ExtractedDocument };
})(typeof window !== "undefined" ? window : globalThis);
