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

      enhanceScoreContrast(ctx, w, h);

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
let _abPreviewRange: { startId: ElementId; endId: ElementId; tFrom: number; tTo: number } | null = null;
let _rangePickMode = false;

function notifyRange() {
  _onRangeChange?.({
    active: _abLoop !== null,
    picking: _rangePickMode,
    hasStart: _abPendingStart !== null || _abPreviewRange !== null,
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

/** 觸控／滑鼠容錯：搜尋點擊／拖曳座標半徑內最近的音符 */
function findNearestNoteId(
  scorePane: HTMLElement,
  target: Element | null,
  clientX: number,
  clientY: number,
  maxRadiusPx = 34,
): ElementId | null {
  const direct = resolveNoteIdAt(target);
  const info = getTimeline();
  if (direct !== null) {
    if (!info || anchorSeconds(info.tl, info.spq, { id: direct, pass: 1 }) !== null) {
      return direct;
    }
  }

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

// ---- 隱藏粉紅／紅色拍數診斷色塊與 +♩ 徽章（嚴格保護橙色動態播放游標） ----
function parseRgbColor(colorStr: string | null | undefined): [number, number, number, number] | null {
  if (!colorStr || colorStr === "none" || colorStr === "transparent") return null;
  const m = colorStr.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
}

/** 僅匹配粉紅／深紅診斷色（g 與 b 相近或 b 偏高），絕對排除橙色（g 明顯大於 b） */
function isPinkDiagnosticColor(colorStr: string | null | undefined): boolean {
  const c = parseRgbColor(colorStr);
  if (!c || c[3] <= 0.01) return false;
  const [r, g, b] = c;
  return r >= 165 && r - g >= 45 && g <= b + 28;
}

/** 匹配橙色動態播放游標（紅偏高、綠明顯高於藍） */
function isOrangeCursorColor(colorStr: string | null | undefined): boolean {
  const c = parseRgbColor(colorStr);
  if (!c || c[3] <= 0.01) return false;
  const [r, g, b] = c;
  return r >= 165 && g >= 60 && g <= 195 && b <= 140 && g - b >= 22 && r - g >= 15;
}

function isProtectedCursorEl(el: Element): boolean {
  if (el.classList.contains("sl-sustain-cursor")) return true;
  if (el.closest("[class*='cursor' i], [class*='playhead' i], [class*='caret' i]")) {
    return true;
  }
  const st = getComputedStyle(el);
  if (
    isOrangeCursorColor(st.stroke) ||
    isOrangeCursorColor(st.fill) ||
    isOrangeCursorColor(st.borderColor) ||
    isOrangeCursorColor(st.backgroundColor)
  ) {
    return true;
  }
  return false;
}

function hideDiagnosticOverlays(scorePane: HTMLElement): void {
  const pages = scorePane.querySelectorAll<HTMLElement>(".score-page-wrap");
  for (const page of pages) {
    for (const svg of page.querySelectorAll<SVGSVGElement>("svg")) {
      for (const rect of svg.querySelectorAll<SVGRectElement>("rect")) {
        if (
          rect.classList.contains("sl-ab-band") ||
          rect.classList.contains("sl-ab-marker") ||
          rect.classList.contains("sl-sustain-cursor")
        ) {
          continue;
        }
        if (isProtectedCursorEl(rect)) continue;
        const st = getComputedStyle(rect);
        const dash = rect.getAttribute("stroke-dasharray") || st.strokeDasharray;
        const hasDash = Boolean(dash && dash !== "none");
        if (!hasDash) continue;
        const pinkStroke = isPinkDiagnosticColor(st.stroke) || isPinkDiagnosticColor(rect.getAttribute("stroke"));
        const pinkFill = isPinkDiagnosticColor(st.fill) || isPinkDiagnosticColor(rect.getAttribute("fill"));
        if (pinkStroke || pinkFill) {
          rect.style.display = "none";
        }
      }

      for (const txt of svg.querySelectorAll<SVGTextElement>("text")) {
        if (isProtectedCursorEl(txt)) continue;
        const st = getComputedStyle(txt);
        const pink = isPinkDiagnosticColor(st.fill) || isPinkDiagnosticColor(txt.getAttribute("fill"));
        if (!pink) continue;
        const content = (txt.textContent || "").trim();
        if (/^[+\-−]/.test(content) || /[♩♪♫♬𝅝𝅗𝅥𝅘𝅥𝅘𝅥𝅮𝅘𝅥𝅯]/.test(content) || content.length <= 6) {
          txt.style.display = "none";
          const parentG = txt.parentElement;
          if (parentG && parentG.tagName.toLowerCase() === "g" && parentG.children.length <= 4) {
            for (const child of parentG.children) {
              if (isProtectedCursorEl(child)) continue;
              const cst = getComputedStyle(child);
              if (isPinkDiagnosticColor(cst.fill) || isPinkDiagnosticColor(cst.stroke)) {
                (child as SVGElement).style.display = "none";
              }
            }
          }
        }
      }

      for (const g of svg.querySelectorAll<SVGGElement>("g")) {
        if (isProtectedCursorEl(g)) continue;
        const cls = (g.getAttribute("class") || "").toLowerCase();
        if (/(err|warn|mismatch|overfill|underfill|beat-diff|diag)/.test(cls)) {
          const id = resolveNoteIdAt(g);
          if (id === null) g.style.display = "none";
        }
      }
    }

    for (const el of page.querySelectorAll<HTMLElement>("div, span")) {
      if (
        el.classList.contains("sl-ab-band") ||
        el.classList.contains("sl-ab-marker") ||
        el.classList.contains("sl-sustain-cursor")
      ) {
        continue;
      }
      if (isProtectedCursorEl(el)) continue;
      const st = getComputedStyle(el);
      const dashedPink = st.borderStyle.includes("dashed") && isPinkDiagnosticColor(st.borderColor);
      const badgeText = (el.textContent || "").trim();
      const pinkBadge =
        isPinkDiagnosticColor(st.color) && (/^[+\-−]/.test(badgeText) || /[♩♪♫𝅗𝅥𝅘𝅥𝅘𝅥𝅮]/.test(badgeText));
      if (dashedPink || pinkBadge) {
        el.style.display = "none";
      }
    }
  }
}

// ---- 座標轉換工具 ----
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

function clientRectToSvgRoot(
  rect: DOMRect,
  invSvgCtm: DOMMatrix,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts: [number, number][] = [
    [invSvgCtm.a * rect.left + invSvgCtm.c * rect.top + invSvgCtm.e, invSvgCtm.b * rect.left + invSvgCtm.d * rect.top + invSvgCtm.f],
    [invSvgCtm.a * rect.right + invSvgCtm.c * rect.top + invSvgCtm.e, invSvgCtm.b * rect.right + invSvgCtm.d * rect.top + invSvgCtm.f],
    [invSvgCtm.a * rect.left + invSvgCtm.c * rect.bottom + invSvgCtm.e, invSvgCtm.b * rect.left + invSvgCtm.d * rect.bottom + invSvgCtm.f],
    [invSvgCtm.a * rect.right + invSvgCtm.c * rect.bottom + invSvgCtm.e, invSvgCtm.b * rect.right + invSvgCtm.d * rect.bottom + invSvgCtm.f],
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of pts) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  return { minX, minY, maxX, maxY };
}

// ---- 播放游標偵測 ＋ 簡譜延音橫線（-）動態游標推進 ＋ 換行防截斷守護 ----
let _playbackGuardRaf = 0;
let _hiddenCursorEl: HTMLElement | SVGElement | null = null;
let _sustainState: {
  key: string;
  enterMs: number;
  durSec: number;
  lastCursorLeft: number;
} | null = null;

function findOfficialPlaybackCursor(scorePane: HTMLElement): { el: HTMLElement | SVGElement; rect: DOMRect } | null {
  for (const page of scorePane.querySelectorAll<HTMLElement>(".score-page-wrap")) {
    for (const el of page.querySelectorAll<HTMLElement | SVGElement>("[class*='cursor' i], [class*='playhead' i]")) {
      if (
        el.classList.contains("sl-ab-band") ||
        el.classList.contains("sl-ab-marker") ||
        el.classList.contains("sl-sustain-cursor")
      ) {
        continue;
      }
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height >= 12) return { el, rect: r };
    }
    for (const rect of page.querySelectorAll<SVGRectElement>("svg rect")) {
      if (
        rect.classList.contains("sl-ab-band") ||
        rect.classList.contains("sl-ab-marker") ||
        rect.classList.contains("sl-sustain-cursor")
      ) {
        continue;
      }
      const st = getComputedStyle(rect);
      if (st.display === "none" || st.visibility === "hidden") continue;
      if (!isOrangeCursorColor(st.stroke) && !isOrangeCursorColor(st.fill)) continue;
      const r = rect.getBoundingClientRect();
      if (r.width > 1 && r.width <= 60 && r.height >= 16) return { el: rect, rect: r };
    }
    for (const div of page.querySelectorAll<HTMLElement>("div")) {
      const st = getComputedStyle(div);
      if (st.display === "none" || st.visibility === "hidden") continue;
      if (!isOrangeCursorColor(st.borderColor) && !isOrangeCursorColor(st.backgroundColor)) continue;
      const r = div.getBoundingClientRect();
      if (r.width > 1 && r.width <= 60 && r.height >= 16) return { el: div, rect: r };
    }
  }
  return null;
}

function cleanupSustainCursor(scorePane?: HTMLElement | null) {
  if (_hiddenCursorEl) {
    _hiddenCursorEl.style.opacity = "";
    _hiddenCursorEl = null;
  }
  scorePane?.querySelectorAll(".sl-sustain-cursor").forEach((el) => el.remove());
  _sustainState = null;
}

function findSustainBoxesForNote(
  svg: SVGSVGElement,
  invSvgCtm: DOMMatrix,
  noteId: ElementId,
  noteBox: { minX: number; minY: number; maxX: number; maxY: number },
): { minX: number; minY: number; maxX: number; maxY: number }[] {
  if (!_app) return [];

  const noteMidY = (noteBox.minY + noteBox.maxY) * 0.5;
  const noteH = Math.max(16, noteBox.maxY - noteBox.minY);
  const rowTol = Math.max(24, noteH * 0.95);

  const sameIdSustains: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
  const nearbySustains: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
  let nextNoteMinX = Infinity;

  for (const g of svg.querySelectorAll<SVGGElement>("g")) {
    const entry = _app.syncView.entryAt(g);
    if (!entry) continue;
    const b = unionBoxInSvgRoot(g, invSvgCtm, null);
    if (!b) continue;
    const midY = (b.minY + b.maxY) * 0.5;
    if (Math.abs(midY - noteMidY) > rowTol) continue;

    if ((entry.kind === "note" || entry.kind === "rest") && entry.id !== noteId) {
      if (b.minX > noteBox.maxX - 2 && b.minX < nextNoteMinX) {
        nextNoteMinX = b.minX;
      }
      continue;
    }

    if (entry.kind === "sustain") {
      if (entry.id === noteId) {
        sameIdSustains.push(b);
      } else if (b.minX > noteBox.maxX - 4) {
        nearbySustains.push(b);
      }
    }
  }

  let chosen =
    sameIdSustains.length > 0
      ? sameIdSustains
      : nearbySustains.filter((b) => b.maxX <= nextNoteMinX + 4);

  // 若 syncView 未將橫線標為 sustain，退而偵測同行中位於主音符與下一音符之間的 "-" 橫線
  if (chosen.length === 0) {
    const dashTexts: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
    for (const txt of svg.querySelectorAll<SVGTextElement>("text")) {
      const content = (txt.textContent || "").trim();
      if (content !== "-" && content !== "–" && content !== "—" && content !== "−") continue;
      const b = unionBoxInSvgRoot(txt, invSvgCtm, null);
      if (!b) continue;
      const midY = (b.minY + b.maxY) * 0.5;
      if (Math.abs(midY - noteMidY) <= rowTol && b.minX > noteBox.maxX - 2 && b.maxX <= nextNoteMinX + 4) {
        dashTexts.push(b);
      }
    }
    chosen = dashTexts;
  }

  chosen.sort((a, b) => a.minX - b.minX);
  return chosen;
}

function updateSustainCursor(
  scorePane: HTMLElement,
  cursor: { el: HTMLElement | SVGElement; rect: DOMRect },
): DOMRect | null {
  if (!_app || _app.mode === "mixed") {
    cleanupSustainCursor(scorePane);
    return null;
  }

  const page = cursor.el.closest<HTMLElement>(".score-page-wrap");
  const svg =
    cursor.el instanceof SVGElement
      ? cursor.el.ownerSVGElement
      : page?.querySelector<SVGSVGElement>("svg") ?? null;
  if (!svg) {
    cleanupSustainCursor(scorePane);
    return null;
  }

  const svgCtm = svg.getScreenCTM();
  if (!svgCtm) return null;
  const invSvgCtm = svgCtm.inverse();

  // 找出游標當下所在的簡譜主音符（note）
  let matchedId: ElementId | null = null;
  let matchedBox: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  let bestScore = Infinity;
  const curCenterX = (cursor.rect.left + cursor.rect.right) * 0.5;

  for (const g of svg.querySelectorAll<SVGGElement>("g")) {
    const entry = _app.syncView.entryAt(g);
    if (!entry || entry.kind !== "note") continue;
    const gr = g.getBoundingClientRect();
    if (gr.width <= 0 && gr.height <= 0) continue;
    if (
      gr.right < cursor.rect.left - 6 ||
      gr.left > cursor.rect.right + 6 ||
      gr.bottom < cursor.rect.top - 6 ||
      gr.top > cursor.rect.bottom + 6
    ) {
      continue;
    }
    const dist = Math.abs((gr.left + gr.right) * 0.5 - curCenterX);
    if (dist < bestScore) {
      const box = unionBoxInSvgRoot(g, invSvgCtm, null);
      if (box) {
        bestScore = dist;
        matchedId = entry.id;
        matchedBox = box;
      }
    }
  }

  if (matchedId === null || !matchedBox) {
    cleanupSustainCursor(scorePane);
    return null;
  }

  const sustainBoxes = findSustainBoxesForNote(svg, invSvgCtm, matchedId, matchedBox);
  if (sustainBoxes.length === 0) {
    cleanupSustainCursor(scorePane);
    return null;
  }

  const info = getTimeline();
  if (!info) {
    cleanupSustainCursor(scorePane);
    return null;
  }
  const span = spanSeconds(info.tl, info.spq, { id: matchedId, pass: 1 }, { id: matchedId, pass: 1 });
  if (!span || span.to <= span.from) {
    cleanupSustainCursor(scorePane);
    return null;
  }

  const durSec = Math.max(0.08, span.to - span.from);
  const pageIdx = Array.from(scorePane.querySelectorAll(".score-page-wrap")).indexOf(page ?? svg);
  const noteKey = `${pageIdx}:${matchedId}`;
  const nowMs = performance.now();

  if (
    !_sustainState ||
    _sustainState.key !== noteKey ||
    Math.abs(cursor.rect.left - _sustainState.lastCursorLeft) > 8 ||
    (nowMs - _sustainState.enterMs) / 1000 > durSec + 0.12
  ) {
    _sustainState = {
      key: noteKey,
      enterMs: nowMs,
      durSec,
      lastCursorLeft: cursor.rect.left,
    };
  } else {
    _sustainState.durSec = durSec;
  }

  const elapsedSec = (nowMs - _sustainState.enterMs) / 1000;
  const totalSteps = sustainBoxes.length + 1;
  const step = Math.min(sustainBoxes.length, Math.max(0, Math.floor((elapsedSec / durSec) * totalSteps)));

  if (step === 0) {
    if (_hiddenCursorEl) {
      _hiddenCursorEl.style.opacity = "";
      _hiddenCursorEl = null;
    }
    svg.querySelectorAll(".sl-sustain-cursor").forEach((el) => el.remove());
    return null;
  }

  const targetDash = sustainBoxes[step - 1]!;
  const origBox =
    cursor.el instanceof SVGGraphicsElement
      ? unionBoxInSvgRoot(cursor.el, invSvgCtm, null) ?? clientRectToSvgRoot(cursor.rect, invSvgCtm)
      : clientRectToSvgRoot(cursor.rect, invSvgCtm);

  if (_hiddenCursorEl && _hiddenCursorEl !== cursor.el) {
    _hiddenCursorEl.style.opacity = "";
  }
  _hiddenCursorEl = cursor.el;
  cursor.el.style.opacity = "0";

  // 清除其他頁殘留游標，只保留當下頁面上的 .sl-sustain-cursor
  for (const stale of scorePane.querySelectorAll(".sl-sustain-cursor")) {
    if (stale.parentNode !== svg) stale.remove();
  }

  let ghost = svg.querySelector<SVGRectElement>(".sl-sustain-cursor");
  if (!ghost) {
    ghost = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    ghost.setAttribute("class", "sl-sustain-cursor");
    ghost.setAttribute("pointer-events", "none");
    svg.appendChild(ghost);
  }

  const st = getComputedStyle(cursor.el);
  const fillVal =
    isOrangeCursorColor(st.fill) ? st.fill : isOrangeCursorColor(st.backgroundColor) ? st.backgroundColor : "rgba(234, 88, 12, 0.22)";
  const strokeVal =
    isOrangeCursorColor(st.stroke) ? st.stroke : isOrangeCursorColor(st.borderColor) ? st.borderColor : "#ea580c";

  const origW = Math.max(10, origBox.maxX - origBox.minX);
  const dashW = Math.max(origW * 0.9, targetDash.maxX - targetDash.minX + 12);
  const cx = (targetDash.minX + targetDash.maxX) * 0.5;

  ghost.setAttribute("x", String(cx - dashW * 0.5));
  ghost.setAttribute("y", String(origBox.minY));
  ghost.setAttribute("width", String(dashW));
  ghost.setAttribute("height", String(Math.max(12, origBox.maxY - origBox.minY)));
  ghost.setAttribute("rx", cursor.el.getAttribute("rx") || "4");
  ghost.setAttribute("ry", cursor.el.getAttribute("ry") || "4");
  ghost.setAttribute("fill", fillVal);
  ghost.setAttribute("stroke", strokeVal);
  ghost.setAttribute("stroke-width", cursor.el.getAttribute("stroke-width") || "1.5");

  return ghost.getBoundingClientRect();
}

function startPlaybackScrollGuard(scorePane: HTMLElement): void {
  if (_playbackGuardRaf) return;
  let lastContentTop = -Infinity;
  let pendingEnsureFrames = 0;

  const step = () => {
    if (!_app || !_app.playback.busy) {
      cleanupSustainCursor(scorePane);
      _playbackGuardRaf = 0;
      return;
    }

    const cursor = findOfficialPlaybackCursor(scorePane);
    if (cursor) {
      const activeRect = updateSustainCursor(scorePane, cursor) ?? cursor.rect;
      const paneRect = scorePane.getBoundingClientRect();
      const contentTop = activeRect.top - paneRect.top + scorePane.scrollTop;

      if (Math.abs(contentTop - lastContentTop) > 22) {
        lastContentTop = contentTop;
        pendingEnsureFrames = 8;
      }

      const padTop = 34;
      const minSystemSpan = Math.max(activeRect.height + 48, 130);
      const visibleTopNeed = activeRect.top - padTop;
      const visibleBottomNeed = Math.max(activeRect.bottom + 42, activeRect.top + minSystemSpan);

      const isClippedTop = visibleTopNeed < paneRect.top + 4;
      const isClippedBottom = visibleBottomNeed > paneRect.bottom - 6;

      if ((pendingEnsureFrames > 0 || isClippedBottom) && (isClippedTop || isClippedBottom)) {
        const systemTotalH = visibleBottomNeed - visibleTopNeed;
        const maxScroll = Math.max(0, scorePane.scrollHeight - scorePane.clientHeight);
        let desiredScrollTop: number;

        if (systemTotalH <= paneRect.height - 16) {
          desiredScrollTop = scorePane.scrollTop + (visibleTopNeed - paneRect.top) - 16;
        } else {
          const centerY = (activeRect.top + activeRect.bottom) * 0.5;
          desiredScrollTop = scorePane.scrollTop + (centerY - (paneRect.top + paneRect.height * 0.5));
        }

        desiredScrollTop = Math.max(0, Math.min(maxScroll, desiredScrollTop));
        if (Math.abs(desiredScrollTop - scorePane.scrollTop) > 3) {
          scorePane.scrollTop = desiredScrollTop;
        }
      }

      if (pendingEnsureFrames > 0) pendingEnsureFrames--;
    } else {
      cleanupSustainCursor(scorePane);
    }

    _playbackGuardRaf = requestAnimationFrame(step);
  };

  _playbackGuardRaf = requestAnimationFrame(step);
}

// ---- 選段繪製：單一連續半透明底色 + 清晰起點(A)/終點(B)標記 ----
function clearAbBands() {
  _scorePane?.querySelectorAll(".sl-ab-band, .sl-ab-marker").forEach((el) => el.remove());
}

interface NoteRootBox {
  id: ElementId;
  t: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function drawEndpointMarker(
  svg: SVGSVGElement,
  x: number,
  topY: number,
  botY: number,
  side: "start" | "end",
  label: string,
  color: string,
) {
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "sl-ab-marker");
  g.setAttribute("pointer-events", "none");

  const arm = side === "start" ? 7 : -7;
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", `M${x + arm} ${topY} L${x} ${topY} L${x} ${botY} L${x + arm} ${botY}`);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", "2.2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  g.appendChild(path);

  const badgeW = 16;
  const badgeH = 15;
  const bx = side === "start" ? x - 2 : x - badgeW + 2;
  const by = topY - badgeH - 2;

  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("x", String(bx));
  bg.setAttribute("y", String(by));
  bg.setAttribute("width", String(badgeW));
  bg.setAttribute("height", String(badgeH));
  bg.setAttribute("rx", "4");
  bg.setAttribute("fill", color);
  g.appendChild(bg);

  const txt = document.createElementNS(NS, "text");
  txt.setAttribute("x", String(bx + badgeW * 0.5));
  txt.setAttribute("y", String(by + badgeH * 0.5 + 3.6));
  txt.setAttribute("text-anchor", "middle");
  txt.setAttribute("font-size", "10");
  txt.setAttribute("font-weight", "700");
  txt.setAttribute("fill", "#ffffff");
  txt.textContent = label;
  g.appendChild(txt);

  svg.appendChild(g);
}

function paintAbBands() {
  clearAbBands();
  if (!_app || !_scorePane) return;

  const activeRange = _abPreviewRange
    ? { firstId: _abPreviewRange.startId, lastId: _abPreviewRange.endId, tFrom: _abPreviewRange.tFrom, tTo: _abPreviewRange.tTo, preview: true }
    : _abLoop
      ? { firstId: _abLoop.first.id, lastId: _abLoop.last.id, tFrom: _abLoop.tFrom, tTo: _abLoop.tTo, preview: false }
      : null;

  if (!activeRange && _abPendingStart === null) return;
  const info = activeRange ? getTimeline() : null;
  const NS = "http://www.w3.org/2000/svg";

  for (const svg of _scorePane.querySelectorAll<SVGSVGElement>(".score-page-wrap svg")) {
    const svgCtm = svg.getScreenCTM();
    if (!svgCtm) continue;
    const invSvgCtm = svgCtm.inverse();

    const matchedNotes: NoteRootBox[] = [];
    let pendingBox: NoteRootBox | null = null;

    if (_app.mode === "mixed") {
      const seenIds = new Set<ElementId>();
      for (const g of svg.querySelectorAll<SVGGElement>("g")) {
        const id = _app.painter.noteAt(g);
        if (id === null || seenIds.has(id)) continue;
        seenIds.add(id);

        if (_abPendingStart !== null && id === _abPendingStart) {
          let merged: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
          for (const nel of _app.painter.noteEls(id)) {
            if (nel.ownerSVGElement === svg) merged = unionBoxInSvgRoot(nel, invSvgCtm, merged);
          }
          if (merged) pendingBox = { id, t: 0, ...merged };
        }

        if (activeRange && info) {
          const t = anchorSeconds(info.tl, info.spq, { id, pass: 1 });
          if (t !== null && t >= activeRange.tFrom - 0.002 && t <= activeRange.tTo + 0.002) {
            let merged: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
            for (const nel of _app.painter.noteEls(id)) {
              if (nel.ownerSVGElement === svg) merged = unionBoxInSvgRoot(nel, invSvgCtm, merged);
            }
            if (merged) matchedNotes.push({ id, t, ...merged });
          }
        }
      }
    } else {
      const boxById = new Map<ElementId, NoteRootBox>();
      for (const g of svg.querySelectorAll<SVGGElement>("g")) {
        const entry = _app.syncView.entryAt(g);
        if (!entry || (entry.kind !== "note" && entry.kind !== "sustain")) continue;
        const id = entry.id;

        if (_abPendingStart !== null && id === _abPendingStart && entry.kind === "note") {
          const merged = unionBoxInSvgRoot(g, invSvgCtm, pendingBox);
          if (merged) pendingBox = { id, t: 0, ...merged };
        }

        if (activeRange && info) {
          const t = anchorSeconds(info.tl, info.spq, { id, pass: 1 });
          if (t !== null && t >= activeRange.tFrom - 0.002 && t <= activeRange.tTo + 0.002) {
            const merged = unionBoxInSvgRoot(g, invSvgCtm, boxById.get(id) ?? null);
            if (merged) boxById.set(id, { id, t, ...merged });
          }
        }
      }
      matchedNotes.push(...boxById.values());
    }

    if (pendingBox && !activeRange) {
      drawEndpointMarker(svg, pendingBox.minX - 6, pendingBox.minY - 6, pendingBox.maxY + 6, "start", "A", "#b88b4a");
      continue;
    }

    if (!activeRange || matchedNotes.length === 0) continue;

    matchedNotes.sort((a, b) => a.t - b.t || a.minX - b.minX);

    interface SystemSpan {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      lastX: number;
      hasStart: boolean;
      hasEnd: boolean;
    }

    const systems: SystemSpan[] = [];
    for (const note of matchedNotes) {
      const prev = systems[systems.length - 1];
      const wrappedToNextLine =
        prev &&
        ((note.minX < prev.lastX - 45 && note.minY > prev.minY + 28) ||
          note.minY > prev.maxY + 55 ||
          note.maxY < prev.minY - 55);

      if (!prev || wrappedToNextLine) {
        systems.push({
          minX: note.minX,
          minY: note.minY,
          maxX: note.maxX,
          maxY: note.maxY,
          lastX: note.minX,
          hasStart: note.id === activeRange.firstId,
          hasEnd: note.id === activeRange.lastId,
        });
      } else {
        if (note.minX < prev.minX) prev.minX = note.minX;
        if (note.minY < prev.minY) prev.minY = note.minY;
        if (note.maxX > prev.maxX) prev.maxX = note.maxX;
        if (note.maxY > prev.maxY) prev.maxY = note.maxY;
        if (note.minX > prev.lastX) prev.lastX = note.minX;
        if (note.id === activeRange.firstId) prev.hasStart = true;
        if (note.id === activeRange.lastId) prev.hasEnd = true;
      }
    }

    const tintFill = activeRange.preview ? "rgba(184, 139, 74, 0.16)" : "rgba(91, 122, 98, 0.14)";
    const markerColor = activeRange.preview ? "#b88b4a" : "#5b7a62";

    for (const sys of systems) {
      const padX = 7;
      const padY = 7;
      const left = sys.minX - padX;
      const top = sys.minY - padY;
      const right = sys.maxX + padX;
      const bottom = sys.maxY + padY;

      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("class", "sl-ab-band");
      rect.setAttribute("x", String(left));
      rect.setAttribute("y", String(top));
      rect.setAttribute("width", String(Math.max(4, right - left)));
      rect.setAttribute("height", String(Math.max(8, bottom - top)));
      rect.setAttribute("rx", "6");
      rect.setAttribute("fill", tintFill);
      rect.setAttribute("stroke", "none");
      rect.setAttribute("pointer-events", "none");
      svg.appendChild(rect);

      if (sys.hasStart) {
        drawEndpointMarker(svg, left, top, bottom, "start", "A", markerColor);
      }
      if (sys.hasEnd) {
        drawEndpointMarker(svg, right, top, bottom, "end", "B", markerColor);
      }
    }
  }
}

function clearAbLoop(stopLoopToggle = true) {
  _abLoop = null;
  _abPendingStart = null;
  _abPreviewRange = null;
  _rangePickMode = false;
  clearAbBands();
  if (_app && stopLoopToggle) {
    _app.playback.setLoop(false);
  }
  notifyRange();
}

function buildOrderedRange(idA: ElementId, idB: ElementId) {
  const info = getTimeline();
  if (!info) return null;
  const tA = anchorSeconds(info.tl, info.spq, { id: idA, pass: 1 });
  const tB = anchorSeconds(info.tl, info.spq, { id: idB, pass: 1 });
  if (tA === null || tB === null) return null;
  if (tA <= tB) {
    return { startId: idA, endId: idB, tFrom: tA, tTo: tB, info };
  }
  return { startId: idB, endId: idA, tFrom: tB, tTo: tA, info };
}

function applyAbLoopByIds(idA: ElementId, idB: ElementId): boolean {
  if (!_app) return false;
  const ordered = buildOrderedRange(idA, idB);
  if (!ordered) return false;

  const span = spanSeconds(
    ordered.info.tl,
    ordered.info.spq,
    { id: ordered.startId, pass: 1 },
    { id: ordered.endId, pass: 1 },
  );
  if (!span || span.to <= span.from) return false;

  _abLoop = {
    first: { id: ordered.startId, pass: 1 },
    last: { id: ordered.endId, pass: 1 },
    tFrom: ordered.tFrom,
    tTo: ordered.tTo,
  };
  _abPendingStart = null;
  _abPreviewRange = null;
  _rangePickMode = false;
  paintAbBands();
  _app.playback.setLoop(true);
  _app.playback.seekTo({ id: ordered.startId, pass: 1 });
  if (!_app.playback.busy) void _app.playback.play();
  notifyRange();
  return true;
}

/**
 * 選段互動（電腦＋手機無衝突設計）：
 * - 手機/觸控螢幕：正常滑動可順暢捲動樂譜；「長按約 350ms 設定起點 → 不離手直接拖曳至終點 → 放開完成選段」。
 *   （若先點擊工具列的「選段」SVG 鍵，則直接觸控拖曳即可選段，無需長按）
 * - 電腦滑鼠：直接左鍵按住拖曳（起點拖至終點）即可完成選段。
 */
function wireDirectScoreSelection(scorePane: HTMLElement) {
  const LONG_PRESS_MS = 350;
  const MOVE_CANCEL_PX = 10;

  let suppressClick = false;

  // ---- 1. 滑鼠拖曳選段 ----
  let mouseStart: { x: number; y: number; startId: ElementId | null } | null = null;
  let mouseDragging = false;

  const cleanupMouse = () => {
    mouseStart = null;
    mouseDragging = false;
    _abPreviewRange = null;
  };

  scorePane.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const rc = scorePane.getBoundingClientRect();
    if (e.clientX - rc.left >= scorePane.clientLeft + scorePane.clientWidth) return;
    const startId = findNearestNoteId(scorePane, e.target as Element | null, e.clientX, e.clientY, 28);
    mouseStart = { x: e.clientX, y: e.clientY, startId };
    mouseDragging = false;
  }, true);

  window.addEventListener("mousemove", (e) => {
    if (!mouseStart) return;
    const dx = e.clientX - mouseStart.x;
    const dy = e.clientY - mouseStart.y;
    if (!mouseDragging && Math.hypot(dx, dy) < 9) return;
    if (!mouseDragging) {
      mouseDragging = true;
      if (mouseStart.startId === null) {
        mouseStart.startId = findNearestNoteId(scorePane, null, mouseStart.x, mouseStart.y, 44);
      }
      if (mouseStart.startId !== null) {
        _abPendingStart = mouseStart.startId;
        notifyRange();
      }
    }

    if (mouseStart.startId !== null) {
      const endId = findNearestNoteId(scorePane, e.target as Element | null, e.clientX, e.clientY, 38);
      if (endId !== null) {
        const ordered = buildOrderedRange(mouseStart.startId, endId);
        if (ordered && ordered.tTo > ordered.tFrom) {
          _abPreviewRange = { startId: ordered.startId, endId: ordered.endId, tFrom: ordered.tFrom, tTo: ordered.tTo };
          paintAbBands();
        } else {
          _abPreviewRange = null;
          paintAbBands();
        }
      }
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (!mouseStart) return;
    const st = mouseStart;
    const wasDragging = mouseDragging;
    cleanupMouse();

    if (!wasDragging) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 60);

    if (st.startId !== null) {
      const endId = findNearestNoteId(scorePane, e.target as Element | null, e.clientX, e.clientY, 44);
      if (endId !== null && applyAbLoopByIds(st.startId, endId)) {
        return;
      }
    }

    const info = getTimeline();
    if (info) {
      const rLeft = Math.min(st.x, e.clientX);
      const rRight = Math.max(st.x, e.clientX);
      const rTop = Math.min(st.y, e.clientY);
      const rBottom = Math.max(st.y, e.clientY);
      let minId: ElementId | null = null, minT = Infinity;
      let maxId: ElementId | null = null, maxT = -Infinity;
      const seen = new Set<ElementId>();

      for (const g of scorePane.querySelectorAll<SVGGElement>(".score-page-wrap svg g")) {
        const id = resolveNoteIdAt(g);
        if (id === null || seen.has(id)) continue;
        const b = g.getBoundingClientRect();
        if (b.width <= 0 && b.height <= 0) continue;
        if (b.right < rLeft || b.left > rRight || b.bottom < rTop || b.top > rBottom) continue;
        seen.add(id);
        const t = anchorSeconds(info.tl, info.spq, { id, pass: 1 });
        if (t === null) continue;
        if (t < minT) { minT = t; minId = id; }
        if (t > maxT) { maxT = t; maxId = id; }
      }
      if (minId !== null && maxId !== null && maxT > minT && applyAbLoopByIds(minId, maxId)) {
        return;
      }
    }

    _abPendingStart = null;
    paintAbBands();
    notifyRange();
  });

  // ---- 2. 手機／觸控：長按設起點 → 拖曳至終點（與單指捲動、雙指縮放零衝突） ----
  let touchTimer: number | null = null;
  let touchActive = false;
  let touchStartPt: { x: number; y: number } | null = null;
  let touchStartId: ElementId | null = null;
  let touchEndId: ElementId | null = null;

  const clearTouchTimer = () => {
    if (touchTimer !== null) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
  };

  const resetTouchState = () => {
    clearTouchTimer();
    touchActive = false;
    touchStartPt = null;
    touchStartId = null;
    touchEndId = null;
    _abPreviewRange = null;
  };

  const activateTouchDrag = (x: number, y: number, target: Element | null) => {
    const id = findNearestNoteId(scorePane, target, x, y, 42);
    if (id === null) {
      resetTouchState();
      return;
    }
    touchActive = true;
    touchStartId = id;
    touchEndId = id;
    _abPendingStart = id;
    _abPreviewRange = null;
    try { navigator.vibrate?.(18); } catch {}
    paintAbBands();
    notifyRange();
  };

  scorePane.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) {
      resetTouchState();
      paintAbBands();
      notifyRange();
      return;
    }
    const t = e.touches[0]!;
    touchStartPt = { x: t.clientX, y: t.clientY };
    touchActive = false;
    touchStartId = null;
    touchEndId = null;

    if (_rangePickMode) {
      activateTouchDrag(t.clientX, t.clientY, e.target as Element | null);
    } else {
      clearTouchTimer();
      const target = e.target as Element | null;
      const sx = t.clientX;
      const sy = t.clientY;
      touchTimer = window.setTimeout(() => {
        touchTimer = null;
        activateTouchDrag(sx, sy, target);
      }, LONG_PRESS_MS);
    }
  }, { passive: true, capture: true });

  scorePane.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 1) {
      if (touchActive) {
        resetTouchState();
        _abPendingStart = null;
        paintAbBands();
        notifyRange();
      } else {
        clearTouchTimer();
      }
      return;
    }
    const t = e.touches[0]!;

    if (!touchActive) {
      if (touchStartPt && Math.hypot(t.clientX - touchStartPt.x, t.clientY - touchStartPt.y) > MOVE_CANCEL_PX) {
        clearTouchTimer();
        touchStartPt = null;
      }
      return;
    }

    e.preventDefault();
    const elUnder = document.elementFromPoint(t.clientX, t.clientY);
    const id = findNearestNoteId(scorePane, elUnder, t.clientX, t.clientY, 44);
    if (id !== null && touchStartId !== null) {
      touchEndId = id;
      const ordered = buildOrderedRange(touchStartId, id);
      if (ordered && ordered.tTo > ordered.tFrom) {
        _abPreviewRange = { startId: ordered.startId, endId: ordered.endId, tFrom: ordered.tFrom, tTo: ordered.tTo };
      } else {
        _abPreviewRange = null;
      }
      paintAbBands();
    }
  }, { passive: false, capture: true });

  const finishTouch = () => {
    clearTouchTimer();
    if (!touchActive) {
      resetTouchState();
      return;
    }
    const sId = touchStartId;
    const eId = touchEndId;
    resetTouchState();
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 120);

    if (sId !== null && eId !== null && applyAbLoopByIds(sId, eId)) {
      return;
    }

    _abPendingStart = null;
    if (_rangePickMode) _rangePickMode = false;
    paintAbBands();
    notifyRange();
  };

  scorePane.addEventListener("touchend", finishTouch, { capture: true });
  scorePane.addEventListener("touchcancel", () => {
    const wasActive = touchActive;
    resetTouchState();
    if (wasActive) {
      _abPendingStart = null;
      paintAbBands();
      notifyRange();
    }
  }, { capture: true });

  scorePane.addEventListener("contextmenu", (e) => {
    if (touchActive || touchTimer !== null || _rangePickMode) {
      e.preventDefault();
    }
  });

  scorePane.addEventListener("click", (e) => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
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
      opts.playBtn.addEventListener("click", () => {
        void app.playback.toggle();
        setTimeout(() => {
          if (app.playback.busy) startPlaybackScrollGuard(opts.scorePane);
        }, 30);
      });
    }
    if (opts.stopBtn) {
      app.playback.setStopBtn(opts.stopBtn);
      opts.stopBtn.addEventListener("click", () => cleanupSustainCursor(opts.scorePane));
    }
    if (opts.progressEl) app.playback.bindProgress(opts.progressEl, opts.timeEl ?? null);
    if (opts.speedSel) app.playback.bindSpeedSelect(opts.speedSel);

    preserveIconButton(opts.loopBtn);
    preserveIconButton(opts.metroBtn);
    app.playback.bindToggles(opts.loopBtn ?? null, opts.metroBtn ?? null);

    if (opts.viewBtns) {
      for (const [mode, btn] of opts.viewBtns) {
        btn.addEventListener("click", async () => {
          cleanupSustainCursor(opts.scorePane);
          clearAbLoop(false);
          await app.setViewMode(mode);
          hideDiagnosticOverlays(opts.scorePane);
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

    let diagScheduled = false;
    const paneObserver = new MutationObserver(() => {
      if (!diagScheduled) {
        diagScheduled = true;
        requestAnimationFrame(() => {
          diagScheduled = false;
          hideDiagnosticOverlays(opts.scorePane);
        });
      }
      if (app.playback.busy) {
        startPlaybackScrollGuard(opts.scorePane);
      }
    });
    paneObserver.observe(opts.scorePane, { childList: true, subtree: true });

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
  cleanupSustainCursor(_scorePane);
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
    if (_scorePane) hideDiagnosticOverlays(_scorePane);
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
            if (_scorePane) hideDiagnosticOverlays(_scorePane);
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
  if (_scorePane) hideDiagnosticOverlays(_scorePane);

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
    cleanupSustainCursor(_scorePane);
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
    if (_scorePane) hideDiagnosticOverlays(_scorePane);
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
    cleanupSustainCursor(_scorePane);
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
    if (_scorePane) hideDiagnosticOverlays(_scorePane);
  },
  toggleRangePick() {
    _rangePickMode = !_rangePickMode;
    if (!_rangePickMode) {
      _abPendingStart = null;
      _abPreviewRange = null;
    }
    paintAbBands();
    notifyRange();
  },
  clearRangeLoop() {
    clearAbLoop(true);
  },
  async setViewMode(m) {
    if (!_app) return;
    cleanupSustainCursor(_scorePane);
    clearAbLoop(false);
    await _app.setViewMode(m);
    if (_scorePane) hideDiagnosticOverlays(_scorePane);
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
    cleanupSustainCursor(_scorePane);
    _app?.stopPlayback();
  },
  getApp: () => _app,
};
window.dispatchEvent(new Event("dolce-engine-ready"));
