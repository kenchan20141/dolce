import { isPdf } from "./omrkit/pdf";
import { recognizeMusicppDetailed, omrEmitter } from "./omr";
import { scoreDocToMusicXml } from "./model/toxml";

export type OmrKind = "auto" | "jianpu" | "staff";

export interface OmrBridgeResult {
  xml: string;
  engine: "vector-staff" | "outlined-staff" | "raster-staff" | "jianpu";
  info: string;
}

function baseTitle(name: string): string {
  return name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
}

export async function recognizeFileToMusicXML(
  file: File,
  opts: {
    kind?: OmrKind;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<OmrBridgeResult> {
  const kind: OmrKind = opts.kind ?? "auto";
  const onProgress = opts.onProgress ?? (() => undefined);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || undefined;
  const title = file.name ? baseTitle(file.name) : undefined;

  // 1. 若為 PDF 且未強制指定簡譜：優先嘗試矢量 / 轉曲五線譜 PDF
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
            onProgress: (done, total) => onProgress(`辨識矢量五線譜第 ${done}/${total} 頁...`),
            noteIds: false,
          });
          if (res.notes > 0 && res.musicxml) {
            return {
              xml: res.musicxml,
              engine: "vector-staff",
              info: `矢量五線譜 · ${res.pages} 頁 · ${res.notes} 音符`,
            };
          }
        } else {
          const ob = await import("./outlineomr/browser");
          if (await ob.isOutlinedStaffPdf(pdfDoc.pdf, pdfDoc.OPS)) {
            const res = await ob.recognizeOutlinedPdf(pdfDoc, {
              onProgress: (done, total) => onProgress(`辨識轉曲五線譜第 ${done}/${total} 頁...`),
              noteIds: false,
            });
            if (res.notes > 0 && res.musicxml) {
              return {
                xml: res.musicxml,
                engine: "outlined-staff",
                info: `轉曲五線譜 · ${res.pages} 頁 · ${res.notes} 音符`,
              };
            }
          }
        }
      } finally {
        pdfDoc.pdf.destroy?.();
      }
    }
  }

  // 2. 位圖五線譜（圖片或掃描版 PDF）
  if (kind !== "jianpu") {
    onProgress("載入 AI 模型與分析譜表...");
    const rb = await import("./rasteromr/browser");
    const rasterPdf = await rb.asRasterPdf(bytes, mime);
    const probe = kind === "staff" ? null : await rb.probeRasterStaff(rasterPdf);
    if (!probe || probe.isStaff) {
      const res = await rb.recognizeRasterPdfs([rasterPdf], {
        ...(title ? { title } : {}),
        onPage: (done, total) => onProgress(`AI 辨識五線譜第 ${done}/${total} 頁...`),
        cancelled: () => false,
        ...(probe?.pages ? { firstPages: probe.pages } : {}),
      });
      if (res.xml) {
        return {
          xml: res.xml,
          engine: "raster-staff",
          info: `AI 五線譜 · ${res.stats.pages} 頁 · ${res.stats.notes} 音符`,
        };
      }
      if (kind === "staff") {
        throw new Error("未在檔案中偵測到五線譜，請確認譜面清晰度或改選「自動判別 / 簡譜」");
      }
    }
  }

  // 3. 簡譜圖片 / 掃描簡譜 PDF
  onProgress("AI 辨識簡譜中...");
  const { score } = await recognizeMusicppDetailed(bytes, mime);
  const out = omrEmitter("123").emit(score);
  if (out.kind !== "123") {
    throw new Error("簡譜轉出格式異常");
  }
  const xml = scoreDocToMusicXml(out.doc);
  return {
    xml,
    engine: "jianpu",
    info: `AI 簡譜 · ${score.rows.length} 行`,
  };
}

declare global {
  interface Window {
    __dolceOMR?: {
      recognizeFileToMusicXML: typeof recognizeFileToMusicXML;
    };
  }
}

window.__dolceOMR = { recognizeFileToMusicXML };
window.dispatchEvent(new Event("dolce-omr-ready"));
