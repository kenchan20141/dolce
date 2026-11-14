import "./styles.css";
import { MetaData } from "./smufl/smufl";
import { setMeasureBackend } from "./common/measure";
import { browserMeasure, ensureFontsReady } from "./common/measure.browser";
import { asset } from "./common/asset";
import { App, type ViewMode } from "./editor/app";
import type { DocFormatId } from "./editor/formats";
import type { ElementId } from "./model/doc";
import { anchorSeconds, spanSeconds, timelineSeconds, type PlayPoint } from "./editor/player";
import { SAMPLE } from "./editor/sample";
import { initLang } from "./i18n";
import { attachPinchZoom } from "./editor/pinchzoom";
import { isPdf } from "./omrkit/pdf";
import { recognizeMusicppDetailed, omrEmitter } from "./omr";
import { scoreDocToMusicXml } from "./model/toxml";

export type OmrKind = "auto" | "jianpu" | "staff";

export interface ScoreSnapshot {
  title: string;
  format: DocFormatId;
  text: string;
  viewMode: ViewMode;
}

async function registerBravura() {
  if (typeof FontFace === "undefined") return;
  const faces = [
    new FontFace("Bravura", `url(${asset("redist/Bravura.woff2")}) format("woff2")`),
    new FontFace("Bravura Text", `url(${asset("redist/BravuraText.otf")}) format("opentype")`),
  ];
  await Promise.all(faces.map((f) => f.load()));
  for (const f of faces) (document.fonts as FontFaceSet).add(f);
}

/**
 * 將手拍照片或過大圖檔做「尺寸上限控管」＋「陰影光影去除」＋「白底黑字高對比強化」：
 * 1. 限制最大長邊與總像素上限，避免超高畫素照片拖慢辨識，同時保留譜線與符頭辨識精度。
 * 2. 透過局部網格 85 分位數估測紙張底色亮度並雙線性內插，消除手拍陰影、折痕與燈光不均。
 * 3. 進行黑白分明拉伸（紙張壓為純白 #FFFFFF，譜線與符號壓為銳利純黑 #000000），並以無損 PNG 輸出。
 */
