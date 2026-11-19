/* PDF 读取：有文字层的页直接读文字和位置（pdf.js，本机运行）；扫描页、乱码页画成图片交给文字识别（ocr.js）。
 * 输出交给 layout.js 拼成段落。pdf.js（约 5 MB）第一次用到时才加载。
 */
(function (root) {
  "use strict";

  const DIR = "vendor/pdfjs-5.4.624/";
  const MAX_PDF = 60 * 1024 * 1024;
  const MAX_PAGES = 500;
  const MIN_TEXT = 20; // 一页能读到的字少于这个数，按扫描件识别
  const RENDER_SIDE = 2400; // 扫描页画成图片时长边的像素
  const COMPONENT_ERROR = "PDF 读取组件没能加载。请联网打开一次文件脱敏，等「识别组件」下载完成后再试（之后断网也能用）。";

  let loading = null;

  function fail(message) {
    throw new Error(message);
  }

  function asset(path) {
    return new URL(DIR + path, document.baseURI).href;
  }

  function library() {
    if (!loading) {
      loading = import(asset("pdf.min.mjs")).then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = asset("pdf.worker.min.mjs");
        return pdfjs;
      }).catch((error) => {
        loading = null;
        if (root.console) root.console.warn("PDF 组件：", error);
        fail(COMPONENT_ERROR);
      });
    }
    return loading;
  }

  function meaningful(text) {
    return Array.from(text.replace(/\s/g, "")).length;
  }

  /** 字体没有带字符映射的 PDF 会读出私用区字符、替换符或控制字符。 */
  function garbled(text) {
    const letters = Array.from(text.replace(/\s/g, ""));
    if (!letters.length) return false;
    const bad = letters.filter((char) => /[\ue000-\uf8ff\ufffd\u0000-\u0008\u000e-\u001f]/.test(char)).length;
    return bad / letters.length > 0.05;
  }

  function textFragments(pdfjs, content, viewport) {
    const fragments = [];
    let skipped = 0;
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
      const size = Math.hypot(matrix[2], matrix[3]);
      const angle = Math.atan2(matrix[1], matrix[0]);
      // 斜排、竖排的字（水印、骑缝章、侧边栏）不读：读不成通顺的行，也就不带进导出的 Word。
      if (!size || Math.abs(angle) > 0.17 || matrix[3] > 0) {
        skipped += Array.from(item.str.trim()).length;
        continue;
      }
      const width = item.width * viewport.scale;
      fragments.push({ x0: matrix[4], x1: matrix[4] + width, cy: matrix[5] - size * 0.35, h: size, text: item.str });
    }
    return { fragments, skipped };
  }

  async function renderPage(page) {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, RENDER_SIDE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    // 按「打印」方式画：不等 requestAnimationFrame，页面切到后台时也能接着识别。
    await page.render({ canvas, viewport, background: "white", intent: "print" }).promise;
    const bitmap = await createImageBitmap(canvas);
    canvas.width = 0;
    canvas.height = 0;
    return bitmap;
  }

  /**
   * @param {Uint8Array} bytes
   * @param {{forceOcr?:boolean, onProgress?:(text:string)=>void, cancelled?:()=>boolean}} options
   * @returns {Promise<{pages:object[], skipped:number}|null>} 取消时返回 null
   */
  async function readPdf(bytes, { forceOcr = false, onProgress = () => {}, cancelled = () => false } = {}) {
    if (!bytes.length || bytes.length > MAX_PDF) fail("PDF 为空或超过 60 MB，请拆分后再导入。");
    onProgress("正在加载 PDF 读取组件…");
    const pdfjs = await library();
    let pdf;
    try {
      pdf = await pdfjs.getDocument({
        data: bytes.slice(),
        cMapUrl: asset("cmaps/"),
        cMapPacked: true,
        standardFontDataUrl: asset("standard_fonts/"),
        wasmUrl: asset("wasm/"),
        iccUrl: asset("iccs/"),
        isEvalSupported: false,
        enableXfa: false,
        useSystemFonts: false,
        stopAtErrors: false,
        verbosity: 0,
      }).promise;
    } catch (error) {
      if (error && error.name === "PasswordException") fail("这个 PDF 设了打开密码，请先在 PDF 软件里去掉密码再导入。");
      if (root.console) root.console.warn("PDF：", error);
      fail("无法读取这个 PDF，请确认文件完整、不是加密文件。");
    }
    try {
      if (pdf.numPages > MAX_PAGES) fail(`PDF 有 ${pdf.numPages} 页，超过 ${MAX_PAGES} 页，请拆分后再导入。`);
      const pages = [];
      let skipped = 0;
      for (let number = 1; number <= pdf.numPages; number += 1) {
        if (cancelled()) return null;
        onProgress(`正在读取第 ${number} / ${pdf.numPages} 页…`);
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({ scale: 1 });
        const label = `第 ${number} 页`;
        const read = textFragments(pdfjs, await page.getTextContent(), viewport);
        const text = read.fragments.map((fragment) => fragment.text).join("");
        if (forceOcr || meaningful(text) < MIN_TEXT || garbled(text)) {
          onProgress(`正在识别第 ${number} / ${pdf.numPages} 页的图片文字…`);
          const bitmap = await renderPage(page);
          if (cancelled()) {
            bitmap.close();
            return null;
          }
          const result = await root.RedactionOcr.recognize(bitmap);
          pages.push({ label, fragments: result.fragments, width: result.width, height: result.height, ocr: true });
        } else {
          skipped += read.skipped;
          pages.push({ label, fragments: read.fragments, width: viewport.width, height: viewport.height, ocr: false });
        }
        page.cleanup();
      }
      return { pages, skipped };
    } finally {
      pdf.destroy();
    }
  }

  function warmup() {
    return library();
  }

  root.RedactionPdf = { readPdf, warmup, MAX_PDF };
})(window);
