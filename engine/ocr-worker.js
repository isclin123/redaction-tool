/* 图片文字识别：PaddleOCR PP-OCRv4 中文模型（vendor/ppocr-v4）+ ONNX Runtime Web（vendor/onnxruntime-web）。
 *
 * 在后台线程里跑，页面不会卡住；模型和运行库都是本机文件，不联网。流程与 PaddleOCR 的 predict_system 一致：
 *   ① 文字检测（DB）：整张图 → 每个像素是文字的概率 → 连通区域 → 最小外接矩形 → 向外扩一点
 *   ② 按矩形把每一行裁出来摆正，缩到 48 像素高
 *   ③ 文字识别（SVTR-LCNet + CTC）：逐行读出文字和置信度，置信度低于 0.5 的丢掉
 * 收到 { id, bitmap }，回复 { id, ok, result: { width, height, fragments: [{ x0, x1, cy, h, text, score }] } }。
 */
"use strict";

const ORT_DIR = "../vendor/onnxruntime-web-1.24.3/";
const MODEL_DIR = "../vendor/ppocr-v4/";
const DET_MAX_SIDE = 1600; // 检测时长边缩到多少像素（PaddleOCR 默认 960，文书字小，放大一些）
const DET_THRESH = 0.3;
const BOX_THRESH = 0.6;
const UNCLIP_RATIO = 1.5;
const MIN_SIZE = 3;
const MAX_CANDIDATES = 1500;
const REC_HEIGHT = 48;
const REC_MIN_WIDTH = 320;
const REC_MAX_WIDTH = 3200;
const DROP_SCORE = 0.5;

const COMPONENT_ERROR = "图片识别组件没能加载。请联网打开一次文件脱敏，等「识别组件」下载完成后再试（之后断网也能用）。";

let models = null;

function url(path) {
  return new URL(path, self.location.href).href;
}

async function fetchBytes(path) {
  const response = await fetch(url(path));
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function load() {
  if (!models) {
    models = (async () => {
      if (typeof OffscreenCanvas === "undefined" || typeof WebAssembly === "undefined") {
        models = null;
        throw new Error("这台设备的浏览器版本太旧，不能识别图片文字。iPhone、iPad 请升级到 iOS 16.4 或更新版本；电脑请使用最新版 Edge、Chrome 或 Safari。");
      }
      try {
        importScripts(url(`${ORT_DIR}ort.wasm.min.js`));
        const { ort } = self;
        ort.env.wasm.wasmPaths = url(ORT_DIR);
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
        ort.env.logLevel = "error";
        const options = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
        const det = await ort.InferenceSession.create(await fetchBytes(`${MODEL_DIR}det.onnx`), options);
        const rec = await ort.InferenceSession.create(await fetchBytes(`${MODEL_DIR}rec.onnx`), options);
        const keys = new TextDecoder().decode(await fetchBytes(`${MODEL_DIR}keys.txt`)).replace(/\r/g, "").replace(/\n$/, "").split("\n");
        return { ort, det, rec, dictionary: ["", ...keys, " "] };
      } catch (error) {
        models = null;
        const wrapped = new Error(COMPONENT_ERROR);
        wrapped.detail = String(error && (error.stack || error.message) || error);
        throw wrapped;
      }
    })();
  }
  return models;
}

// ---------------------------------------------------------------- 图像

function canvas2d(width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

/** RGBA → 按 PaddleOCR（OpenCV 读图）的 BGR 通道顺序归一化的 NCHW。 */
function toTensor(ort, rgba, width, height, mean, std) {
  const plane = width * height;
  const data = new Float32Array(3 * plane);
  for (let p = 0, i = 0; p < plane; p += 1, i += 4) {
    data[p] = (rgba[i + 2] / 255 - mean[0]) / std[0];
    data[plane + p] = (rgba[i + 1] / 255 - mean[1]) / std[1];
    data[2 * plane + p] = (rgba[i] / 255 - mean[2]) / std[2];
  }
  return new ort.Tensor("float32", data, [1, 3, height, width]);
}

// ---------------------------------------------------------------- ① 检测

function convexHull(points) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const point of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** 凸包的最小面积外接矩形（旋转卡壳）。返回中心、沿 u 方向的宽 w、沿法向的高 h 和单位向量 u。 */
function minAreaRect(hull) {
  if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], w: 0, h: 0, ux: 1, uy: 0 };
  let best = null;
  for (let index = 0; index < hull.length; index += 1) {
    const a = hull[index];
    const b = hull[(index + 1) % hull.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!length) continue;
    const ux = (b[0] - a[0]) / length;
    const uy = (b[1] - a[1]) / length;
    let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = { area, cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, w: maxU - minU, h: maxV - minV, ux, uy };
    }
  }
  return best;
}

function corners({ cx, cy, w, h, ux, uy }) {
  const ax = (ux * w) / 2; const ay = (uy * w) / 2;
  const bx = (-uy * h) / 2; const by = (ux * h) / 2;
  return [[cx - ax - bx, cy - ay - by], [cx + ax - bx, cy + ay - by], [cx + ax + bx, cy + ay + by], [cx - ax + bx, cy - ay + by]];
}