function enhanceScoreContrast(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const n = w * h;
  const lum = new Uint8Array(n);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // 含透明底時以白色為底合成，避免透明區域變黑塊
    const a = data[p + 3]!;
    if (a < 250) {
      const alpha = a / 255;
      const r = data[p]! * alpha + 255 * (1 - alpha);
      const g = data[p + 1]! * alpha + 255 * (1 - alpha);
      const b = data[p + 2]! * alpha + 255 * (1 - alpha);
      lum[i] = Math.min(255, (77 * r + 150 * g + 29 * b + 128) >> 8);
    } else {
      lum[i] = (77 * data[p]! + 150 * data[p + 1]! + 29 * data[p + 2]! + 128) >> 8;
    }
  }

  // 局部網格估測背景紙張亮度（消除手機拍攝陰影與黃光色偏）
  const block = Math.max(20, Math.min(48, Math.round(Math.min(w, h) / 40)));
  const gw = Math.max(1, Math.ceil(w / block));
  const gh = Math.max(1, Math.ceil(h / block));
  const grid = new Float32Array(gw * gh);
  const hist = new Uint32Array(64);
  const stride = Math.max(1, Math.floor(block / 14));

  for (let gy = 0; gy < gh; gy++) {
    const y0 = gy * block;
    const y1 = Math.min(h, y0 + block);
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx * block;
      const x1 = Math.min(w, x0 + block);
      hist.fill(0);
      let cnt = 0;
      for (let y = y0; y < y1; y += stride) {
        const rowOff = y * w;
        for (let x = x0; x < x1; x += stride) {
          hist[lum[rowOff + x]! >> 2]!++;
          cnt++;
        }
      }
      const target = Math.max(1, Math.floor(cnt * 0.85));
      let acc = 0;
      let bgVal = 255;
      for (let b = 0; b < 64; b++) {
        acc += hist[b]!;
        if (acc >= target) {
          bgVal = Math.min(255, b * 4 + 2);
          break;
        }
      }
      grid[gy * gw + gx] = bgVal;
    }
  }

  // 對粗網格做 3x3 平滑，避免單格特大粗黑標題字造成亮暗斷層
  const smoothGrid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0;
      let wsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = Math.max(0, Math.min(gh - 1, gy + dy));
        const wy = dy === 0 ? 2 : 1;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.max(0, Math.min(gw - 1, gx + dx));
          const wt = wy * (dx === 0 ? 2 : 1);
          sum += grid[ny * gw + nx]! * wt;
          wsum += wt;
        }
      }
      smoothGrid[gy * gw + gx] = Math.max(36, sum / wsum);
    }
  }

  // 預建非線性黑白高對比查找表（白底 >= 214 壓純白，黑墨 <= 135 壓純黑，中間階保留抗鋸齒）
  const BLACK_CLIP = 135;
  const WHITE_CLIP = 214;
  const SPAN = WHITE_CLIP - BLACK_CLIP;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    if (v <= BLACK_CLIP) lut[v] = 0;
    else if (v >= WHITE_CLIP) lut[v] = 255;
    else {
      const t = (v - BLACK_CLIP) / SPAN;
      lut[v] = Math.round(Math.pow(t, 1.5) * 255);
    }
  }

  const halfBlock = block * 0.5;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(gh - 1, (y - halfBlock) / block));
    const gy0 = Math.floor(fy);
    const gy1 = Math.min(gh - 1, gy0 + 1);
    const ty = fy - gy0;
    const ity = 1 - ty;
    const rowOff = y * w;

    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(gw - 1, (x - halfBlock) / block));
      const gx0 = Math.floor(fx);
      const gx1 = Math.min(gw - 1, gx0 + 1);
      const tx = fx - gx0;

      const b00 = smoothGrid[gy0 * gw + gx0]!;
      const b10 = smoothGrid[gy0 * gw + gx1]!;
      const b01 = smoothGrid[gy1 * gw + gx0]!;
      const b11 = smoothGrid[gy1 * gw + gx1]!;
      const bg = (b00 * (1 - tx) + b10 * tx) * ity + (b01 * (1 - tx) + b11 * tx) * ty;

      const idx = rowOff + x;
      const norm = Math.min(255, Math.max(0, Math.round((lum[idx]! * 255) / bg)));
      const out = lut[norm]!;
      const p = idx * 4;
      data[p] = out;
      data[p + 1] = out;
      data[p + 2] = out;
      data[p + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

async function maybeOptimizeImage(file: File): Promise<{ bytes: Uint8Array; mime?: string }> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || undefined;
  if (typeof createImageBitmap === "undefined") return { bytes: raw, mime };

  try {
    const bmp = await createImageBitmap(new Blob([raw], mime ? { type: mime } : {}));
    try {
      const maxSide = Math.max(bmp.width, bmp.height);
      const minSide = Math.max(1, Math.min(bmp.width, bmp.height));
      const pixels = bmp.width * bmp.height;
      const aspect = maxSide / minSide;

      // 嚴格訂定上限：一般單頁/跨頁上限長邊 2200px、總像素 310 萬；超長拼圖保護寬度並上限 3600px / 360 萬像素
      const limitSide = aspect > 2.5 ? 3600 : 2200;
      const limitPixels = aspect > 2.5 ? 3_600_000 : 3_100_000;
      const scale = Math.min(1, limitSide / maxSide, Math.sqrt(limitPixels / pixels));

      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));

      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) return { bytes: raw, mime };

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, 0, 0, w, h);

      // 消除光影、強化白底黑線對比
      enhanceScoreContrast(ctx, w, h);

      // 輸出無損 PNG（純白底黑白譜壓縮率極高，且無 JPEG 振鈴雜訊破壞細譜線）
      const pngBlob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/png"));
      if (pngBlob) {
        return { bytes: new Uint8Array(await pngBlob.arrayBuffer()), mime: "image/png" };
      }
      const jpgBlob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.92));
      if (!jpgBlob) return { bytes: raw, mime };
      return { bytes: new Uint8Array(await jpgBlob.arrayBuffer()), mime: "image/jpeg" };
    } finally {
      bmp.close();
    }
  } catch {
    return { bytes: raw, mime };
  }
}

export interface MountShellOptions {
  scorePane: HTMLElement;
  hiddenCodePane: HTMLElement;
  statusEl?: HTMLElement | null;
  playBtn?: HTMLButtonElement | null;
  stopBtn?: HTMLButtonElement | null;
  progressEl?: HTMLInputElement | null;
  timeEl?: HTMLElement | null;
  speedSel?: HTMLSelectElement | null;
  loopBtn?: HTMLButtonElement | null;
  metroBtn?: HTMLButtonElement | null;
  viewSwitch?: HTMLElement | null;
  viewBtns?: ReadonlyMap<ViewMode, HTMLButtonElement>;
  onZoomChange?: (zoom: number) => void;
  onRangeChange?: (state: { active: boolean; picking: boolean; hasStart: boolean }) => void;
}

let _appPromise: Promise<App> | null = null;
let _app: App | null = null;
let _scorePane: HTMLElement | null = null;
let _onZoomChange: ((z: number) => void) | undefined;
let _onRangeChange: MountShellOptions["onRangeChange"];
let _loadGen = 0;

