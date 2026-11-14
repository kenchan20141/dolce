import "./styles.css";
import { MetaData } from "./smufl/smufl";
import { setMeasureBackend } from "./common/measure";
import { browserMeasure, ensureFontsReady } from "./common/measure.browser";
import { asset } from "./common/asset";
import { App, type ViewMode } from "./editor/app";
import type { DocFormatId } from "./editor/formats";
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
}

let _appPromise: Promise<App> | null = null;
let _app: App | null = null;
let _onZoomChange: ((z: number) => void) | undefined;

async function initEngine(opts: MountShellOptions): Promise<App> {
  _onZoomChange = opts.onZoomChange;
  if (_app) return _app;
  if (_appPromise) return _appPromise;

  _appPromise = (async () => {
    initLang();
    setMeasureBackend(browserMeasure);
    await registerBravura();
    await ensureFontsReady([
      { family: "Bravura", size: 40 },
      { family: "Bravura Text", size: 20 },
      { family: "PingFang SC", size: 28 },
    ]);
    const meta = await MetaData.shared();

    const app = new App(meta, opts.scorePane);
    app.statusEl = opts.statusEl ?? null;
    app.loadSettings();
    app.mountEditor(opts.hiddenCodePane, SAMPLE);
    app.stopPlayback();
    app.clearPages();

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
        btn.addEventListener("click", () => void app.setViewMode(mode));
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

    void import("./omrkit/runtime.browser").then((m) => m.browserRuntime.prepare("det")).catch(() => {});

    _app = app;
    return app;
  })();

  return _appPromise;
}

