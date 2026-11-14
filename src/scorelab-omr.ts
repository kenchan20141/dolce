
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

const AUTOSAVE_DB_NAME = "scorelab_autosave_db";
const AUTOSAVE_STORE = "drafts";
const AUTOSAVE_LS_KEY = "scorelab_last_score_v1";

const S2T_MAP: Record<string, string> = {
  "编": "編", "辑": "輯", "节": "節", "拍": "拍", "数": "數", "处": "處",
  "问": "問", "题": "題", "音": "音", "符": "符", "时": "時", "值": "值",
  "附": "附", "点": "點", "声": "聲", "部": "部", "长": "長", "短": "短",
  "复": "複", "错": "錯", "误": "誤", "调": "調", "号": "號", "线": "線",
  "连": "連", "延": "延", "换": "換", "页": "頁", "删": "刪", "除": "除",
  "选": "選", "中": "中", "个": "個", "无": "無", "请": "請", "先": "先",
  "击": "擊", "仅": "僅", "支": "支", "持": "持", "图": "圖", "谱": "譜",
  "乐": "樂", "曲": "曲", "词": "詞", "强": "強", "弱": "弱", "渐": "漸",
  "标": "標", "记": "記", "只": "只", "能": "能", "在": "在", "这": "這",
  "里": "裡", "对": "對", "齐": "齊", "满": "滿", "于": "於", "为": "為",
  "与": "與", "没": "沒", "经": "經", "结": "結", "开": "開", "设": "設",
  "改": "改", "变": "變", "动": "動", "撤": "撤", "销": "銷", "实": "實",
  "际": "際", "应": "應", "该": "該", "还": "還", "组": "組", "圆": "圓",
  "滑": "滑", "休": "休", "止": "止", "空": "空", "当": "當", "前": "前",
  "后": "後", "两": "兩", "边": "邊", "间": "間", "格": "格", "贴": "貼",
  "制": "製", "移": "移", "高": "高", "低": "低", "升": "升",
  "降": "降", "半": "半", "全": "全", "单": "單", "双": "雙", "多": "多",
  "少": "少", "过": "過", "补": "補", "漏": "漏", "识": "識", "别": "別",
  "核": "核", "写": "寫", "读": "讀", "入": "入", "导": "導", "出": "出",
  "保": "保", "存": "存", "确": "確", "认": "認", "取": "取", "消": "消",
  "简": "簡", "繁": "繁", "体": "體", "五": "五", "混": "混", "排": "排",
  "版": "版", "面": "面", "显": "顯", "示": "示", "隐": "隱", "藏": "藏",
  "条": "條", "行": "行", "段": "段", "整": "整", "首": "首", "尾": "尾",
};

function toTraditionalUi(s: string): string {
  if (!s) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    out += S2T_MAP[ch] ?? ch;
  }
  return out;
}