// ---- 譜面直接選段 A-B 反覆循環 ----
let _abLoop: { first: PlayPoint; last: PlayPoint; tFrom: number; tTo: number } | null = null;
let _abPendingStart: ElementId | null = null;
let _rangePickMode = false;

function notifyRange() {
  _onRangeChange?.({
    active: _abLoop !== null,
    picking: _rangePickMode,
    hasStart: _abPendingStart !== null,
  });
}

function resolveNoteIdAt(el: Element | null): ElementId | null {
  if (!_app || !el) return null;
  if (_app.mode === "mixed") return _app.painter.noteAt(el);
  const entry = _app.syncView.entryAt(el);
  return entry && (entry.kind === "note" || entry.kind === "lyric" || entry.kind === "sustain") ? entry.id : null;
}

function getTimeline() {
  if (!_app) return null;
  const src = _app.playable();
  if (!src) return null;
  return timelineSeconds(src, _app.playback.options());
}

/** 觸控／滑鼠點擊容錯：若未直接點中音符 SVG，搜尋半徑內最近的音符 */
function findNearestNoteId(
  scorePane: HTMLElement,
  target: Element | null,
  clientX: number,
  clientY: number,
  maxRadiusPx = 32,
): ElementId | null {
  const direct = resolveNoteIdAt(target);
  if (direct !== null) return direct;

  const info = getTimeline();
  let bestId: ElementId | null = null;
  let bestDist = maxRadiusPx;

  for (const svg of scorePane.querySelectorAll<SVGSVGElement>(".score-page-wrap svg")) {
    const sr = svg.getBoundingClientRect();
    if (
      clientX < sr.left - maxRadiusPx ||
      clientX > sr.right + maxRadiusPx ||
      clientY < sr.top - maxRadiusPx ||
      clientY > sr.bottom + maxRadiusPx
    ) {
      continue;
    }

    for (const g of svg.querySelectorAll<SVGGElement>("g")) {
      const id = resolveNoteIdAt(g);
      if (id === null) continue;
      if (info && anchorSeconds(info.tl, info.spq, { id, pass: 1 }) === null) continue;
      const b = g.getBoundingClientRect();
      if (b.width <= 0 && b.height <= 0) continue;
      const dx = Math.max(b.left - clientX, 0, clientX - b.right);
      const dy = Math.max(b.top - clientY, 0, clientY - b.bottom);
      const dist = Math.hypot(dx, dy);
      if (dist <= bestDist) {
        bestDist = dist;
        bestId = id;
      }
    }
  }

  return bestId;
}

function clearAbBands() {
  _scorePane?.querySelectorAll(".sl-ab-band").forEach((el) => el.remove());
}

/** 將指定 SVG 元素的 local getBBox() 精確轉換到根 <svg> 座標系並合併外框 */
function unionBoxInSvgRoot(
  el: SVGGraphicsElement,
  invSvgCtm: DOMMatrix,
  acc: { minX: number; minY: number; maxX: number; maxY: number } | null,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const elCtm = el.getScreenCTM();
  if (!elCtm) return acc;
  let box: DOMRect;
  try {
    box = el.getBBox();
  } catch {
    return acc;
  }
  if (box.width <= 0 && box.height <= 0) return acc;

  const mat = invSvgCtm.multiply(elCtm);
  const x0 = box.x;
  const y0 = box.y;
  const x1 = box.x + box.width;
  const y1 = box.y + box.height;

  const pts: [number, number][] = [
    [mat.a * x0 + mat.c * y0 + mat.e, mat.b * x0 + mat.d * y0 + mat.f],
    [mat.a * x1 + mat.c * y0 + mat.e, mat.b * x1 + mat.d * y0 + mat.f],
    [mat.a * x0 + mat.c * y1 + mat.e, mat.b * x0 + mat.d * y1 + mat.f],
    [mat.a * x1 + mat.c * y1 + mat.e, mat.b * x1 + mat.d * y1 + mat.f],
  ];

  let out = acc;
  for (const [px, py] of pts) {
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    if (!out) {
      out = { minX: px, minY: py, maxX: px, maxY: py };
    } else {
      if (px < out.minX) out.minX = px;
      if (py < out.minY) out.minY = py;
      if (px > out.maxX) out.maxX = px;
      if (py > out.maxY) out.maxY = py;
    }
  }
  return out;
}

