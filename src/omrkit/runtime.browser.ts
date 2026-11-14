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

function isChromiumEngine(): boolean {
  const uaData = (globalThis.navigator as { userAgentData?: { brands?: { brand: string }[] } } | undefined)?.userAgentData;
  if (uaData?.brands?.length) return uaData.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand));
  return /Chrome\/\d/.test((globalThis.navigator as { userAgent?: string } | undefined)?.userAgent ?? "");
}

function desiredThreads(): number {
  const ov = (globalThis as { __ortThreads?: number }).__ortThreads;
  if (typeof ov === "number") return Math.max(1, ov);
  if (!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) return 1;
  if (!isChromiumEngine()) return 1;
  const hw = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4;
  return Math.min(4, Math.max(1, hw));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} 超时 ${ms}ms`)), ms))]);
}

async function fetchModelBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`模型下載失敗 (${res.status}): ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function createRecSingle(recBytes: Uint8Array): Promise<unknown> {
  _ort.env.wasm.numThreads = 1;
  _ort.env.wasm.proxy = false;
  return _ort.InferenceSession.create(recBytes, { executionProviders: ["wasm"] });
}

async function createRecSession(): Promise<unknown> {
  const recBytes = await fetchModelBytes(REC_URL);
  const threads = desiredThreads();
  if (threads <= 1) {
    return createRecSingle(recBytes);
  }
  try {
    _ort.env.wasm.numThreads = threads;
    _ort.env.wasm.proxy = false;
    const sess = await withTimeout(_ort.InferenceSession.create(recBytes, { executionProviders: ["wasm"] }), 8000, "多线程 OCR create");
    const warm = new _ort.Tensor("float32", new Float32Array(3 * REC_H * REC_H), [1, 3, REC_H, REC_H]);
    const feeds: Record<string, unknown> = {};
    feeds[(sess as { inputNames: string[] }).inputNames[0]] = warm;
    await withTimeout((sess as { run: (f: unknown) => Promise<unknown> }).run(feeds), 8000, "多线程 OCR warmup");
    return sess;
  } catch (e) {
    console.warn("[OMR] 多线程 OCR 初始化失败/超时，回退单线程：", e);
    return createRecSingle(recBytes);
  }
}

async function ensureRec(): Promise<void> {
  if (_session) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
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
    const detBytes = await fetchModelBytes(DET_URL);
    _detSession = await _ort.InferenceSession.create(detBytes, { executionProviders: ["wasm"] });
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
    const res = await fetch(DICT_URL);
    if (!res.ok) throw new Error(`字典下載失敗 (${res.status}): ${DICT_URL}`);
    return res.text();
  },
};