// ---- IndexedDB + localStorage 自動儲存／還原 ----
function openAutosaveDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(AUTOSAVE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(AUTOSAVE_STORE)) {
          db.createObjectStore(AUTOSAVE_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeAutosaveSnapshot(snap: ScoreSnapshot): Promise<boolean> {
  const payload = { id: "current", ...snap, updatedAt: Date.now() };
  try {
    localStorage.setItem(
      AUTOSAVE_LS_KEY,
      JSON.stringify(
        snap.text.length <= 250_000
          ? payload
          : { id: "current", title: snap.title, format: snap.format, viewMode: snap.viewMode, updatedAt: payload.updatedAt },
      ),
    );
  } catch {
    // 忽略配額限制
  }

  const db = await openAutosaveDb();
  if (!db) return true;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(AUTOSAVE_STORE, "readwrite");
      tx.objectStore(AUTOSAVE_STORE).put(payload);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function readAutosaveSnapshot(): Promise<ScoreSnapshot | null> {
  const db = await openAutosaveDb();
  if (db) {
    const rec = await new Promise<ScoreSnapshot | null>((resolve) => {
      try {
        const tx = db.transaction(AUTOSAVE_STORE, "readonly");
        const req = tx.objectStore(AUTOSAVE_STORE).get("current");
        req.onsuccess = () => {
          const r = req.result;
          if (r && typeof r.text === "string" && r.text.length > 0) {
            resolve({
              title: r.title || "已儲存樂譜",
              format: r.format || "musicxml",
              text: r.text,
              viewMode: r.viewMode || "staff",
            });
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    if (rec) return rec;
  }

  try {
    const raw = localStorage.getItem(AUTOSAVE_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.text === "string" && parsed.text.length > 0) {
      return {
        title: parsed.title || "已儲存樂譜",
        format: parsed.format || "musicxml",
        text: parsed.text,
        viewMode: parsed.viewMode || "staff",
      };
    }
  } catch {}
  return null;
}

async function clearAutosaveSnapshot(): Promise<void> {
  try {
    localStorage.removeItem(AUTOSAVE_LS_KEY);
  } catch {}
  const db = await openAutosaveDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(AUTOSAVE_STORE, "readwrite");
      tx.objectStore(AUTOSAVE_STORE).delete("current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
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

/** 快速抽樣判斷是否已是乾淨白底數位樂譜，若是則免跑逐像素光影運算 */
function isAlreadyCleanWhiteBg(data: Uint8ClampedArray, w: number, h: number): boolean {
  const stepX = Math.max(1, Math.floor(w / 36));
  const stepY = Math.max(1, Math.floor(h / 36));
  let total = 0;
  let brightWhite = 0;
  let dimGrayBg = 0;

  for (let y = 0; y < h; y += stepY) {
    const rowOff = y * w;
    for (let x = 0; x < w; x += stepX) {
      const p = (rowOff + x) * 4;
      const a = data[p + 3]!;
      const alpha = a < 250 ? a / 255 : 1;
      const r = data[p]! * alpha + 255 * (1 - alpha);
      const g = data[p + 1]! * alpha + 255 * (1 - alpha);
      const b = data[p + 2]! * alpha + 255 * (1 - alpha);
      const lum = (77 * r + 150 * g + 29 * b + 128) >> 8;
      total++;
      if (lum >= 244) brightWhite++;
      else if (lum >= 120 && lum < 238) dimGrayBg++;
    }
  }
  return total > 0 && brightWhite / total >= 0.82 && dimGrayBg / total <= 0.08;
}

function enhanceScoreContrast(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  if (isAlreadyCleanWhiteBg(data, w, h)) {
    return false;
  }

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

  const BLACK_CLIP = 95;
  const WHITE_CLIP = 230;
  const SPAN = WHITE_CLIP - BLACK_CLIP;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    if (v <= BLACK_CLIP) lut[v] = 0;
    else if (v >= WHITE_CLIP) lut[v] = 255;
    else {
      const t = (v - BLACK_CLIP) / SPAN;
      lut[v] = Math.round(Math.pow(t, 1.15) * 255);
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
  return true;
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

      const modified = enhanceScoreContrast(ctx, w, h);
      if (!modified && scale >= 0.999) {
        return { bytes: raw, mime };
      }

      const pngBlob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/png"));
      if (pngBlob) {
        return { bytes: new Uint8Array(await pngBlob.arrayBuffer()), mime: "image/png" };
      }
      const jpgBlob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.95));
      if (jpgBlob) {
        return { bytes: new Uint8Array(await jpgBlob.arrayBuffer()), mime: "image/jpeg" };
      }
      return { bytes: raw, mime };
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
  editToggleBtn?: HTMLButtonElement | null;
  editSaveBtn?: HTMLButtonElement | null;
  editDiscardBtn?: HTMLButtonElement | null;
  editPanel?: HTMLElement | null;
  visualEls?: {
    mode: HTMLElement | null;
    selInfo?: HTMLElement | null;
    marksBtn: HTMLButtonElement | null;
    beatBtn: HTMLButtonElement | null;
    beatCount: HTMLElement | null;
  };
  onZoomChange?: (zoom: number) => void;
  onRangeChange?: (state: { active: boolean; picking: boolean; hasStart: boolean }) => void;
  onEditModeChange?: (editing: boolean, committed?: boolean) => void;
  onViewModeChange?: (mode: ViewMode) => void;
}

let _appPromise: Promise<App> | null = null;
let _app: App | null = null;
let _scorePane: HTMLElement | null = null;
let _progressEl: HTMLInputElement | null = null;
let _editToggleBtn: HTMLButtonElement | null = null;
let _editPanel: HTMLElement | null = null;
let _selInfoEl: HTMLElement | null = null;
let _onZoomChange: ((z: number) => void) | undefined;
let _onRangeChange: MountShellOptions["onRangeChange"];
let _onEditModeChange: MountShellOptions["onEditModeChange"];
let _onViewModeChange: MountShellOptions["onViewModeChange"];
let _loadGen = 0;
let _editMode = false;
let _editBackup: { format: DocFormatId; text: string; viewMode: ViewMode } | null = null;

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

function getCurrentSnapshot(): ScoreSnapshot | null {
  if (!_app || _app.pageEls.length === 0) return null;
  const rawTitle = (_app.documentTitle() || "").trim();
  const title = rawTitle && rawTitle !== "未命名" ? rawTitle : "已儲存樂譜";
  return {
    title,
    format: _app.docFormat,
    text: _app.getText(),
    viewMode: _app.viewMode,
  };
}

async function persistCurrentScore(): Promise<boolean> {
  const snap = getCurrentSnapshot();
  if (!snap) return false;
  return writeAutosaveSnapshot(snap);
}

async function restoreSnapshotInternal(snap: Pick<ScoreSnapshot, "format" | "text" | "viewMode">) {
  if (!_app) return;
  cleanupSustainCursor(_scorePane);
  _app.stopPlayback();
  _app.clearPages();
  if (snap.format === "musicxml") {
    _app.adoptStaffXml(snap.text);
  } else {
    _app.adoptText(snap.format, snap.text, null);
  }
  const targetMode = snap.viewMode === "original" ? "expanded" : snap.viewMode;
  await _app.setViewMode(targetMode);
  await _app.whenIdle();
  _onViewModeChange?.(_app.viewMode);
}

function enterEditMode() {
  if (_editMode) return;
  const snap = getCurrentSnapshot();
  _editBackup = snap ? { format: snap.format, text: snap.text, viewMode: snap.viewMode } : null;
  _editMode = true;
  if (_editToggleBtn) {
    _editToggleBtn.classList.add("active");
    _editToggleBtn.setAttribute("aria-pressed", "true");
  }
  if (_editPanel) {
    _editPanel.classList.remove("hidden");
  }
  if (_rangePickMode) {
    _rangePickMode = false;
    _abPendingStart = null;
    _abPreviewRange = null;
    paintAbBands();
    notifyRange();
  }
  if (_app) {
    _app.visual.beatCheck = true;
    _app.visual.afterRebuild();
    const selTxt = (_selInfoEl?.textContent || "").trim();
    if (!selTxt || /未選|無選/.test(selTxt)) {
      _app.visual.runById("nav.next", "");
    }
    _onViewModeChange?.(_app.viewMode);
    _scorePane?.focus({ preventScroll: true });
  }
  _onEditModeChange?.(true, false);
}

function commitEditMode() {
  if (!_editMode) return;
  _editBackup = null;
  _editMode = false;
  if (_editToggleBtn) {
    _editToggleBtn.classList.remove("active");
    _editToggleBtn.setAttribute("aria-pressed", "false");
  }
  if (_editPanel) {
    _editPanel.classList.add("hidden");
  }
  if (_app) {
    _app.visual.afterRebuild();
    if (_scorePane) hideDiagnosticOverlays(_scorePane);
  }
  void persistCurrentScore();
  _onEditModeChange?.(false, true);
}

async function cancelEditMode() {
  if (!_editMode) return;
  const backup = _editBackup;
  _editBackup = null;
  _editMode = false;
  if (_editToggleBtn) {
    _editToggleBtn.classList.remove("active");
    _editToggleBtn.setAttribute("aria-pressed", "false");
  }
  if (_editPanel) {
    _editPanel.classList.add("hidden");
  }
  if (_app && backup && (_app.getText() !== backup.text || _app.docFormat !== backup.format || _app.viewMode !== backup.viewMode)) {
    await restoreSnapshotInternal(backup);
  }
  if (_app) {
    _app.visual.afterRebuild();
    if (_scorePane) hideDiagnosticOverlays(_scorePane);
  }
  _onEditModeChange?.(false, false);
}

// ---- MusicXML 小節結構／調號／拍號／速度／換行／換頁 後備修改器 ----
const KEY_NAME_TO_FIFTHS: Record<string, number> = {
  C: 0, AM: 0,
  G: 1, EM: 1,
  D: 2, BM: 2,
  A: 3, "F#M": 3,
  E: 4, "C#M": 4,
  B: 5, "G#M": 5, CB: -7,
  "F#": 6, "D#M": 6, GB: -6, EBM: -6,
  "C#": 7, "A#M": 7, DB: -5, BBM: -5,
  F: -1, DM: -1,
  BB: -2, GM: -2,
  EB: -3, CM: -3,
  AB: -4, FM: -4,
};

function parseKeyFifthsInput(raw: string): number | null {
  const s = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  if (/^[+-]?\d+$/.test(s)) {
    const n = Number(s);
    return n >= -7 && n <= 7 ? n : null;
  }
  const norm = s.replace(/MAJOR|MAJ/g, "").replace(/MINOR|MIN/g, "M");
  if (norm in KEY_NAME_TO_FIFTHS) return KEY_NAME_TO_FIFTHS[norm]!;
  return null;
}

function getSelectedMeasureNumber(totalMeasures: number): number {
  const txt = (_selInfoEl?.textContent || "").trim();
  const m = txt.match(/第\s*(\d+)\s*小節/) || txt.match(/\bm\.?\s*(\d+)\b/i) || txt.match(/(\d+)/);
  if (m) {
    const num = Number(m[1]);
    if (num >= 1 && num <= totalMeasures) return num;
  }
  return 1;
}

function ensureChildEl(doc: XMLDocument, parent: Element, tagName: string, prepend = false): Element {
  const found = Array.from(parent.children).find((c) => c.tagName === tagName);
  if (found) return found;
  const el = doc.createElement(tagName);
  if (prepend && parent.firstChild) parent.insertBefore(el, parent.firstChild);
  else parent.appendChild(el);
  return el;
}

async function applyMusicXmlFallbackAction(id: string, key = ""): Promise<boolean> {
  if (!_app || _app.docFormat !== "musicxml") return false;
  const rawXml = _app.getText();
  if (!rawXml) return false;

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(rawXml, "application/xml");
  if (xmlDoc.querySelector("parsererror")) return false;

  const parts = Array.from(xmlDoc.querySelectorAll("score-partwise > part"));
  if (!parts.length) return false;
  const firstPartMeasures = Array.from(parts[0]!.children).filter((c) => c.tagName === "measure");
  if (!firstPartMeasures.length) return false;

  const selMeasNum = getSelectedMeasureNumber(firstPartMeasures.length);
  const targetIdx = Math.max(0, Math.min(firstPartMeasures.length - 1, selMeasNum - 1));
  let changed = false;

  if (id === "meas.key") {
    const input = key || window.prompt("輸入調號（例如 C、G、D、F、Bb、Eb 或升記號數 -7 ~ 7）：", "C");
    if (input === null) return false;
    const fifths = parseKeyFifthsInput(input);
    if (fifths === null) {
      window.alert("無法辨識調號，請輸入如 C、G、F、Bb、Am 或 -7 到 7。");
      return false;
    }
    for (const part of parts) {
      const measures = Array.from(part.children).filter((c) => c.tagName === "measure");
      const mEl = measures[targetIdx] ?? measures[0];
      if (!mEl) continue;
      const attrs = ensureChildEl(xmlDoc, mEl, "attributes", true);
      const keyEl = ensureChildEl(xmlDoc, attrs, "key");
      const fifthsEl = ensureChildEl(xmlDoc, keyEl, "fifths");
      fifthsEl.textContent = String(fifths);
    }
    changed = true;
  } else if (id === "meas.time") {
    const input = key || window.prompt("輸入拍號（例如 4/4、3/4、2/4、6/8）：", "4/4");
    if (input === null) return false;
    const match = input.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!match) {
      window.alert("拍號格式錯誤，請輸入如 4/4 或 3/4。");
      return false;
    }
    const beats = Math.max(1, Math.min(16, Number(match[1])));
    const beatType = [1, 2, 4, 8, 16, 32].includes(Number(match[2])) ? Number(match[2]) : 4;
    for (const part of parts) {
      const measures = Array.from(part.children).filter((c) => c.tagName === "measure");
      const mEl = measures[targetIdx] ?? measures[0];
      if (!mEl) continue;
      const attrs = ensureChildEl(xmlDoc, mEl, "attributes", true);
      const timeEl = ensureChildEl(xmlDoc, attrs, "time");
      ensureChildEl(xmlDoc, timeEl, "beats").textContent = String(beats);
      ensureChildEl(xmlDoc, timeEl, "beat-type").textContent = String(beatType);
    }
    changed = true;
  } else if (id === "meas.tempo") {
    const existingTempo =
      xmlDoc.querySelector("sound[tempo]")?.getAttribute("tempo") ||
      xmlDoc.querySelector("per-minute")?.textContent ||
      "100";
    const input = key || window.prompt("輸入速度 BPM（40 ~ 240）：", existingTempo);
    if (input === null) return false;
    const bpm = Math.round(Number(input.trim()));
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 280) {
      window.alert("請輸入 30 ~ 280 之間的速度數值。");
      return false;
    }
    const mEl = firstPartMeasures[targetIdx] ?? firstPartMeasures[0]!;
    let soundEl = mEl.querySelector("sound[tempo]");
    if (!soundEl) {
      soundEl = xmlDoc.createElement("sound");
      mEl.insertBefore(soundEl, mEl.firstChild);
    }
    soundEl.setAttribute("tempo", String(bpm));

    const perMinEl = mEl.querySelector("direction direction-type metronome per-minute");
    if (perMinEl) {
      perMinEl.textContent = String(bpm);
    }
    changed = true;
  } else if (id === "brk.line" || id === "brk.page") {
    const attrName = id === "brk.line" ? "new-system" : "new-page";
    const breakIdx = targetIdx === 0 && firstPartMeasures.length > 1 ? 1 : targetIdx;
    if (breakIdx === 0) return false;
    for (const part of parts) {
      const measures = Array.from(part.children).filter((c) => c.tagName === "measure");
      const mEl = measures[breakIdx];
      if (!mEl) continue;
      let printEl = Array.from(mEl.children).find((c) => c.tagName === "print");
      if (!printEl) {
        printEl = xmlDoc.createElement("print");
        mEl.insertBefore(printEl, mEl.firstChild);
      }
      const cur = printEl.getAttribute(attrName) === "yes";
      if (cur) {
        printEl.removeAttribute(attrName);
      } else {
        printEl.setAttribute(attrName, "yes");
      }
    }
    changed = true;
  } else if (id === "meas.append") {
    let divs = 4;
    let beats = 4;
    let beatType = 4;
    for (const m of firstPartMeasures) {
      const d = m.querySelector("attributes > divisions")?.textContent;
      if (d && Number(d) > 0) divs = Number(d);
      const b = m.querySelector("attributes > time > beats")?.textContent;
      const bt = m.querySelector("attributes > time > beat-type")?.textContent;
      if (b && bt) {
        beats = Number(b);
        beatType = Number(bt);
      }
    }
    const measDur = Math.max(1, Math.round(beats * (4 / beatType) * divs));
    for (const part of parts) {
      const measures = Array.from(part.children).filter((c) => c.tagName === "measure");
      const newMeas = xmlDoc.createElement("measure");
      newMeas.setAttribute("number", String(measures.length + 1));
      const note = xmlDoc.createElement("note");
      note.appendChild(xmlDoc.createElement("rest"));
      const dur = xmlDoc.createElement("duration");
      dur.textContent = String(measDur);
      note.appendChild(dur);
      const voice = xmlDoc.createElement("voice");
      voice.textContent = "1";
      note.appendChild(voice);
      newMeas.appendChild(note);
      part.appendChild(newMeas);
    }
    changed = true;
  } else if (id === "meas.delete") {
    if (firstPartMeasures.length <= 1) return false;
    for (const part of parts) {
      const measures = Array.from(part.children).filter((c) => c.tagName === "measure");
      const target = measures[targetIdx];
      if (target) target.remove();
      const restMeasures = Array.from(part.children).filter((c) => c.tagName === "measure");
      restMeasures.forEach((m, i) => m.setAttribute("number", String(i + 1)));
    }
    changed = true;
  }

  if (!changed) return false;

  const newXml = new XMLSerializer().serializeToString(xmlDoc);
  const keepView = _app.viewMode;
  if (_app.adoptStaffXml(newXml)) {
    await _app.setViewMode(keepView);
    await _app.whenIdle();
    if (_scorePane) hideDiagnosticOverlays(_scorePane);
    _app.visual.afterRebuild();
    _onViewModeChange?.(_app.viewMode);
    _scorePane?.focus({ preventScroll: true });
    return true;
  }
  return false;
}

function observeTraditionalText(el: HTMLElement | null | undefined) {
  if (!el) return;
  let busy = false;
  const convert = () => {
    if (busy) return;
    const raw = el.textContent ?? "";
    const trad = toTraditionalUi(raw);
    if (trad !== raw) {
      busy = true;
      el.textContent = trad;
      busy = false;
    }
  };
  convert();
  const obs = new MutationObserver(convert);
  obs.observe(el, { childList: true, characterData: true, subtree: true });
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

// ---- 隱藏粉紅／紅色拍數診斷色塊與 +♩ 徽章（修譜模式關閉時才隱藏，修譜時保留供對拍用） ----
function parseRgbColor(colorStr: string | null | undefined): [number, number, number, number] | null {
  if (!colorStr || colorStr === "none" || colorStr === "transparent") return null;
  const m = colorStr.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
}

function isPinkDiagnosticColor(colorStr: string | null | undefined): boolean {
  const c = parseRgbColor(colorStr);
  if (!c || c[3] <= 0.01) return false;
  const [r, g, b] = c;
  return r >= 165 && r - g >= 45 && g <= b + 28;
}

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
  return (
    isOrangeCursorColor(st.stroke) ||
    isOrangeCursorColor(st.fill) ||
    isOrangeCursorColor(st.borderColor) ||
    isOrangeCursorColor(st.backgroundColor)
  );
}

function hideDiagnosticOverlays(scorePane: HTMLElement): void {
  if (_editMode) return;
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
        const attrDash = rect.getAttribute("stroke-dasharray");
        const attrStroke = rect.getAttribute("stroke");
        const attrFill = rect.getAttribute("fill");
        if (!attrDash && !rect.getAttribute("class")) continue;
        if (isProtectedCursorEl(rect)) continue;
        const st = getComputedStyle(rect);
        const dash = attrDash || st.strokeDasharray;
        if (!dash || dash === "none") continue;
        if (
          isPinkDiagnosticColor(attrStroke) ||
          isPinkDiagnosticColor(st.stroke) ||
          isPinkDiagnosticColor(attrFill) ||
          isPinkDiagnosticColor(st.fill)
        ) {
          rect.style.display = "none";
        }
      }

      for (const txt of svg.querySelectorAll<SVGTextElement>("text")) {
        const content = (txt.textContent || "").trim();
        if (!content) continue;
        if (!(/^[+\-−]/.test(content) || /[♩♪♫♬𝅝𝅗𝅥𝅘𝅥𝅘𝅥𝅮𝅘𝅥𝅯]/.test(content) || content.length <= 6)) continue;
        if (isProtectedCursorEl(txt)) continue;
        const st = getComputedStyle(txt);
        const pink = isPinkDiagnosticColor(st.fill) || isPinkDiagnosticColor(txt.getAttribute("fill"));
        if (!pink) continue;
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

      for (const g of svg.querySelectorAll<SVGGElement>("g[class]")) {
        const cls = (g.getAttribute("class") || "").toLowerCase();
        if (!/(err|warn|mismatch|overfill|underfill|beat-diff|diag)/.test(cls)) continue;
        if (isProtectedCursorEl(g)) continue;
        if (resolveNoteIdAt(g) === null) g.style.display = "none";
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
      const badgeText = (el.textContent || "").trim();
      const cls = (el.className || "").toString().toLowerCase();
      if (!badgeText && !/(err|warn|mismatch|diag)/.test(cls)) continue;
      if (isProtectedCursorEl(el)) continue;
      const st = getComputedStyle(el);
      const dashedPink = st.borderStyle.includes("dashed") && isPinkDiagnosticColor(st.borderColor);
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

// ---- 播放游標偵測 ＋ 簡譜延音橫線（—）與連續休止符（0）動態游標推進 ＋ 換行防截斷守護 ----
interface Box2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface CursorTarget {
  svg: SVGSVGElement;
  box: Box2D;
  relStart?: number;
  relEnd?: number;
}

let _playbackGuardRaf = 0;
let _hiddenCursorEl: HTMLElement | SVGElement | null = null;
let _sustainState: {
  key: string;
  enterMs: number;
  noteDur: number;
  totalWindowSec: number;
  lastCursorLeft: number;
  lastCursorTop: number;
  lastProgressVal: number;
  matchedSvg: SVGSVGElement;
  origBox: Box2D;
  origStyle: {
    rx: string;
    ry: string;
    fill: string;
    stroke: string;
    strokeWidth: string;
  };
  sustainTargets: CursorTarget[];
  restTargets: CursorTarget[];
} | null = null;

function isSustainDashText(s: string): boolean {
  const t = s.trim();
  return t === "-" || t === "–" || t === "—" || t === "−" || t === "\u2015" || t === "\u2500";
}

function isRestZeroText(s: string): boolean {
  const t = s.trim();
  return t === "0" || t === "0·" || t === "0.";
}

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
      if (st.opacity === "0" && el !== _hiddenCursorEl) continue;
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
      if (st.opacity === "0" && rect !== _hiddenCursorEl) continue;
      if (!isOrangeCursorColor(st.stroke) && !isOrangeCursorColor(st.fill)) continue;
      const r = rect.getBoundingClientRect();
      if (r.width > 1 && r.width <= 60 && r.height >= 16) return { el: rect, rect: r };
    }
    for (const div of page.querySelectorAll<HTMLElement>("div")) {
      const st = getComputedStyle(div);
      if (st.display === "none" || st.visibility === "hidden") continue;
      if (st.opacity === "0" && div !== _hiddenCursorEl) continue;
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

function getNoteCoreMetrics(
  el: SVGGraphicsElement,
  invSvgCtm: DOMMatrix,
  fallbackBox: Box2D,
): { box: Box2D; midY: number; height: number } {
  const texts = el.querySelectorAll<SVGTextElement>("text");
  let bestBox: Box2D | null = null;
  let bestH = 0;

  for (const t of texts) {
    const str = (t.textContent || "").trim();
    if (!/^[1-7xX0]/.test(str)) continue;
    const b = unionBoxInSvgRoot(t, invSvgCtm, null);
    if (!b) continue;
    const h = b.maxY - b.minY;
    if (h > bestH) {
      bestH = h;
      bestBox = b;
    }
  }

  if (bestBox && bestH >= 6) {
    return {
      box: bestBox,
      midY: (bestBox.minY + bestBox.maxY) * 0.5,
      height: bestH,
    };
  }
  return {
    box: fallbackBox,
    midY: (fallbackBox.minY + fallbackBox.maxY) * 0.5,
    height: Math.max(12, fallbackBox.maxY - fallbackBox.minY),
  };
}

function findSustainBoxesForNote(
  svg: SVGSVGElement,
  invSvgCtm: DOMMatrix,
  noteId: ElementId,
  coreBox: Box2D,
  coreMidY: number,
  coreH: number,
): Box2D[] {
  if (!_app) return [];

  const rowTol = Math.max(22, coreH * 1.15);
  const dashVerticalTol = Math.max(11, coreH * 0.6);

  const sameIdSustains: Box2D[] = [];
  const nearbySustains: Box2D[] = [];
  const sustainEls = new Set<Element>();
  let nextBoundaryMinX = Infinity;

  for (const g of svg.querySelectorAll<SVGGElement>("g")) {
    const entry = _app.syncView.entryAt(g);
    if (!entry) continue;
    const b = unionBoxInSvgRoot(g, invSvgCtm, null);
    if (!b) continue;
    const midY = (b.minY + b.maxY) * 0.5;
    if (Math.abs(midY - coreMidY) > rowTol) continue;

    if (entry.kind === "note" && entry.id !== noteId) {
      const m = getNoteCoreMetrics(g, invSvgCtm, b);
      if (m.box.minX > coreBox.maxX - 1 && m.box.minX < nextBoundaryMinX) {
        nextBoundaryMinX = m.box.minX;
      }
      continue;
    }

    if ((entry.kind as string) === "rest") {
      if (b.minX > coreBox.maxX - 1 && b.minX < nextBoundaryMinX) {
        nextBoundaryMinX = b.minX;
      }
      continue;
    }

    if (entry.kind === "sustain") {
      sustainEls.add(g);
      const cx = (b.minX + b.maxX) * 0.5;
      if (entry.id === noteId) {
        sameIdSustains.push(b);
      } else if (cx > coreBox.maxX) {
        nearbySustains.push(b);
      }
    }
  }

  for (const el of svg.querySelectorAll<SVGGraphicsElement>("text, line, rect, path")) {
    if (el.closest(".sl-ab-band, .sl-ab-marker, .sl-sustain-cursor")) continue;
    let covered = false;
    for (const sg of sustainEls) {
      if (sg.contains(el)) { covered = true; break; }
    }
    if (covered) continue;

    const entry = _app.syncView.entryAt(el);
    if (!entry || entry.kind !== "sustain") continue;
    const b = unionBoxInSvgRoot(el, invSvgCtm, null);
    if (!b) continue;
    const midY = (b.minY + b.maxY) * 0.5;
    if (Math.abs(midY - coreMidY) > rowTol) continue;

    const cx = (b.minX + b.maxX) * 0.5;
    if (entry.id === noteId) {
      sameIdSustains.push(b);
    } else if (cx > coreBox.maxX) {
      nearbySustains.push(b);
    }
  }

  for (const txt of svg.querySelectorAll<SVGTextElement>("text")) {
    if (!isRestZeroText(txt.textContent || "")) continue;
    const entry = _app.syncView.entryAt(txt);
    if (entry && entry.kind === "lyric") continue;
    const b = unionBoxInSvgRoot(txt, invSvgCtm, null);
    if (!b) continue;
    const midY = (b.minY + b.maxY) * 0.5;
    if (Math.abs(midY - coreMidY) <= rowTol && b.minX > coreBox.maxX - 1 && b.minX < nextBoundaryMinX) {
      nextBoundaryMinX = b.minX;
    }
  }

  let chosen =
    sameIdSustains.length > 0
      ? sameIdSustains
      : nearbySustains.filter((b) => (b.minX + b.maxX) * 0.5 < nextBoundaryMinX);

  if (chosen.length === 0) {
    const dashTexts: Box2D[] = [];
    for (const txt of svg.querySelectorAll<SVGTextElement>("text")) {
      if (!isSustainDashText(txt.textContent || "")) continue;
      const entry = _app.syncView.entryAt(txt);
      if (entry && entry.kind === "lyric") continue;
      const b = unionBoxInSvgRoot(txt, invSvgCtm, null);
      if (!b) continue;
      const midY = (b.minY + b.maxY) * 0.5;
      const cx = (b.minX + b.maxX) * 0.5;
      if (Math.abs(midY - coreMidY) <= dashVerticalTol && cx > coreBox.maxX && cx < nextBoundaryMinX) {
        dashTexts.push(b);
      }
    }
    chosen = dashTexts;
  }

  if (chosen.length === 0) {
    const dashShapes: Box2D[] = [];
    for (const shape of svg.querySelectorAll<SVGGraphicsElement>("line, rect, path")) {
      if (shape.closest(".sl-ab-band, .sl-ab-marker, .sl-sustain-cursor")) continue;
      if (isProtectedCursorEl(shape)) continue;
      const entry = _app.syncView.entryAt(shape);
      if (entry && (entry.kind === "note" || entry.kind === "lyric" || (entry.kind as string) === "rest")) continue;
      const b = unionBoxInSvgRoot(shape, invSvgCtm, null);
      if (!b) continue;
      const bw = b.maxX - b.minX;
      const bh = b.maxY - b.minY;
      const midY = (b.minY + b.maxY) * 0.5;
      const cx = (b.minX + b.maxX) * 0.5;
      if (
        bw >= 4 &&
        bw <= 36 &&
        bh <= 5.5 &&
        Math.abs(midY - coreMidY) <= dashVerticalTol &&
        cx > coreBox.maxX &&
        cx < nextBoundaryMinX
      ) {
        dashShapes.push(b);
      }
    }
    chosen = dashShapes;
  }

  chosen.sort((a, b) => a.minX - b.minX);
  return chosen;
}

function findFollowingRestTargets(
  scorePane: HTMLElement,
  info: NonNullable<ReturnType<typeof getTimeline>>,
  noteId: ElementId,
  noteSvg: SVGSVGElement,
  coreBox: Box2D,
  coreMidY: number,
  coreH: number,
  noteSpan: { from: number; to: number },
  pass: number,
): { targets: CursorTarget[]; nextNoteStart: number | null } {
  if (!_app) return { targets: [], nextNoteStart: null };

  const svgs = Array.from(scorePane.querySelectorAll<SVGSVGElement>(".score-page-wrap svg"));
  const noteSvgIdx = svgs.indexOf(noteSvg);
  if (noteSvgIdx < 0) return { targets: [], nextNoteStart: null };

  const rowTol = Math.max(18, coreH * 1.05);
  const minRestH = Math.max(6, coreH * 0.45);

  let nextNote: { t: number; svgIdx: number; coreBox: Box2D; midY: number } | null = null;
  const seenNoteIds = new Set<ElementId>();

  for (let sIdx = noteSvgIdx; sIdx < svgs.length; sIdx++) {
    const svg = svgs[sIdx]!;
    const ctm = svg.getScreenCTM();
    if (!ctm) continue;
    const inv = ctm.inverse();

    for (const g of svg.querySelectorAll<SVGGElement>("g")) {
      const entry = _app.syncView.entryAt(g);
      if (!entry || entry.kind !== "note" || entry.id === noteId || seenNoteIds.has(entry.id)) continue;
      seenNoteIds.add(entry.id);
      const t = anchorSeconds(info.tl, info.spq, { id: entry.id, pass });
      if (t === null || t < noteSpan.to - 0.008) continue;
      if (nextNote && t >= nextNote.t) continue;
      const b = unionBoxInSvgRoot(g, inv, null);
      if (!b) continue;
      const m = getNoteCoreMetrics(g, inv, b);
      nextNote = { t, svgIdx: sIdx, coreBox: m.box, midY: m.midY };
    }
  }

  const nextNoteStart = nextNote ? nextNote.t : null;
  const maxSvgIdx = nextNote ? nextNote.svgIdx : noteSvgIdx;

  if (nextNoteStart !== null && nextNoteStart <= noteSpan.to + 0.03) {
    return { targets: [], nextNoteStart };
  }

  const collected: { svg: SVGSVGElement; box: Box2D; svgIdx: number; midY: number; relStart?: number; relEnd?: number }[] = [];

  for (let sIdx = noteSvgIdx; sIdx <= maxSvgIdx; sIdx++) {
    const svg = svgs[sIdx]!;
    const ctm = svg.getScreenCTM();
    if (!ctm) continue;
    const inv = ctm.inverse();

    const candidateBoxes: { box: Box2D; restId: ElementId | null }[] = [];
    const coveredTexts = new Set<Element>();

    for (const g of svg.querySelectorAll<SVGGElement>("g")) {
      const entry = _app.syncView.entryAt(g);
      if (!entry || (entry.kind as string) !== "rest") continue;
      const b = unionBoxInSvgRoot(g, inv, null);
      if (!b) continue;
      const m = getNoteCoreMetrics(g, inv, b);
      candidateBoxes.push({ box: m.box, restId: entry.id });
      g.querySelectorAll("text").forEach((t) => coveredTexts.add(t));
    }

    for (const txt of svg.querySelectorAll<SVGTextElement>("text")) {
      if (coveredTexts.has(txt)) continue;
      if (!isRestZeroText(txt.textContent || "")) continue;
      const entry = _app.syncView.entryAt(txt);
      if (entry && entry.kind === "lyric") continue;
      const b = unionBoxInSvgRoot(txt, inv, null);
      if (!b) continue;
      if (b.maxY - b.minY < minRestH) continue;
      candidateBoxes.push({ box: b, restId: null });
    }

    const deduped: { box: Box2D; restId: ElementId | null }[] = [];
    for (const cand of candidateBoxes) {
      const cx = (cand.box.minX + cand.box.maxX) * 0.5;
      const cy = (cand.box.minY + cand.box.maxY) * 0.5;
      const dup = deduped.find((ex) => {
        const exX = (ex.box.minX + ex.box.maxX) * 0.5;
        const exY = (ex.box.minY + ex.box.maxY) * 0.5;
        return Math.abs(cx - exX) <= 4 && Math.abs(cy - exY) <= 6;
      });
      if (!dup) {
        deduped.push(cand);
      } else if (dup.restId === null && cand.restId !== null) {
        dup.restId = cand.restId;
      }
    }

    for (const cand of deduped) {
      const b = cand.box;
      const cx = (b.minX + b.maxX) * 0.5;
      const midY = (b.minY + b.maxY) * 0.5;
      const onStartRow = sIdx === noteSvgIdx && Math.abs(midY - coreMidY) <= rowTol;
      const onEndRow = nextNote !== null && sIdx === nextNote.svgIdx && Math.abs(midY - nextNote.midY) <= rowTol;

      if (onStartRow && onEndRow) {
        if (cx <= coreBox.maxX + 1 || cx >= nextNote!.coreBox.minX - 1) continue;
      } else if (onStartRow) {
        if (cx <= coreBox.maxX + 1) continue;
      } else if (onEndRow) {
        if (cx >= nextNote!.coreBox.minX - 1) continue;
      } else {
        if (sIdx === noteSvgIdx && midY <= coreMidY + rowTol) continue;
        if (nextNote && sIdx === nextNote.svgIdx && midY >= nextNote.midY - rowTol) continue;
        if (!nextNote && sIdx > noteSvgIdx) continue;
      }

      let relStart: number | undefined;
      let relEnd: number | undefined;
      if (cand.restId !== null) {
        const rs = spanSeconds(info.tl, info.spq, { id: cand.restId, pass }, { id: cand.restId, pass });
        if (rs && rs.to > rs.from && rs.from >= noteSpan.to - 0.03) {
          relStart = rs.from - noteSpan.from;
          relEnd = rs.to - noteSpan.from;
        }
      }

      collected.push({
        svg,
        box: b,
        svgIdx: sIdx,
        midY,
        relStart,
        relEnd,
      });
    }
  }

  collected.sort((a, b) => a.svgIdx - b.svgIdx || a.midY - b.midY);
  const withRow: (typeof collected[number] & { rowGroup: number })[] = [];
  let rowGroup = 0;
  let anchorSvg = -1;
  let anchorMidY = 0;

  for (const item of collected) {
    if (item.svgIdx !== anchorSvg || Math.abs(item.midY - anchorMidY) > rowTol) {
      rowGroup++;
      anchorSvg = item.svgIdx;
      anchorMidY = item.midY;
    }
    withRow.push({ ...item, rowGroup });
  }

  withRow.sort((a, b) => a.svgIdx - b.svgIdx || a.rowGroup - b.rowGroup || a.box.minX - b.box.minX);
  return {
    targets: withRow.map(({ svg, box, relStart, relEnd }) => ({ svg, box, relStart, relEnd })),
    nextNoteStart,
  };
}

function renderGhostCursor(
  scorePane: HTMLElement,
  target: CursorTarget,
  matchedSvg: SVGSVGElement,
  origBox: Box2D,
  origStyle: { rx: string; ry: string; fill: string; stroke: string; strokeWidth: string },
): DOMRect {
  for (const stale of scorePane.querySelectorAll(".sl-sustain-cursor")) {
    if (stale.parentNode !== target.svg) stale.remove();
  }

  let ghost = target.svg.querySelector<SVGRectElement>(".sl-sustain-cursor");
  if (!ghost) {
    ghost = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    ghost.setAttribute("class", "sl-sustain-cursor");
    ghost.setAttribute("pointer-events", "none");
    target.svg.appendChild(ghost);
  }

  const origW = Math.max(10, origBox.maxX - origBox.minX);
  const origH = Math.max(12, origBox.maxY - origBox.minY);
  const origMidY = (origBox.minY + origBox.maxY) * 0.5;
  const targetMidY = (target.box.minY + target.box.maxY) * 0.5;
  const sameLineAsOrig = target.svg === matchedSvg && Math.abs(targetMidY - origMidY) <= Math.max(24, origH * 0.7);

  const targetW = Math.max(origW * 0.9, target.box.maxX - target.box.minX + 12);
  const cx = (target.box.minX + target.box.maxX) * 0.5;
  const y = sameLineAsOrig ? origBox.minY : target.box.minY - 6;
  const h = sameLineAsOrig ? origH : Math.max(origH, target.box.maxY - target.box.minY + 12);

  ghost.setAttribute("x", String(cx - targetW * 0.5));
  ghost.setAttribute("y", String(y));
  ghost.setAttribute("width", String(targetW));
  ghost.setAttribute("height", String(h));
  ghost.setAttribute("rx", origStyle.rx);
  ghost.setAttribute("ry", origStyle.ry);
  ghost.setAttribute("fill", origStyle.fill);
  ghost.setAttribute("stroke", origStyle.stroke);
  ghost.setAttribute("stroke-width", origStyle.strokeWidth);

  return ghost.getBoundingClientRect();
}

function stepCachedTargets(
  scorePane: HTMLElement,
  officialEl: HTMLElement | SVGElement | null,
  elapsedSec: number,
): DOMRect | null {
  if (!_sustainState) return null;
  const { noteDur, totalWindowSec, sustainTargets, restTargets, matchedSvg, origBox, origStyle } = _sustainState;

  let activeTarget: CursorTarget | null = null;

  if (elapsedSec < noteDur || restTargets.length === 0) {
    if (sustainTargets.length > 0) {
      const totalSteps = sustainTargets.length + 1;
      const step = Math.min(sustainTargets.length, Math.max(0, Math.floor((elapsedSec / noteDur) * totalSteps)));
      if (step > 0) activeTarget = sustainTargets[step - 1]!;
    }
  } else {
    const restDurTotal = Math.max(0.08, totalWindowSec - noteDur);
    const allHaveTiming = restTargets.every(
      (rt, idx) =>
        rt.relStart !== undefined &&
        rt.relEnd !== undefined &&
        rt.relEnd > rt.relStart &&
        (idx === 0 || rt.relStart >= (restTargets[idx - 1]!.relStart ?? 0) - 0.01),
    );
    const exactMatch = allHaveTiming
      ? restTargets.find(
          (rt) => elapsedSec >= rt.relStart! - 0.01 && elapsedSec < rt.relEnd! - 0.01,
        )
      : undefined;

    if (exactMatch) {
      activeTarget = exactMatch;
    } else if (allHaveTiming && elapsedSec >= restTargets[restTargets.length - 1]!.relStart! - 0.01) {
      activeTarget = restTargets[restTargets.length - 1]!;
    } else {
      const restElapsed = Math.max(0, elapsedSec - noteDur);
      const rIdx = Math.min(restTargets.length - 1, Math.floor((restElapsed / restDurTotal) * restTargets.length));
      activeTarget = restTargets[rIdx]!;
    }
  }

  if (!activeTarget) {
    if (_hiddenCursorEl) {
      _hiddenCursorEl.style.opacity = "";
      _hiddenCursorEl = null;
    }
    scorePane.querySelectorAll(".sl-sustain-cursor").forEach((el) => el.remove());
    return null;
  }

  if (officialEl) {
    if (_hiddenCursorEl && _hiddenCursorEl !== officialEl) {
      _hiddenCursorEl.style.opacity = "";
    }
    _hiddenCursorEl = officialEl;
    officialEl.style.opacity = "0";
  }

  return renderGhostCursor(scorePane, activeTarget, matchedSvg, origBox, origStyle);
}

function updateSustainCursor(
  scorePane: HTMLElement,
  cursor: { el: HTMLElement | SVGElement; rect: DOMRect } | null,
): DOMRect | null {
  if (!_app || _app.mode === "mixed") {
    cleanupSustainCursor(scorePane);
    return null;
  }

  const nowMs = performance.now();

  if (!cursor) {
    if (_sustainState && _sustainState.restTargets.length > 0) {
      const elapsedSec = (nowMs - _sustainState.enterMs) / 1000;
      if (elapsedSec <= _sustainState.totalWindowSec + 0.45) {
        return stepCachedTargets(scorePane, null, Math.min(elapsedSec, _sustainState.totalWindowSec));
      }
    }
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

  let matchedId: ElementId | null = null;
  let matchedBox: Box2D | null = null;
  let matchedEl: SVGGraphicsElement | null = null;
  let matchedKind: "note" | "other" = "note";
  let bestScore = Infinity;
  const curCenterX = (cursor.rect.left + cursor.rect.right) * 0.5;
  const curCenterY = (cursor.rect.top + cursor.rect.bottom) * 0.5;

  for (const g of svg.querySelectorAll<SVGGElement>("g")) {
    const entry = _app.syncView.entryAt(g);
    if (!entry) continue;
    const kind = entry.kind as string;
    if (kind !== "note" && kind !== "rest" && kind !== "sustain") continue;
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
    const dist =
      Math.abs((gr.left + gr.right) * 0.5 - curCenterX) +
      Math.abs((gr.top + gr.bottom) * 0.5 - curCenterY) * 0.25;
    if (dist < bestScore) {
      const box = unionBoxInSvgRoot(g, invSvgCtm, null);
      if (box) {
        bestScore = dist;
        if (kind === "note") {
          matchedKind = "note";
          matchedId = entry.id;
          matchedBox = box;
          matchedEl = g;
        } else {
          matchedKind = "other";
          matchedId = null;
          matchedBox = null;
          matchedEl = null;
        }
      }
    }
  }

  for (const txt of svg.querySelectorAll<SVGTextElement>("text")) {
    const content = txt.textContent || "";
    if (!isRestZeroText(content) && !isSustainDashText(content)) continue;
    const entry = _app.syncView.entryAt(txt);
    if (entry && entry.kind === "lyric") continue;
    const tr = txt.getBoundingClientRect();
    if (tr.width <= 0 && tr.height <= 0) continue;
    if (
      tr.right < cursor.rect.left - 4 ||
      tr.left > cursor.rect.right + 4 ||
      tr.bottom < cursor.rect.top - 4 ||
      tr.top > cursor.rect.bottom + 4
    ) {
      continue;
    }
    const dist =
      Math.abs((tr.left + tr.right) * 0.5 - curCenterX) +
      Math.abs((tr.top + tr.bottom) * 0.5 - curCenterY) * 0.25;
    if (dist <= bestScore) {
      bestScore = dist;
      matchedKind = "other";
      matchedId = null;
      matchedBox = null;
      matchedEl = null;
    }
  }

  if (matchedKind !== "note" || matchedId === null || !matchedBox || !matchedEl) {
    cleanupSustainCursor(scorePane);
    return null;
  }

  const pageIdx = Array.from(scorePane.querySelectorAll(".score-page-wrap")).indexOf(page ?? svg);
  const noteKey = `${pageIdx}:${matchedId}`;
  const curProgress = _progressEl ? Number(_progressEl.value) : 0;

  const isSameCursorSpot =
    _sustainState !== null &&
    _sustainState.key === noteKey &&
    Math.abs(cursor.rect.left - _sustainState.lastCursorLeft) <= 6 &&
    Math.abs(cursor.rect.top - _sustainState.lastCursorTop) <= 6;

  const progressRewound =
    _sustainState !== null &&
    _progressEl !== null &&
    curProgress < _sustainState.lastProgressVal - 0.005;

  const needRebuild =
    !isSameCursorSpot ||
    progressRewound ||
    (_sustainState !== null &&
      (nowMs - _sustainState.enterMs) / 1000 > _sustainState.totalWindowSec + 0.85);

  if (needRebuild) {
    const info = getTimeline();
    if (!info) {
      cleanupSustainCursor(scorePane);
      return null;
    }
    const pass = 1;
    const span = spanSeconds(info.tl, info.spq, { id: matchedId, pass }, { id: matchedId, pass });
    if (!span || span.to <= span.from) {
      cleanupSustainCursor(scorePane);
      return null;
    }

    const core = getNoteCoreMetrics(matchedEl, invSvgCtm, matchedBox);
    const sustainBoxes = findSustainBoxesForNote(svg, invSvgCtm, matchedId, core.box, core.midY, core.height);
    const { targets: restTargets, nextNoteStart } = findFollowingRestTargets(
      scorePane,
      info,
      matchedId,
      svg,
      core.box,
      core.midY,
      core.height,
      span,
      pass,
    );

    if (sustainBoxes.length === 0 && restTargets.length === 0) {
      cleanupSustainCursor(scorePane);
      return null;
    }

    const noteDur = Math.max(0.08, span.to - span.from);
    const restGap =
      restTargets.length === 0
        ? 0
        : nextNoteStart !== null && nextNoteStart > span.to + 0.03
          ? nextNoteStart - span.to
          : restTargets.length * Math.max(0.18, info.spq);

    const origBox =
      cursor.el instanceof SVGGraphicsElement
        ? unionBoxInSvgRoot(cursor.el, invSvgCtm, null) ?? clientRectToSvgRoot(cursor.rect, invSvgCtm)
        : clientRectToSvgRoot(cursor.rect, invSvgCtm);

    const st = getComputedStyle(cursor.el);
    const origStyle = {
      rx: cursor.el.getAttribute("rx") || "4",
      ry: cursor.el.getAttribute("ry") || "4",
      fill: isOrangeCursorColor(st.fill)
        ? st.fill
        : isOrangeCursorColor(st.backgroundColor)
          ? st.backgroundColor
          : "rgba(234, 88, 12, 0.22)",
      stroke: isOrangeCursorColor(st.stroke)
        ? st.stroke
        : isOrangeCursorColor(st.borderColor)
          ? st.borderColor
          : "#ea580c",
      strokeWidth: cursor.el.getAttribute("stroke-width") || "1.5",
    };

    _sustainState = {
      key: noteKey,
      enterMs: nowMs,
      noteDur,
      totalWindowSec: noteDur + restGap,
      lastCursorLeft: cursor.rect.left,
      lastCursorTop: cursor.rect.top,
      lastProgressVal: curProgress,
      matchedSvg: svg,
      origBox,
      origStyle,
      sustainTargets: sustainBoxes.map((box) => ({ svg, box })),
      restTargets,
    };
  } else if (_sustainState) {
    _sustainState.lastProgressVal = curProgress;
  }

  const elapsedSec = (nowMs - _sustainState!.enterMs) / 1000;
  return stepCachedTargets(scorePane, cursor.el, Math.min(elapsedSec, _sustainState!.totalWindowSec));
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
    const activeRect = updateSustainCursor(scorePane, cursor) ?? cursor?.rect ?? null;

    if (activeRect) {
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

function wireDirectScoreSelection(scorePane: HTMLElement) {
  const LONG_PRESS_MS = 350;
  const MOVE_CANCEL_PX = 10;

  let suppressClick = false;

  let mouseStart: { x: number; y: number; startId: ElementId | null } | null = null;
  let mouseDragging = false;

  const cleanupMouse = () => {
    mouseStart = null;
    mouseDragging = false;
    _abPreviewRange = null;
  };

  scorePane.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (_editMode && !_rangePickMode) return;
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
    if (_editMode && !_rangePickMode) return;
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

let _preloadScheduled = false;
function scheduleBackgroundPreload() {
  if (_preloadScheduled) return;
  _preloadScheduled = true;

  const warmModules = () => {
    void import("./omrkit/runtime.browser")
      .then((m) => m.browserRuntime.prepare("det"))
      .catch(() => {});
    void import("./rasteromr/browser").catch(() => {});
    void import("./staffomr/browser").catch(() => {});
    void import("./outlineomr/browser").catch(() => {});
  };

  const ric = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;

  if (typeof ric === "function") {
    ric(warmModules, { timeout: 600 });
  } else {
    setTimeout(warmModules, 80);
  }
}

async function initEngine(opts: MountShellOptions): Promise<App> {
  _onZoomChange = opts.onZoomChange;
  _onRangeChange = opts.onRangeChange;
  _onEditModeChange = opts.onEditModeChange;
  _onViewModeChange = opts.onViewModeChange;
  _scorePane = opts.scorePane;
  _progressEl = opts.progressEl ?? null;
  _editToggleBtn = opts.editToggleBtn ?? null;
  _editPanel = opts.editPanel ?? null;
  _selInfoEl = opts.visualEls?.selInfo ?? null;
  if (_app) return _app;
  if (_appPromise) return _appPromise;

  _appPromise = (async () => {
    initLang();
    setMeasureBackend(browserMeasure);

    const runtimePrep = import("./omrkit/runtime.browser")
      .then((m) => m.browserRuntime.prepare("det"))
      .catch(() => {});

    const fontsReady = registerBravura().then(() =>
      ensureFontsReady([
        { family: "Bravura", size: 40 },
        { family: "Bravura Text", size: 20 },
        { family: "Noto Serif TC", size: 28 },
      ]),
    );

    const [meta] = await Promise.all([MetaData.shared(), fontsReady]);
    void runtimePrep;

    const app = new App(meta, opts.scorePane);
    app.statusEl = opts.statusEl ?? null;
    app.loadSettings();

    if (opts.visualEls) {
      app.visual.attach({
        ...opts.visualEls,
        palette: null,
        paletteBtn: null,
      });
      observeTraditionalText(opts.visualEls.mode);
      observeTraditionalText(opts.visualEls.selInfo);
      observeTraditionalText(opts.visualEls.beatCount);
    }
    observeTraditionalText(opts.statusEl);

    const origVisualEnabled = app.visualEnabled.bind(app);
    app.visualEnabled = () => _editMode && origVisualEnabled();
    app.visual.showPalette = false;

    app.mountEditor(opts.hiddenCodePane, SAMPLE);
    app.stopPlayback();
    app.clearPages();

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
    if (opts.progressEl) {
      app.playback.bindProgress(opts.progressEl, opts.timeEl ?? null);
      opts.progressEl.addEventListener("input", () => cleanupSustainCursor(opts.scorePane));
    }
    if (opts.speedSel) {
      app.playback.bindSpeedSelect(opts.speedSel);
      opts.speedSel.addEventListener("change", () => cleanupSustainCursor(opts.scorePane));
    }

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
          app.visual.afterRebuild();
          _onViewModeChange?.(app.viewMode);
          if (!_editMode) void persistCurrentScore();
        });
      }
      if (opts.viewSwitch) app.setViewModeButtons(opts.viewSwitch, opts.viewBtns);
    }

    preserveIconButton(opts.editToggleBtn);
    opts.editToggleBtn?.addEventListener("click", () => {
      if (_editMode) {
        void cancelEditMode();
      } else {
        enterEditMode();
      }
    });
    opts.editSaveBtn?.addEventListener("click", () => commitEditMode());
    opts.editDiscardBtn?.addEventListener("click", () => void cancelEditMode());

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
    const paneObserver = new MutationObserver((mutations) => {
      let hasNewPageOrSvg = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (
            node.classList.contains("score-page-wrap") ||
            node.tagName.toLowerCase() === "svg" ||
            node.querySelector(".score-page-wrap, svg")
          ) {
            hasNewPageOrSvg = true;
            break;
          }
        }
        if (hasNewPageOrSvg) break;
      }

      if (hasNewPageOrSvg && !diagScheduled) {
        diagScheduled = true;
        requestAnimationFrame(() => {
          diagScheduled = false;
          hideDiagnosticOverlays(opts.scorePane);
        });
      }
      if (app.playback.busy && !_playbackGuardRaf) {
        startPlaybackScrollGuard(opts.scorePane);
      }
    });
    paneObserver.observe(opts.scorePane, { childList: true, subtree: true });

    scheduleBackgroundPreload();

    _app = app;
    return app;
  })();

  return _appPromise;
}

async function recognizeAndRender(
  filesInput: File | readonly File[],
  opts: {
    kind?: OmrKind;
    onProgress?: (ratio: number | null) => void;
    onFirstPageReady?: () => void;
  } = {},
): Promise<{ engine: string; info: string }> {
  if (!_app) throw new Error("請先初始化引擎");
  const files = Array.isArray(filesInput) ? [...filesInput] : [filesInput as File];
  if (!files.length) throw new Error("未選擇任何檔案");

  const myGen = ++_loadGen;
  if (_editMode) await cancelEditMode();
  cleanupSustainCursor(_scorePane);
  clearAbLoop(true);
  _app.stopPlayback();
  _app.clearPages();

  const kind: OmrKind = opts.kind ?? "auto";
  const onProgress = opts.onProgress ?? (() => undefined);
  const first = files[0]!;
  const firstName = first.name.toLowerCase();

  onProgress(null);

  if (files.length === 1 && !firstName.endsWith(".pdf") && !/\.(png|jpe?g|webp)$/i.test(firstName)) {
    onProgress(0.45);
    const bytes = new Uint8Array(await first.arrayBuffer());
    _app.importBytes(bytes, first.name);
    onProgress(0.8);
    await _app.whenIdle();
    if (/\.(xml|musicxml)$/i.test(firstName) && _app.mode === "jp") {
      await _app.setViewMode("staff");
    }
    if (_app.pageEls.length === 0) {
      throw new Error(_app.status || "無法解析此樂譜檔案");
    }
    if (_scorePane) hideDiagnosticOverlays(_scorePane);
    _app.visual.afterRebuild();
    _onViewModeChange?.(_app.viewMode);
    void persistCurrentScore();
    onProgress(1);
    return { engine: "native-doc", info: "" };
  }

  let xml = "";
  let engine = "";

  if (files.length === 1 && kind !== "jianpu") {
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    if (isPdf(firstBytes, first.type || undefined)) {
      onProgress(0.15);
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
              onProgress: (d, t) => onProgress(0.2 + 0.72 * (d / Math.max(1, t))),
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
                onProgress: (d, t) => onProgress(0.2 + 0.72 * (d / Math.max(1, t))),
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

  if (!xml && kind !== "jianpu") {
    onProgress(0.12);
    const rb = await import("./rasteromr/browser");
    const rasterPdfs: Uint8Array[] = [];

    for (let i = 0; i < files.length; i++) {
      if (myGen !== _loadGen) return { engine: "cancelled", info: "" };
      const f = files[i]!;
      onProgress(0.15 + 0.15 * ((i + 1) / files.length));
      const isImg = /\.(png|jpe?g|webp)$/i.test(f.name) || f.type.startsWith("image/");
      const opt = isImg ? await maybeOptimizeImage(f) : { bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type || undefined };
      rasterPdfs.push(await rb.asRasterPdf(opt.bytes, opt.mime));
    }

    if (myGen !== _loadGen) return { engine: "cancelled", info: "" };
    onProgress(0.34);
    const probe = kind === "staff" ? null : await rb.probeRasterStaff(rasterPdfs[0]!);

    if (!probe || probe.isStaff) {
      let showedFirst = false;

      if (rasterPdfs.length > 1) {
        onProgress(0.4);
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
            _onViewModeChange?.(_app.viewMode);
            showedFirst = true;
            opts.onFirstPageReady?.();
          }
        }
      }

      onProgress(showedFirst ? 0.52 : 0.45);
      const res = await rb.recognizeRasterPdfs(rasterPdfs, {
        onPage: (d, t) => onProgress(0.45 + 0.48 * (d / Math.max(1, t))),
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

  if (!xml) {
    onProgress(null);
    const isImg = /\.(png|jpe?g|webp)$/i.test(first.name) || first.type.startsWith("image/");
    const opt = isImg ? await maybeOptimizeImage(first) : { bytes: new Uint8Array(await first.arrayBuffer()), mime: first.type || undefined };
    const { score } = await recognizeMusicppDetailed(opt.bytes, opt.mime);
    if (myGen !== _loadGen) return { engine: "cancelled", info: "" };
    onProgress(0.85);
    const out = omrEmitter("123").emit(score);
    if (out.kind !== "123") {
      throw new Error("簡譜轉出異常");
    }
    xml = scoreDocToMusicXml(out.doc);
    engine = "jianpu";
  }

  onProgress(0.95);
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
  _app.visual.afterRebuild();
  _onViewModeChange?.(_app.viewMode);
  void persistCurrentScore();
  onProgress(1);

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
      saveCurrentScore: () => Promise<boolean>;
      restoreLastScore: () => Promise<ScoreSnapshot | null>;
      clearLastScore: () => Promise<void>;
      setEditMode: (on: boolean) => void;
      commitEditMode: () => void;
      cancelEditMode: () => Promise<void>;
      isEditMode: () => boolean;
      getViewMode: () => ViewMode | null;
      runVisualAction: (id: string, key?: string) => Promise<boolean>;
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
    if (_editMode) await cancelEditMode();
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
    _app.visual.afterRebuild();
    _onViewModeChange?.(_app.viewMode);
    void persistCurrentScore();
  },
  getSnapshot() {
    return getCurrentSnapshot();
  },
  async loadSnapshot(snap) {
    if (!_app) return;
    _loadGen++;
    if (_editMode) await cancelEditMode();
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
    _app.visual.afterRebuild();
    _onViewModeChange?.(_app.viewMode);
    void persistCurrentScore();
  },
  async saveCurrentScore() {
    return persistCurrentScore();
  },
  async restoreLastScore() {
    if (!_app) return null;
    const saved = await readAutosaveSnapshot();
    if (!saved) return null;
    try {
      await restoreSnapshotInternal(saved);
      if (_app.pageEls.length === 0) return null;
      if (_scorePane) hideDiagnosticOverlays(_scorePane);
      _app.visual.afterRebuild();
      _onViewModeChange?.(_app.viewMode);
      return saved;
    } catch {
      return null;
    }
  },
  async clearLastScore() {
    await clearAutosaveSnapshot();
  },
  setEditMode(on) {
    if (on) enterEditMode();
    else void cancelEditMode();
  },
  commitEditMode() {
    commitEditMode();
  },
  async cancelEditMode() {
    await cancelEditMode();
  },
  isEditMode() {
    return _editMode;
  },
  getViewMode() {
    return _app ? _app.viewMode : null;
  },
  async runVisualAction(id, key = "") {
    if (!_app || !_editMode) return false;
    if (!_app.syncFresh()) _app.reloadNow();

    // 若尚未選取音符且非純導覽指令，先自動選取第一個元素，避免無選取導致動作無效
    if (!id.startsWith("nav.") && !id.startsWith("edit.") && !id.startsWith("mode.")) {
      const selTxt = (_selInfoEl?.textContent || "").trim();
      if (!selTxt || /未選|無選/.test(selTxt)) {
        _app.visual.runById("nav.next", "");
      }
    }

    const beforeText = _app.getText();
    const ok = _app.visual.runById(id, key);
    const changed = _app.getText() !== beforeText;

    // 針對調號、拍號、速度、換行、換頁、增刪小節，若底層未處理則以 MusicXML 後備方案執行
    if (
      (!ok || (!changed && ["meas.key", "meas.time", "meas.tempo", "brk.line", "brk.page", "meas.append", "meas.delete"].includes(id))) &&
      ["meas.key", "meas.time", "meas.tempo", "brk.line", "brk.page", "meas.append", "meas.delete"].includes(id)
    ) {
      const fbOk = await applyMusicXmlFallbackAction(id, key);
      _scorePane?.focus({ preventScroll: true });
      return fbOk;
    }

    _scorePane?.focus({ preventScroll: true });
    return ok;
  },
  toggleRangePick() {
    if (_editMode) void cancelEditMode();
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
    _app.visual.afterRebuild();
    _onViewModeChange?.(_app.viewMode);
    if (!_editMode) void persistCurrentScore();
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