function paintAbBands() {
  clearAbBands();
  if (!_app || !_scorePane) return;
  if (!_abLoop && _abPendingStart === null) return;
  const info = _abLoop ? getTimeline() : null;
  const NS = "http://www.w3.org/2000/svg";

  for (const svg of _scorePane.querySelectorAll<SVGSVGElement>(".score-page-wrap svg")) {
    const svgCtm = svg.getScreenCTM();
    if (!svgCtm) continue;
    const invSvgCtm = svgCtm.inverse();

    // 以 ElementId 分組，合併每個音符的所有 SVG 部件（符頭、符桿等）為單一精確座標框
    const boxById = new Map<ElementId, { minX: number; minY: number; maxX: number; maxY: number }>();

    if (_app.mode === "mixed") {
      const seenIds = new Set<ElementId>();
      for (const g of svg.querySelectorAll<SVGGElement>("g")) {
        const id = _app.painter.noteAt(g);
        if (id === null || seenIds.has(id)) continue;
        seenIds.add(id);

        let hit = false;
        if (_abPendingStart !== null && id === _abPendingStart) hit = true;
        else if (_abLoop && info) {
          const t = anchorSeconds(info.tl, info.spq, { id, pass: 1 });
          if (t !== null && t >= _abLoop.tFrom - 0.002 && t <= _abLoop.tTo + 0.002) hit = true;
        }
        if (!hit) continue;

        let merged: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
        for (const nel of _app.painter.noteEls(id)) {
          if (nel.ownerSVGElement === svg) {
            merged = unionBoxInSvgRoot(nel, invSvgCtm, merged);
          }
        }
        if (merged) boxById.set(id, merged);
      }
    } else {
      for (const g of svg.querySelectorAll<SVGGElement>("g")) {
        const entry = _app.syncView.entryAt(g);
        if (!entry || entry.kind !== "note") continue;
        const id = entry.id;

        let hit = false;
        if (_abPendingStart !== null && id === _abPendingStart) hit = true;
        else if (_abLoop && info) {
          const t = anchorSeconds(info.tl, info.spq, { id, pass: 1 });
          if (t !== null && t >= _abLoop.tFrom - 0.002 && t <= _abLoop.tTo + 0.002) hit = true;
        }
        if (!hit) continue;

        const merged = unionBoxInSvgRoot(g, invSvgCtm, boxById.get(id) ?? null);
        if (merged) boxById.set(id, merged);
      }
    }

    for (const [id, b] of boxById) {
      const width = b.maxX - b.minX;
      const height = b.maxY - b.minY;
      if (width <= 0 && height <= 0) continue;

      const pad = 4;
      const isPending = _abPendingStart !== null && id === _abPendingStart;
      const isEndpoint = _abLoop !== null && (id === _abLoop.first.id || id === _abLoop.last.id);

      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("class", "sl-ab-band");
      rect.setAttribute("x", String(b.minX - pad));
      rect.setAttribute("y", String(b.minY - pad));
      rect.setAttribute("width", String(width + pad * 2));
      rect.setAttribute("height", String(height + pad * 2));
      rect.setAttribute("rx", "4");

      if (isPending) {
        rect.setAttribute("fill", "rgba(184, 139, 74, 0.28)");
        rect.setAttribute("stroke", "#b88b4a");
        rect.setAttribute("stroke-width", "1.6");
      } else if (isEndpoint) {
        rect.setAttribute("fill", "rgba(91, 122, 98, 0.25)");
        rect.setAttribute("stroke", "#5b7a62");
        rect.setAttribute("stroke-width", "1.6");
      } else {
        rect.setAttribute("fill", "rgba(91, 122, 98, 0.16)");
        rect.setAttribute("stroke", "none");
      }
      rect.setAttribute("pointer-events", "none");
      svg.appendChild(rect);
    }
  }
}

function clearAbLoop(stopLoopToggle = true) {
  _abLoop = null;
  _abPendingStart = null;
  _rangePickMode = false;
  clearAbBands();
  if (_app && stopLoopToggle) {
    _app.playback.setLoop(false);
  }
  notifyRange();
}

function applyAbLoopByIds(idA: ElementId, idB: ElementId): boolean {
  if (!_app) return false;
  const info = getTimeline();
  if (!info) return false;
  const tA = anchorSeconds(info.tl, info.spq, { id: idA, pass: 1 });
  const tB = anchorSeconds(info.tl, info.spq, { id: idB, pass: 1 });
  if (tA === null || tB === null) return false;

  let firstId = idA, lastId = idB, tFrom = tA, tTo = tB;
  if (tA > tB) {
    firstId = idB; lastId = idA; tFrom = tB; tTo = tA;
  }
  const span = spanSeconds(info.tl, info.spq, { id: firstId, pass: 1 }, { id: lastId, pass: 1 });
  if (!span || span.to <= span.from) return false;

  _abLoop = { first: { id: firstId, pass: 1 }, last: { id: lastId, pass: 1 }, tFrom, tTo };
  _abPendingStart = null;
  _rangePickMode = false;
  paintAbBands();
  _app.playback.setLoop(true);
  _app.playback.seekTo({ id: firstId, pass: 1 });
  if (!_app.playback.busy) void _app.playback.play();
  notifyRange();
  return true;
}