/** 和 PaddleOCR get_mini_boxes 一样排成 左上、右上、右下、左下。 */
function orderPoints(points) {
  const sorted = points.slice().sort((a, b) => a[0] - b[0]);
  const [l1, l2, r1, r2] = sorted;
  const [tl, bl] = l1[1] <= l2[1] ? [l1, l2] : [l2, l1];
  const [tr, br] = r1[1] <= r2[1] ? [r1, r2] : [r2, r1];
  return [tl, tr, br, bl];
}

/** 矩形内的平均概率（box_score_fast）。 */
function boxScore(prob, width, height, quad) {
  const xs = quad.map((p) => p[0]); const ys = quad.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))); const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))); const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  let sum = 0; let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      let inside = true;
      for (let k = 0; k < 4 && inside; k += 1) {
        const a = quad[k]; const b = quad[(k + 1) % 4];
        if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < -0.5 * Math.hypot(b[0] - a[0], b[1] - a[1])) inside = false;
      }
      if (inside) { sum += prob[y * width + x]; count += 1; }
    }
  }
  return count ? sum / count : 0;
}

/** 概率图 → 文字框（概率图坐标）。连通区域代替 OpenCV 的轮廓。 */
function boxesFromMap(prob, width, height) {
  const size = width * height;
  const seen = new Uint8Array(size);
  const queue = new Int32Array(size);
  const boxes = [];
  for (let start = 0; start < size && boxes.length < MAX_CANDIDATES; start += 1) {
    if (seen[start] || prob[start] <= DET_THRESH) continue;
    let head = 0; let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let minY = height; let maxY = -1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width; const y = (index - x) / width;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if ((!dx && !dy) || nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (!seen[next] && prob[next] > DET_THRESH) { seen[next] = 1; queue[tail++] = next; }
        }
      }
    }
    if (tail < 4) continue;
    const rowMin = new Int32Array(maxY - minY + 1).fill(width);
    const rowMax = new Int32Array(maxY - minY + 1).fill(-1);
    for (let k = 0; k < tail; k += 1) {
      const index = queue[k];
      const x = index % width; const r = (index - x) / width - minY;
      if (x < rowMin[r]) rowMin[r] = x;
      if (x > rowMax[r]) rowMax[r] = x;
    }
    const points = [];
    for (let r = 0; r < rowMin.length; r += 1) {
      if (rowMax[r] < 0) continue;
      points.push([rowMin[r], r + minY]);
      if (rowMax[r] !== rowMin[r]) points.push([rowMax[r], r + minY]);
    }
    const rect = minAreaRect(convexHull(points));
    if (!rect || Math.min(rect.w, rect.h) < MIN_SIZE) continue;
    const score = boxScore(prob, width, height, orderPoints(corners(rect)));
    if (score < BOX_THRESH) continue;
    // unclip：按 面积×比例÷周长 向外扩（PaddleOCR 用 pyclipper，对矩形结果相同）。
    const distance = (rect.w * rect.h * UNCLIP_RATIO) / (2 * (rect.w + rect.h));
    const grown = { ...rect, w: rect.w + 2 * distance, h: rect.h + 2 * distance };
    if (Math.min(grown.w, grown.h) < MIN_SIZE + 2) continue;
    boxes.push(corners(grown));
  }
  return boxes;
}