async function recognizeAndRender(
  filesInput: File | readonly File[],
  opts: { kind?: OmrKind; onProgress?: (msg: string) => void } = {},
): Promise<{ engine: string; info: string }> {
  if (!_app) throw new Error("請先初始化引擎");
  const files = Array.isArray(filesInput) ? [...filesInput] : [filesInput as File];
  if (!files.length) throw new Error("未選擇任何檔案");

  _app.stopPlayback();
  _app.clearPages();

  const kind: OmrKind = opts.kind ?? "auto";
  const onProgress = opts.onProgress ?? (() => undefined);
  const first = files[0]!;
  const firstName = first.name.toLowerCase();

  // 單一非圖片/PDF 的譜檔（MusicXML / ABC / 123 / jpwabc 等）直接由官方解析渲染
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
    return { engine: "native-doc", info: "樂譜載入完成" };
  }

  let xml = "";
  let engine = "";
  let info = "";

  // 1. 單一 PDF 矢量 / 轉曲五線譜
  if (files.length === 1 && kind !== "jianpu") {
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    if (isPdf(firstBytes, first.type || undefined)) {
      onProgress("分析 PDF 五線譜結構中...");
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
              onProgress: (d, t) => onProgress(`辨識矢量五線譜第 ${d}/${t} 頁...`),
              noteIds: false,
            });
            if (res.notes > 0 && res.musicxml) {
              xml = res.musicxml;
              engine = "vector-staff";
              info = `矢量五線譜 · ${res.pages} 頁 · ${res.notes} 音符`;
            }
          } else {
            const ob = await import("./outlineomr/browser");
            if (await ob.isOutlinedStaffPdf(pdfDoc.pdf, pdfDoc.OPS)) {
              const res = await ob.recognizeOutlinedPdf(pdfDoc, {
                onProgress: (d, t) => onProgress(`辨識轉曲五線譜第 ${d}/${t} 頁...`),
                noteIds: false,
              });
              if (res.notes > 0 && res.musicxml) {
                xml = res.musicxml;
                engine = "outlined-staff";
                info = `轉曲五線譜 · ${res.pages} 頁 · ${res.notes} 音符`;
              }
            }
          }
        } finally {
          pdfDoc.pdf.destroy?.();
        }
      }
    }
  }

  // 2. 位圖五線譜（支援單張或多張依序合併，或掃描 PDF）
  if (!xml && kind !== "jianpu") {
    onProgress("1/4 載入五線譜引擎...");
    const rb = await import("./rasteromr/browser");
    const rasterPdfs: Uint8Array[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const b = new Uint8Array(await f.arrayBuffer());
      onProgress(files.length > 1
        ? `2/4 轉換第 ${i + 1}/${files.length} 頁圖檔 (${Math.round(b.length / 1024)} KB)...`
        : `2/4 轉換圖檔 (${Math.round(b.length / 1024)} KB)...`);
      rasterPdfs.push(await rb.asRasterPdf(b, f.type || undefined));
    }

    onProgress("3/4 偵測五線譜結構...");
    const probe = kind === "staff" ? null : await rb.probeRasterStaff(rasterPdfs[0]!);
    if (!probe || probe.isStaff) {
      let ocrCount = 0;
      onProgress("4/4 啟動五線譜辨識與 AI 文字偵測...");
      const res = await rb.recognizeRasterPdfs(rasterPdfs, {
        onPage: (d, t) => onProgress(`AI 辨識五線譜第 ${d}/${t} 頁...`),
        onOcr: (ocrKind, ms) => {
          ocrCount++;
          onProgress(`4/4 AI 文字識別中 (#${ocrCount} ${ocrKind} · ${Math.round(ms)}ms)...`);
        },
        cancelled: () => false,
        ...(probe?.pages ? { firstPages: probe.pages } : {}),
      });
      if (res.xml) {
        xml = res.xml;
        engine = "raster-staff";
        info = `AI 五線譜 · ${res.stats.pages} 頁 · ${res.stats.notes} 音符`;
      } else if (kind === "staff") {
        throw new Error("未在檔案中偵測到五線譜，請確認譜面清晰度或改選「自動判別 / 簡譜」");
      }
    }
  }

  // 3. 簡譜圖片 / 掃描簡譜 PDF
  if (!xml) {
    onProgress("AI 辨識簡譜中...");
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    const { score } = await recognizeMusicppDetailed(firstBytes, first.type || undefined);
    const out = omrEmitter("123").emit(score);
    if (out.kind !== "123") {
      throw new Error("簡譜轉出格式異常");
    }
    xml = scoreDocToMusicXml(out.doc);
    engine = "jianpu";
    info = files.length > 1
      ? `AI 簡譜 · ${score.rows.length} 行（已辨識第 1 頁）`
      : `AI 簡譜 · ${score.rows.length} 行`;
  }

  onProgress("正在排版樂譜頁面...");
  if (!_app.adoptStaffXml(xml)) {
    throw new Error(_app.status || "辨識出的樂譜格式無法渲染");
  }
  if (engine === "jianpu") {
    await _app.setViewMode("original");
  } else {
    await _app.setViewMode("staff");
  }
  await _app.whenIdle();
  if (_app.pageEls.length === 0) {
    throw new Error(_app.status || "樂譜頁面渲染失敗");
  }

  return { engine, info };
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
    _app.stopPlayback();
    _app.clearPages();
    if (!_app.adoptStaffXml(xml)) {
      throw new Error(_app.status || "樂譜 XML 無法渲染");
    }
    await _app.setViewMode(viewMode);
    await _app.whenIdle();
    if (_app.pageEls.length === 0) {
      throw new Error(_app.status || "樂譜頁面渲染失敗");
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
    _app.stopPlayback();
    _app.clearPages();
    if (snap.format === "musicxml") {
      if (!_app.adoptStaffXml(snap.text)) {
        throw new Error(_app.status || "收藏樂譜無法渲染");
      }
    } else {
      _app.adoptText(snap.format, snap.text, null);
    }
    await _app.setViewMode(snap.viewMode);
    await _app.whenIdle();
    if (_app.pageEls.length === 0) {
      throw new Error(_app.status || "樂譜頁面渲染失敗");
    }
  },
  async setViewMode(m) {
    if (_app) await _app.setViewMode(m);
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