function wireDirectScoreSelection(scorePane: HTMLElement) {
  let dragStart: { x: number; y: number } | null = null;
  let dragging = false;
  let suppressClick = false;
  let marqueeEl: HTMLDivElement | null = null;

  const removeMarquee = () => {
    marqueeEl?.remove();
    marqueeEl = null;
  };

  const resetDrag = () => {
    dragStart = null;
    dragging = false;
    removeMarquee();
  };

  // 滑鼠支援直接框選；觸控螢幕保留原生捲動與雙指縮放，並透過「點選起點 → 點選終點」操作
  scorePane.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.pointerType === "touch") return;
    const rc = scorePane.getBoundingClientRect();
    if (e.clientX - rc.left >= scorePane.clientLeft + scorePane.clientWidth) return;
    dragStart = { x: e.clientX, y: e.clientY };
    dragging = false;
  }, true);

  window.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (!dragging && Math.hypot(dx, dy) < 9) return;
    if (!dragging) {
      dragging = true;
      marqueeEl = document.createElement("div");
      marqueeEl.style.cssText =
        "position:fixed;pointer-events:none;z-index:9999;border:1.5px solid #5b7a62;" +
        "background:rgba(91,122,98,0.18);border-radius:4px;";
      document.body.appendChild(marqueeEl);
    }
    if (marqueeEl) {
      marqueeEl.style.left = `${Math.min(dragStart.x, e.clientX)}px`;
      marqueeEl.style.top = `${Math.min(dragStart.y, e.clientY)}px`;
      marqueeEl.style.width = `${Math.abs(dx)}px`;
      marqueeEl.style.height = `${Math.abs(dy)}px`;
    }
  });

  window.addEventListener("pointercancel", resetDrag);

  window.addEventListener("pointerup", (e) => {
    if (!dragStart) return;
    const start = dragStart;
    dragStart = null;
    if (!dragging) return;
    dragging = false;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 50);
    removeMarquee();

    if (!_app) return;
    const info = getTimeline();
    if (!info) return;

    const rLeft = Math.min(start.x, e.clientX);
    const rRight = Math.max(start.x, e.clientX);
    const rTop = Math.min(start.y, e.clientY);
    const rBottom = Math.max(start.y, e.clientY);

    let minId: ElementId | null = null, minT = Infinity;
    let maxId: ElementId | null = null, maxT = -Infinity;
    const seenIds = new Set<ElementId>();

    for (const g of scorePane.querySelectorAll<SVGGElement>(".score-page-wrap svg g")) {
      const id = resolveNoteIdAt(g);
      if (id === null || seenIds.has(id)) continue;
      const b = g.getBoundingClientRect();
      if (b.width <= 0 && b.height <= 0) continue;
      if (b.right < rLeft || b.left > rRight || b.bottom < rTop || b.top > rBottom) continue;
      seenIds.add(id);
      const t = anchorSeconds(info.tl, info.spq, { id, pass: 1 });
      if (t === null) continue;
      if (t < minT) { minT = t; minId = id; }
      if (t > maxT) { maxT = t; maxId = id; }
    }

    if (minId !== null && maxId !== null && maxT > minT) {
      applyAbLoopByIds(minId, maxId);
    } else if (minId !== null) {
      _abLoop = null;
      _abPendingStart = minId;
      _rangePickMode = true;
      paintAbBands();
      notifyRange();
    }
  });

  scorePane.addEventListener("click", (e) => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
      return;
    }
    if (!_rangePickMode) return;

    // 選段模式中攔截樂譜點擊，並提供 32px 觸控寬容半徑
    e.stopPropagation();
    e.preventDefault();

    const id = findNearestNoteId(scorePane, e.target as Element | null, e.clientX, e.clientY, 32);
    if (id === null) return;

    if (_abPendingStart === null) {
      _abLoop = null;
      _abPendingStart = id;
      paintAbBands();
      notifyRange();
    } else if (_abPendingStart === id) {
      // 再次點擊同一個起點可取消重選起點
      _abPendingStart = null;
      paintAbBands();
      notifyRange();
    } else {
      applyAbLoopByIds(_abPendingStart, id);
    }
  }, true);
}

