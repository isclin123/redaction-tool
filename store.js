/* 本机保存的只有敏感词库（一组词），不保存任何文件。
 * 存在这台设备上该应用自己的 IndexedDB 里，不上传、不同步。IndexedDB 不可用时（个别隐私模式）
 * 退回内存保存，关闭后词库会丢失。
 */
(function (root) {
  "use strict";

  const DB_NAME = "redaction-app";
  const DB_VERSION = 1;
  const memory = new Map();
  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = root.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("settings")) request.result.createObjectStore("settings", { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(() => null);
    }
    return opening;
  }

  async function perform(mode, action) {
    const db = await open();
    if (!db) return action(null).result;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("settings", mode);
      const request = action(transaction.objectStore("settings"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("保存失败"));
    });
  }

  root.RedactionStore = {
    async getTerms() {
      const row = await perform("readonly", (store) => (store ? store.get("terms") : { result: memory.get("terms") }));
      return row && Array.isArray(row.value) ? row.value : [];
    },

    saveTerms(terms) {
      const row = { key: "terms", value: terms };
      return perform("readwrite", (store) => (store ? store.put(row) : { result: memory.set("terms", row) }));
    },
  };
})(window);
