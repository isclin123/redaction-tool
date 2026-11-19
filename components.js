/* PDF / 图片识别组件（pdf.js、ONNX Runtime、PaddleOCR 模型，约 33 MB）存到本机。
 *
 * 程序本身很小，装应用时整份离线缓存（sw.js）；这几个组件大，单独放一个缓存（redaction-lib-<内容指纹>），
 * 由页面在联网时逐个文件下载，断了下次接着下，不拖慢安装，也不会因为某个文件没下完而整个装不上。
 * 组件没有变化时，程序更新不会重新下载它们。清单 components.json 由 build.sh 生成；开发时没有清单，什么也不做。
 */
(function (root) {
  "use strict";

  const PREFIX = "redaction-lib-";
  const PARALLEL = 4;
  let running = null;

  function megabytes(bytes) {
    return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
  }

  async function manifest() {
    try {
      const response = await fetch("components.json", { cache: "no-cache" });
      if (!response.ok) return null;
      const data = await response.json();
      return data && Array.isArray(data.files) && typeof data.cache === "string" && data.cache.startsWith(PREFIX) ? data : null;
    } catch (error) {
      return null;
    }
  }

  async function removeOld(current) {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== current) await caches.delete(key);
  }

  /**
   * @param {(state:{stage:"downloading"|"ready"|"offline"|"failed", done?:number, total?:number, text:string})=>void} onStatus
   */
  function prepare(onStatus = () => {}) {
    if (running) return running;
    running = (async () => {
      if (!("caches" in root)) return;
      const list = await manifest();
      if (!list) return;
      const cache = await caches.open(list.cache);
      const missing = [];
      let done = 0;
      for (const file of list.files) {
        if (await cache.match(file.path)) done += file.size;
        else missing.push(file);
      }
      const total = list.bytes;
      if (!missing.length) {
        await removeOld(list.cache);
        onStatus({ stage: "ready", text: "" });
        return;
      }
      if (navigator.onLine === false) {
        onStatus({ stage: "offline", text: "PDF 和图片识别组件还没存到本机：联网时打开一次，下载完以后断网也能用。" });
        return;
      }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      const report = () => onStatus({ stage: "downloading", done, total, text: `正在把 PDF 和图片识别组件存到本机：${megabytes(done)} / ${megabytes(total)} MB。下载完以后断网也能用。` });
      report();
      let failed = 0;
      const queue = missing.slice();
      const worker = async () => {
        while (queue.length) {
          const file = queue.shift();
          try {
            const response = await fetch(file.path, { cache: "no-cache" });
            if (!response.ok) throw new Error(String(response.status));
            await cache.put(file.path, response);
            done += file.size;
            report();
          } catch (error) {
            failed += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      if (failed) {
        onStatus({ stage: "failed", text: "PDF 和图片识别组件还没下载完（网络中断），下次联网打开时会接着下载。" });
        return;
      }
      await removeOld(list.cache);
      onStatus({ stage: "ready", fresh: true, text: "PDF 和图片识别组件已存到本机，断网也能用。" });
    })().catch(() => {
      onStatus({ stage: "failed", text: "PDF 和图片识别组件还没下载完，下次联网打开时会接着下载。" });
    }).finally(() => {
      running = null;
    });
    return running;
  }

  root.RedactionComponents = { prepare };
})(window);