/** 守護純 SVG 按鍵圖示，避免官方控制器切換狀態時覆蓋為文字 */
function preserveIconButton(btn: HTMLButtonElement | null | undefined) {
  if (!btn) return;
  const svgHtml = btn.innerHTML;
  if (!svgHtml.includes("<svg")) return;
  const observer = new MutationObserver(() => {
    if (!btn.querySelector("svg")) {
      btn.innerHTML = svgHtml;
    }
  });
  observer.observe(btn, { childList: true });
}

async function initEngine(opts: MountShellOptions): Promise<App> {
  _onZoomChange = opts.onZoomChange;
  _onRangeChange = opts.onRangeChange;
  _scorePane = opts.scorePane;
  if (_app) return _app;
  if (_appPromise) return _appPromise;

  _appPromise = (async () => {
    initLang();
    setMeasureBackend(browserMeasure);
    await registerBravura();
    await ensureFontsReady([
      { family: "Bravura", size: 40 },
      { family: "Bravura Text", size: 20 },
      { family: "Noto Serif TC", size: 28 },
    ]);
    const meta = await MetaData.shared();

    const app = new App(meta, opts.scorePane);
    app.statusEl = opts.statusEl ?? null;
    app.loadSettings();
    app.mountEditor(opts.hiddenCodePane, SAMPLE);
    app.stopPlayback();
    app.clearPages();

    // 接管 loopPoints：有譜面直選 A-B 選段時，直接讓官方 PlaybackController 反覆播放該段
    const origLoopPoints = app.loopPoints.bind(app);
    app.loopPoints = () => (_abLoop ? { first: _abLoop.first, last: _abLoop.last } : origLoopPoints());

    if (opts.playBtn) {
      app.playback.setPlaybackBtn(opts.playBtn);
      opts.playBtn.addEventListener("click", () => void app.playback.toggle());
    }
    if (opts.stopBtn) app.playback.setStopBtn(opts.stopBtn);
    if (opts.progressEl) app.playback.bindProgress(opts.progressEl, opts.timeEl ?? null);
    if (opts.speedSel) app.playback.bindSpeedSelect(opts.speedSel);

    preserveIconButton(opts.loopBtn);
    preserveIconButton(opts.metroBtn);
    app.playback.bindToggles(opts.loopBtn ?? null, opts.metroBtn ?? null);

    if (opts.viewBtns) {
      for (const [mode, btn] of opts.viewBtns) {
        btn.addEventListener("click", async () => {
          clearAbLoop(false);
          await app.setViewMode(mode);
        });
      }
      if (opts.viewSwitch) app.setViewModeButtons(opts.viewSwitch, opts.viewBtns);
    }

    attachPinchZoom(opts.scorePane, {
      get: () => app.zoom,
      set: (z) => app.setZoom(z),
      pages: () => opts.scorePane.querySelectorAll(".score-page-wrap"),
      onChange: () => _onZoomChange?.(app.zoom),
    });
    _onZoomChange?.(app.zoom);
    wireDirectScoreSelection(opts.scorePane);
    notifyRange();

    void import("./omrkit/runtime.browser").then((m) => m.browserRuntime.prepare("det")).catch(() => {});

    _app = app;
    return app;
  })();

  return _appPromise;
}

