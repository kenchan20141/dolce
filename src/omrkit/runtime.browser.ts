// 浏览器侧 OMR 运行时：onnxruntime-web（纯 wasm 构建）。**只有这个文件碰 ort-web 与资源 URL**，
// 识别管线其余部分经 `runtime.ts` 的注入点拿推理能力（同 staffomr/browser.ts 的分工约定）。
import type { OmrRunOut, OmrRuntime } from "./runtime";

import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";

const BASE = import.meta.env.BASE_URL; // "/" 或 "/dolce/"
const REC_URL = `${BASE}redist/ocr/ch_PP-OCRv6_small_rec_infer.onnx`;
const DICT_URL = `${BASE}redist/ocr/ppocrv6_dict.txt`;
const DET_URL = `${BASE}redist/ocr/ch_PP-OCRv4_det_infer.onnx`;

const REC_H = 48;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ort: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _session: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _detSession: any = null;
let _initPromise: Promise<void> | null = null;
let _detInitPromise: Promise<void> | null = null;

/** 瀏覽器端預設強制單執行緒，避免多執行緒 wasm worker 冷啟動卡死導致整個 ort 全域單例掛掉。 */
function desiredThreads(): number {
  const ov = (globalThis as { __ortThreads?: number }).__ortThreads;
  if (typeof ov === "number") return Math.max(1, ov);
  return 1;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} 超时 ${ms}ms`)), ms))]);
}

async function createRecSingle(): Promise<unknown> {
  _ort.env.wasm.numThreads = 1;
  _ort.env.wasm.proxy = false;
  return _ort.InferenceSession.create(REC_URL, { executionProviders: ["wasm"] });
}

async function createRecSession(): Promise<unknown> {
  const threads = desiredThreads();
  if (threads <= 1) {
    return createRecSingle();
  }
  try {
    _ort.env.wasm.numThreads = threads;
    const sess = await withTimeout(_ort.InferenceSession.create(REC_URL, { executionProviders: ["wasm"] }), 8000, "多线程 OCR create");
    const warm = new _ort.Tensor("float32", new Float32Array(3 * REC_H * REC_H), [1, 3, REC_H, REC_H]);
    const feeds: Record<string, unknown> = {};
    feeds[(sess as { inputNames: string[] }).inputNames[0]] = warm;
    await withTimeout((sess as { run: (f: unknown) => Promise<unknown> }).run(feeds), 8000, "多线程 OCR warmup");
    return sess;
  } catch (e) {
    console.warn("[OMR] 多线程 OCR 初始化失败/超时，回退单线程：", e);
    return createRecSingle();
  }
}

async function ensureRec(): Promise<void> {
  if (_session) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    _ort = ort;
    _session = await createRecSession();
  })();
  return _initPromise;
}

async function ensureDet(): Promise<void> {
  await ensureRec();
  if (_detSession) return;
  if (_detInitPromise) return _detInitPromise;
  _detInitPromise = (async () => {
    _detSession = await _ort.InferenceSession.create(DET_URL, { executionProviders: ["wasm"] });
  })();
  return _detInitPromise;
}

export const browserRuntime: OmrRuntime = {
  async prepare(model) {
    if (model === "det") await ensureDet();
    else await ensureRec();
  },
  async run(model, chw, dims): Promise<OmrRunOut> {
    await this.prepare(model);
    const sess = model === "det" ? _detSession : _session;
    const tensor = new _ort.Tensor("float32", chw, dims);
    const feeds: Record<string, unknown> = {};
    feeds[sess.inputNames[0]] = tensor;
    const o = (await sess.run(feeds))[sess.outputNames[0]];
    return { data: o.data as Float32Array, dims: o.dims as number[] };
  },
  async loadDict() {
    return (await fetch(DICT_URL)).text();
  },
};
