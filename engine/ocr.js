/* 页面这一侧的文字识别：把图片解码成位图交给后台线程（engine/ocr-worker.js）识别。
 * 识别组件（约 28 MB）第一次用到时才加载；装好的应用会提前存到本机（components.js），之后断网也能用。
 */
(function (root) {
  "use strict";

  const MAX_SIDE = 4000; // iPhone 上画布超过约 1600 万像素会失败
  const MAX_AREA = 16000000;
  const IMAGE_FILE = /\.(?:jpe?g|png|webp|bmp|gif|heic|heif|tiff?)$/i;

  let worker = null;
  let nextId = 1;
  const pending = new Map();

  function fail(message) {
    throw new Error(message);
  }

  function dropWorker(message) {
    for (const { reject } of pending.values()) reject(new Error(message));
    pending.clear();
    if (worker) worker.terminate();
    worker = null;
  }

  function getWorker() {
    if (worker) return worker;
    try {
      worker = new Worker(new URL("engine/ocr-worker.js", document.baseURI));
    } catch (error) {
      fail("这个浏览器不能在本机识别图片文字，请用最新版 Safari、Edge 或 Chrome，并从安装好的应用打开。");
    }
    worker.addEventListener("message", (event) => {
      const { id, ok, result, error, detail } = event.data || {};
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      if (ok) job.resolve(result);
      else {
        if (detail && root.console) root.console.warn("文字识别：", detail);
        job.reject(new Error(error));
      }
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      dropWorker("图片识别组件没能加载。请联网打开一次文件脱敏，等「识别组件」下载完成后再试（之后断网也能用）。");
    });
    return worker;
  }

  function call(message, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, ...message }, transfer);
    });
  }

  /** 识别一张位图（会被转交给后台线程，之后不能再用）。 */
  function recognize(bitmap) {
    return call({ type: "recognize", bitmap }, [bitmap]);
  }

  /** 提前加载模型，第一张图不用干等。 */
  function warmup() {
    return call({ type: "warmup" });
  }

  function isImageFile(file) {
    return /^image\//.test(file.type || "") || IMAGE_FILE.test(file.name || "");
  }

  async function loadImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      await image.decode();
      return image;
    } catch (error) {
      fail(/\.(?:heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type)
        ? `${file.name} 是 HEIC 格式，这个浏览器打不开。请在 iPhone「设置 → 相机 → 格式」选「兼容性最佳」，或把照片转成 JPG 后再导入。`
        : `${file.name} 打不开，请确认是 JPG、PNG 等常见格式的图片。`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** 图片文件 → 白底位图（按照片的拍摄方向摆正，太大的缩小）。 */
  async function decodeImage(file) {
    const image = await loadImage(file);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) fail(`${file.name} 打不开，请确认是 JPG、PNG 等常见格式的图片。`);
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_AREA / (width * height)));
    return bitmapFrom(image, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  }

  async function bitmapFrom(source, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
    const bitmap = await createImageBitmap(canvas);
    canvas.width = 0;
    canvas.height = 0;
    return bitmap;
  }

  root.RedactionOcr = { recognize, warmup, decodeImage, isImageFile, MAX_SIDE, MAX_AREA };
})(window);