async function recognizeAndRender(
  filesInput: File | readonly File[],
  opts: {
    kind?: OmrKind;
    onProgress?: (msg: string) => void;
    onFirstPageReady?: () => void;
  } = {},
): Promise<{ engine: string; info: string }> {
  if (!_app) throw new Error("請先初始化引擎");
  const files = Array.isArray(filesInput) ? [...filesInput] : [filesInput as File];
  if (!files.length) throw new Error("未選擇任何檔案");

  const myGen = ++_loadGen;
  clearAbLoop(true);
  _app.stopPlayback();
  _app.clearPages();

  const kind: OmrKind = opts.kind ?? "auto";
  const onProgress = opts.onProgress ?? (() => undefined);
  const first = files[0]!;
  const firstName = first.name.toLowerCase();

  // 單一非圖片/PDF 譜檔直接由官方解析渲染
  if (files.length === 1 && !firstName.endsWith(".pdf") && !/\.(png|jpe?g|webp)$/i.test(firstName)) {
    const bytes = new Uint8Array(await first.arrayBuffer());
    _app.importBytes(bytes, first.name);
    await _app.whenIdle();
    if (/\.(xml|musicxml)$/i.test(firstName) && _app.mode === "jp") {
      await _app.setViewMode("staff");
    }
    if (_app.pageEls.length === 0) {
      throw new Error(_app.status || "無法解析此樂譜檔案");
    }
    return { engine: "native-doc", info: "" };
  }

  let xml = "";
  let engine = "";

  // 1. 單一 PDF 矢量 / 轉曲五線譜
  if (files.length === 1 && kind !== "jianpu") {
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    if (isPdf(firstBytes, first.type || undefined)) {
      onProgress("分析 PDF 結構中...");
      const sb = await import("./staffomr/browser");
      let pdfDoc: Awaited<ReturnType<typeof sb.openStaffPdf>> | null = null;
      try {
        pdfDoc = await sb.openStaffPdf(firstBytes);
      } catch {
        pdfDoc = null;
      }
      if (pdfDoc) {
        try {
          if (await sb.isStaffPdf(pdfDoc.pdf, pdfDoc.OPS)) {
            const res = await sb.recognizeStaffPdf(pdfDoc, {
              onProgress: (d, t) => onProgress(`辨識第 ${d}/${t} 頁...`),
              noteIds: false,
            });
            if (myGen !== _loadGen) return { engine: "cancelled", info: "" };
            if (res.notes > 0 && res.musicxml) {
              xml = res.musicxml;
              engine = "vector-staff";
            }
          } else {
            const ob = await import("./outlineomr/browser");
            if (await ob.isOutlinedStaffPdf(pdfDoc.pdf, pdfDoc.OPS)) {
              const res = await ob.recognizeOutlinedPdf(pdfDoc, {
                onProgress: (d, t) => onProgress(`辨識第 ${d}/${t} 頁...`),
                noteIds: false,
              });
              if (myGen !== _loadGen) return { engine: "cancelled", info: "" };
              if (res.notes > 0 && res.musicxml) {
                xml = res.musicxml;
                engine = "outlined-staff";
              }
            }
          }
        } finally {
          pdfDoc.pdf.destroy?.();
        }
      }
    }
  }

  // 2. 位圖五線譜（支援多張圖片：先辨識第 1 頁立即顯示，再補齊全曲）
  if (!xml && kind !== "jianpu") {
    onProgress("載入樂譜引擎...");
    const rb = await import("./rasteromr/browser");
    const rasterPdfs: Uint8Array[] = [];

    for (let i = 0; i < files.length; i++) {
      if (myGen !== _loadGen) return { engine: "cancelled", info: "" };
      const f = files[i]!;
      onProgress(files.length > 1 ? `強化第 ${i + 1}/${files.length} 頁圖檔...` : "強化圖檔對比中...");
      const isImg = /\.(png|jpe?g|webp)$/i.test(f.name) || f.type.startsWith("image/");
      const opt = isImg ? await maybeOptimizeImage(f) : { bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type || undefined };
      rasterPdfs.push(await rb.asRasterPdf(opt.bytes, opt.mime));
    }

    if (myGen !== _loadGen) return { engine: "cancelled", info: "" };
    onProgress("分析譜表結構...");
    const probe = kind === "staff" ? null : await rb.probeRasterStaff(rasterPdfs[0]!);

    if (!probe || probe.isStaff) {
      let showedFirst = false;

      if (rasterPdfs.length > 1) {
        onProgress("辨識第 1 頁中...");
        const firstRes = await rb.recognizeRasterPdfs([rasterPdfs[0]!], {
          ...(probe?.pages ? { firstPages: new Map(probe.pages) } : {}),
          cancelled: () => myGen !== _loadGen,
        });
        if (myGen !== _loadGen) return { engine: "cancelled", info: "" };
        if (firstRes.xml && _app.adoptStaffXml(firstRes.xml)) {
          await _app.setViewMode("staff");
          await _app.whenIdle();
          if (_app.pageEls.length > 0) {
            showedFirst = true;
            opts.onFirstPageReady?.();
          }
        }
      }

      onProgress(showedFirst ? `第 1 頁已顯示，辨識其餘 ${rasterPdfs.length - 1} 頁中...` : "辨識樂譜中...");
      const res = await rb.recognizeRasterPdfs(rasterPdfs, {
        onPage: (d, t) => onProgress(showedFirst ? `第 1 頁已就緒，處理第 ${d}/${t} 頁...` : `辨識第 ${d}/${t} 頁...`),
        cancelled: () => myGen !== _loadGen,
        ...(probe?.pages ? { firstPages: new Map(probe.pages) } : {}),
      });
      if (myGen !== _loadGen) return { engine: "cancelled", info: "" };

      if (res.xml) {
        xml = res.xml;
        engine = "raster-staff";
      } else if (kind === "staff") {
        throw new Error("未偵測到五線譜");
      }
    }
  }

  // 3. 簡譜圖片 / 掃描簡譜 PDF
  if (!xml) {
    onProgress("辨識簡譜中...");
    const isImg = /\.(png|jpe?g|webp)$/i.test(first.name) || first.type.startsWith("image/");
    const opt = isImg ? await maybeOptimizeImage(first) : { bytes: new Uint8Array(await first.arrayBuffer()), mime: first.type || undefined };
    const { score } = await recognizeMusicppDetailed(opt.bytes, opt.mime);
    if (myGen !== _loadGen) return { engine: "cancelled", info: "" };
    const out = omrEmitter("123").emit(score);
    if (out.kind !== "123") {
      throw new Error("簡譜轉出異常");
    }
    xml = scoreDocToMusicXml(out.doc);
    engine = "jianpu";
  }

  const keepView = _app.pageEls.length > 0 ? _app.viewMode : null;
  if (!_app.adoptStaffXml(xml)) {
    throw new Error(_app.status || "樂譜無法渲染");
  }
  if (keepView) {
    await _app.setViewMode(keepView);
  } else if (engine === "jianpu") {
    await _app.setViewMode("expanded");
  } else {
    await _app.setViewMode("staff");
  }
  await _app.whenIdle();
  if (_app.pageEls.length === 0) {
    throw new Error(_app.status || "樂譜渲染失敗");
  }

  return { engine, info: "" };
}

