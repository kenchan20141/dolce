import "./styles.css";
import { MetaData } from "./smufl/smufl";
import { setMeasureBackend } from "./common/measure";
import { browserMeasure, ensureFontsReady } from "./common/measure.browser";
import { asset } from "./common/asset";
import { App, type ViewMode } from "./editor/app";
import { SAMPLE } from "./editor/sample";
import { initLang } from "./i18n";
import { attachPinchZoom } from "./editor/pinchzoom";
import { isPdf } from "./omrkit/pdf";
import { recognizeMusicppDetailed, omrEmitter } from "./omr";
import { scoreDocToMusicXml } from "./model/toxml";

export type OmrKind = "auto" | "jianpu" | "staff";

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

    _app = app;
    return app;
  })();

  return _appPromise;
}

function baseTitle(name: string): string {
  return name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
}

async function recognizeAndRender(
  file: File,
  opts: { kind?: OmrKind; onProgress?: (msg: string) => void } = {},
): Promise<{ engine: string; info: string }> {
  if (!_app) throw new Error("請先初始化引擎");
  _app.stopPlayback();
  _app.clearPages();

  const kind: OmrKind = opts.kind ?? "auto";
  const onProgress = opts.onProgress ?? (() => undefined);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || undefined;
  const title = file.name ? baseTitle(file.name) : undefined;
  const name = file.name.toLowerCase();

  // 非圖片/PDF 的譜檔直接由官方解析渲染
  if (!name.endsWith(".pdf") && !/\.(png|jpe?g|webp)$/i.test(name)) {
    _app.importBytes(bytes, file.name);
    await _app.whenIdle();
    if (/\.(xml|musicxml)$/i.test(name) && _app.mode === "jp") {
      await _app.setViewMode("staff");
    }
    if (_app.pageEls.length === 0) {
      throw new Error(_app.status || `無法解析檔案：${file.name}`);
    }
    return { engine: "native-doc", info: `已載入 ${file.name}` };
  }

  let xml = "";
  let engine = "";
  let info = "";

  // 1. PDF 矢量 / 轉曲五線譜
  if (kind !== "jianpu" && isPdf(bytes, mime)) {
    onProgress("分析 PDF 五線譜結構中...");
    const sb = await import("./staffomr/browser");
    let pdfDoc: Awaited<ReturnType<typeof sb.openStaffPdf>> | null = null;
    try {
      pdfDoc = await sb.openStaffPdf(bytes);
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

  // 2. 位圖五線譜（圖片或掃描 PDF）
  if (!xml && kind !== "jianpu") {
    onProgress("1/4 載入五線譜引擎...");
    const rb = await import("./rasteromr/browser");
    onProgress(`2/4 轉換圖檔 (${Math.round(bytes.length / 1024)} KB)...`);
    const rasterPdf = await rb.asRasterPdf(bytes, mime);
    onProgress("3/4 偵測五線譜結構...");
    const probe = kind === "staff" ? null : await rb.probeRasterStaff(rasterPdf);
    if (!probe || probe.isStaff) {
      let ocrCount = 0;
      onProgress("4/4 啟動五線譜辨識與 AI 文字偵測...");
      const res = await rb.recognizeRasterPdfs([rasterPdf], {
        ...(title ? { title } : {}),
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
    const { score } = await recognizeMusicppDetailed(bytes, mime);
    const out = omrEmitter("123").emit(score);
    if (out.kind !== "123") {
      throw new Error("簡譜轉出格式異常");
    }
    xml = scoreDocToMusicXml(out.doc);
    engine = "jianpu";
    info = `AI 簡譜 · ${score.rows.length} 行`;
  }

  onProgress("正在排版樂譜頁面...");
  if (!_app.adoptStaffXml(xml)) {
    throw new Error(_app.status || "辨識出的樂譜格式無法渲染");
  }
  // 不先等混排排完，直接切換到目標視圖後等最後結果即可
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
      loadXmlText: (xml: string, viewMode?: ViewMode) => Promise<void>;
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
