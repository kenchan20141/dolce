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

/** 對過大照片做安全高品質縮圖（僅針對長邊 > 2400px 或超過 450 萬像素），兼顧速度與辨識準確率。 */
async function maybeOptimizeImage(file: File): Promise<{ bytes: Uint8Array; mime?: string }> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || undefined;
  if (typeof createImageBitmap === "undefined") return { bytes: raw, mime };

  try {
    const bmp = await createImageBitmap(new Blob([raw], mime ? { type: mime } : {}));
    try {
      const maxSide = Math.max(bmp.width, bmp.height);
      const pixels = bmp.width * bmp.height;
      if (maxSide <= 2400 && pixels <= 4_500_000) {
        return { bytes: raw, mime };
      }

      const scale = Math.min(2200 / maxSide, Math.sqrt(3_600_000 / pixels));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));

      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d");
      if (!ctx) return { bytes: raw, mime };

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, 0, 0, w, h);

      const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.92));
      if (!blob) return { bytes: raw, mime };
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg" };
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

function clearAbBands() {
  _scorePane?.querySelectorAll(".sl-ab-band").forEach((el) => el.remove());
}

function paintAbBands() {
  clearAbBands();
  if (!_app || !_scorePane) return;
  if (!_abLoop && _abPendingStart === null) return;
  const info = _abLoop ? getTimeline() : null;
  const NS = "http://www.w3.org/2000/svg";

  for (const svg of _scorePane.querySelectorAll<SVGSVGElement>(".score-page-wrap svg")) {
    const matchedEls: SVGGraphicsElement[] = [];

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
        if (hit) {
          for (const nel of _app.painter.noteEls(id)) {
            if (nel.ownerSVGElement === svg) matchedEls.push(nel);
          }
        }
      }
    } else {
      const seenIds = new Set<ElementId>();
      for (const g of svg.querySelectorAll<SVGGElement>("g")) {
        const entry = _app.syncView.entryAt(g);
        if (!entry || entry.kind !== "note" || seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        let hit = false;
        if (_abPendingStart !== null && entry.id === _abPendingStart) hit = true;
        else if (_abLoop && info) {
          const t = anchorSeconds(info.tl, info.spq, { id: entry.id, pass: 1 });
          if (t !== null && t >= _abLoop.tFrom - 0.002 && t <= _abLoop.tTo + 0.002) hit = true;
        }
        if (hit) matchedEls.push(g);
      }
    }

    for (const el of matchedEls) {
      try {
        const box = el.getBBox();
        if (box.width <= 0 && box.height <= 0) continue;
        const pad = 4;
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("class", "sl-ab-band");
        rect.setAttribute("x", String(box.x - pad));
        rect.setAttribute("y", String(box.y - pad));
        rect.setAttribute("width", String(box.width + pad * 2));
        rect.setAttribute("height", String(box.height + pad * 2));
        rect.setAttribute("rx", "4");
        rect.setAttribute("fill", "rgba(91, 122, 98, 0.22)");
        rect.setAttribute("stroke", "#5b7a62");
        rect.setAttribute("stroke-width", "1.5");
        rect.setAttribute("pointer-events", "none");
        svg.appendChild(rect);
      } catch {
        // 忽略未渲染元素
      }
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

  scorePane.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.pointerType === "touch" && !_rangePickMode) return;
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
      if (b.width <= 0 || b.height <= 0) continue;
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
    const id = resolveNoteIdAt(e.target as Element | null);
    if (id === null) return;
    e.stopPropagation();
    e.preventDefault();

    if (_abPendingStart === null) {
      _abLoop = null;
      _abPendingStart = id;
      paintAbBands();
      notifyRange();
    } else if (_abPendingStart !== id) {
      applyAbLoopByIds(_abPendingStart, id);
    }
  }, true);
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
      onProgress(files.length > 1 ? `最佳化第 ${i + 1}/${files.length} 頁圖檔...` : "最佳化圖檔中...");
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