declare global {
  interface Window {
    __dolceEngine?: {
      mount: typeof initEngine;
      loadFile: typeof recognizeAndRender;
      loadFiles: typeof recognizeAndRender;
      loadXmlText: (xml: string, viewMode?: ViewMode) => Promise<void>;
      getSnapshot: () => ScoreSnapshot | null;
      loadSnapshot: (snap: Pick<ScoreSnapshot, "format" | "text" | "viewMode">) => Promise<void>;
      toggleRangePick: () => void;
      clearRangeLoop: () => void;
      setViewMode: (m: ViewMode) => Promise<void>;
      exportXml: () => Promise<string>;
      zoomBy: (f: number) => void;
      resetZoom: () => void;
      prevPage: () => void;
      nextPage: () => void;
      stopPlayback: () => void;
      getApp: () => App | null;
    };
  }
}

window.__dolceEngine = {
  mount: initEngine,
  loadFile: recognizeAndRender,
  loadFiles: recognizeAndRender,
  async loadXmlText(xml, viewMode = "staff") {
    if (!_app) return;
    _loadGen++;
    clearAbLoop(true);
    _app.stopPlayback();
    _app.clearPages();
    if (!_app.adoptStaffXml(xml)) {
      throw new Error(_app.status || "樂譜無法渲染");
    }
    await _app.setViewMode(viewMode);
    await _app.whenIdle();
    if (_app.pageEls.length === 0) {
      throw new Error(_app.status || "樂譜渲染失敗");
    }
  },
  getSnapshot() {
    if (!_app || _app.pageEls.length === 0) return null;
    const rawTitle = (_app.documentTitle() || "").trim();
    const title = rawTitle && rawTitle !== "未命名" ? rawTitle : "已儲存樂譜";
    return {
      title,
      format: _app.docFormat,
      text: _app.getText(),
      viewMode: _app.viewMode,
    };
  },
  async loadSnapshot(snap) {
    if (!_app) return;
    _loadGen++;
    clearAbLoop(true);
    _app.stopPlayback();
    _app.clearPages();
    if (snap.format === "musicxml") {
      if (!_app.adoptStaffXml(snap.text)) {
        throw new Error(_app.status || "收藏樂譜無法渲染");
      }
    } else {
      _app.adoptText(snap.format, snap.text, null);
    }
    const targetMode = snap.viewMode === "original" ? "expanded" : snap.viewMode;
    await _app.setViewMode(targetMode);
    await _app.whenIdle();
    if (_app.pageEls.length === 0) {
      throw new Error(_app.status || "樂譜渲染失敗");
    }
  },
  toggleRangePick() {
    _rangePickMode = !_rangePickMode;
    if (!_rangePickMode) _abPendingStart = null;
    paintAbBands();
    notifyRange();
  },
  clearRangeLoop() {
    clearAbLoop(true);
  },
  async setViewMode(m) {
    if (!_app) return;
    clearAbLoop(false);
    await _app.setViewMode(m);
  },
  async exportXml() {
    return _app ? _app.musicXmlForSave() : "";
  },
  zoomBy(f) {
    if (!_app) return;
    _app.zoomBy(f);
    _onZoomChange?.(_app.zoom);
  },
  resetZoom() {
    if (!_app) return;
    _app.resetZoom();
    _onZoomChange?.(_app.zoom);
  },
  prevPage() {
    _app?.prevPage();
  },
  nextPage() {
    _app?.nextPage();
  },
  stopPlayback() {
    _app?.stopPlayback();
  },
  getApp: () => _app,
};
window.dispatchEvent(new Event("dolce-engine-ready"));