async function detect(state, bitmap, top, tileHeight) {
  const { ort, det } = state;
  const sourceW = bitmap.width;
  const ratio = Math.min(1, DET_MAX_SIDE / Math.max(sourceW, tileHeight));
  const width = Math.max(32, Math.round((sourceW * ratio) / 32) * 32);
  const height = Math.max(32, Math.round((tileHeight * ratio) / 32) * 32);
  const { context } = canvas2d(width, height);
  context.drawImage(bitmap, 0, top, sourceW, tileHeight, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const input = toTensor(ort, pixels, width, height, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);
  const output = await det.run({ [det.inputNames[0]]: input });
  const map = output[det.outputNames[0]];
  const [mapH, mapW] = map.dims.slice(-2);
  const sx = sourceW / mapW; const sy = tileHeight / mapH;
  return boxesFromMap(map.data, mapW, mapH).map((quad) => orderPoints(quad.map(([x, y]) => [
    Math.min(sourceW, Math.max(0, x * sx)),
    Math.min(bitmap.height, Math.max(0, y * sy + top)),
  ])));
}

// ---------------------------------------------------------------- ② 裁行 + ③ 识别

async function recognizeLine(state, bitmap, quad) {
  const { ort, rec, dictionary } = state;
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let [p0, p1, p2, p3] = quad;
  let cropW = Math.max(distance(p0, p1), distance(p3, p2));
  let cropH = Math.max(distance(p0, p3), distance(p1, p2));
  if (cropW < 2 || cropH < 2) return null;
  // 竖排的一列：和 PaddleOCR 一样逆时针转 90 度再识别。
  if (cropH / cropW >= 1.5) {
    [p0, p1, p2, p3] = [p1, p2, p3, p0];
    [cropW, cropH] = [cropH, cropW];
  }
  const outW = Math.max(1, Math.min(REC_MAX_WIDTH, Math.ceil((cropW * REC_HEIGHT) / cropH)));
  const tensorW = Math.max(REC_MIN_WIDTH, outW);
  // 目标 (0,0)→p0、(outW,0)→p1、(0,48)→p3 的仿射变换，求逆后交给画布。
  const ax = (p1[0] - p0[0]) / outW; const ay = (p1[1] - p0[1]) / outW;
  const bx = (p3[0] - p0[0]) / REC_HEIGHT; const by = (p3[1] - p0[1]) / REC_HEIGHT;
  const det = ax * by - bx * ay;
  if (!det) return null;
  const a = by / det; const b = -ay / det; const c = -bx / det; const d = ax / det;
  const { context } = canvas2d(outW, REC_HEIGHT);
  context.setTransform(a, b, c, d, -(a * p0[0] + c * p0[1]), -(b * p0[0] + d * p0[1]));
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, outW, REC_HEIGHT).data;
  // 右侧补 0（归一化后的灰），与 PaddleOCR resize_norm_img 一致。
  const plane = tensorW * REC_HEIGHT;
  const data = new Float32Array(3 * plane);
  for (let y = 0; y < REC_HEIGHT; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const i = (y * outW + x) * 4; const p = y * tensorW + x;
      data[p] = pixels[i + 2] / 127.5 - 1;
      data[plane + p] = pixels[i + 1] / 127.5 - 1;
      data[2 * plane + p] = pixels[i] / 127.5 - 1;
    }
  }
  const output = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, REC_HEIGHT, tensorW]) });
  const probs = output[rec.outputNames[0]];
  const [, steps, classes] = probs.dims;
  if (classes !== dictionary.length) throw new Error(`识别模型和字表不匹配：${classes} / ${dictionary.length}`);
  let text = ""; let total = 0; let count = 0; let previous = -1;
  for (let t = 0; t < steps; t += 1) {
    const offset = t * classes;
    let best = 0; let bestP = -Infinity;
    for (let k = 0; k < classes; k += 1) {
      const value = probs.data[offset + k];
      if (value > bestP) { bestP = value; best = k; }
    }
    if (best !== 0 && best !== previous) { text += dictionary[best]; total += bestP; count += 1; }
    previous = best;
  }
  const score = count ? total / count : 0;
  if (!text.trim() || score < DROP_SCORE) return null;
  return { quad: [p0, p1, p2, p3], width: cropW, h: cropH, text, score };
}

/** 拍歪的照片：用长文字行的倾斜角（中位数）把所有框转正，排版时左边距、同一行才判断得准。 */
function straighten(lines) {
  const angles = lines.filter((line) => line.width > 4 * line.h).map(({ quad: [p0, p1] }) => Math.atan2(p1[1] - p0[1], p1[0] - p0[0])).sort((a, b) => a - b);
  const angle = angles.length ? angles[Math.floor(angles.length / 2)] : 0;
  const cos = Math.cos(-angle); const sin = Math.sin(-angle);
  const useAngle = Math.abs(angle) > 0.003 && Math.abs(angle) < 0.35;
  return lines.map(({ quad, h, text, score }) => {
    const points = useAngle ? quad.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]) : quad;
    const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), cy: (Math.min(...ys) + Math.max(...ys)) / 2, h, text, score };
  });
}

async function recognize(bitmap) {
  const state = await load();
  const { width, height } = bitmap;
  // 长截图（聊天记录）分段检测，段与段之间重叠，只保留中线落在本段中间部分的框。
  const tile = height > width * 2.2 ? Math.round(width * 1.6) : height;
  const overlap = tile < height ? Math.max(160, Math.round(width * 0.2)) : 0;
  const quads = [];
  for (let top = 0; top < height; top += tile - overlap) {
    const tileHeight = Math.min(tile, height - top);
    const keepFrom = top === 0 ? -Infinity : top + overlap / 2;
    const keepTo = top + tileHeight >= height ? Infinity : top + tileHeight - overlap / 2;
    for (const quad of await detect(state, bitmap, top, tileHeight)) {
      const middle = (Math.min(...quad.map((p) => p[1])) + Math.max(...quad.map((p) => p[1]))) / 2;
      if (middle >= keepFrom && middle < keepTo) quads.push(quad);
    }
    if (top + tileHeight >= height) break;
  }
  const lines = [];
  for (const quad of quads) {
    const line = await recognizeLine(state, bitmap, quad);
    if (line) lines.push(line);
  }
  return { width, height, fragments: straighten(lines) };
}

self.addEventListener("message", async (event) => {
  const { id, type, bitmap } = event.data || {};
  try {
    if (type === "warmup") {
      await load();
      self.postMessage({ id, ok: true, result: null });
      return;
    }
    if (type !== "recognize" || !bitmap) throw new Error("无效的识别请求。");
    const result = await recognize(bitmap);
    bitmap.close();
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    if (bitmap && bitmap.close) bitmap.close();
    self.postMessage({ id, ok: false, error: error.message || String(error), detail: error.detail || String(error && error.stack || "") });
  }
});
