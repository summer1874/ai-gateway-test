// Load engine: drives Bifrost and aggregates real client-side measurements per second.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Agent, request } from "undici";
import { TRACE_HEADER, TRACE_USER_PREFIX } from "./tap.js";

export type Gateway = "bifrost" | "mlflow" | "litellm";
export const GATEWAYS: Gateway[] = ["bifrost", "mlflow", "litellm"];

const LITELLM_KEY_FILE = new URL("../../litellm/master_key.txt", import.meta.url);
let litellmKey: string | null = null;
function litellmAuth(): string {
  litellmKey ??= readFileSync(LITELLM_KEY_FILE, "utf8").trim();
  return `Bearer ${litellmKey}`;
}

interface Route {
  url: string;
  model: string;
  fallbacks?: string[];
}

/** Maps "this target through this gateway" to the gateway's own URL and model naming. */
export function routeFor(gateway: Gateway, target: Target, model: string, fallback: boolean): Route {
  const mock = target === "mock";
  if (target === "commandcode") {
    // Reached through the cmdtap forwarder (18091), which injects the real key.
    switch (gateway) {
      case "bifrost":
        return { url: "http://127.0.0.1:8080/v1/chat/completions", model: `cmd-tap/${model}` };
      case "mlflow":
        return { url: "http://127.0.0.1:5050/gateway/mlflow/v1/chat/completions", model: CMD_MODELS.find((m) => m.id === model)?.mlflow ?? model };
      case "litellm":
        return { url: "http://127.0.0.1:4000/v1/chat/completions", model: `cmd/${model}` };
    }
  }
  switch (gateway) {
    case "bifrost":
      return {
        url: "http://127.0.0.1:8080/v1/chat/completions",
        model: mock ? "openai/mock-model" : `minimax-tap/${model}`,
        fallbacks: mock && fallback ? ["groq/mock-model"] : undefined,
      };
    case "mlflow":
      // MLflow configures fallback per endpoint, so the two behaviours are two endpoints.
      return {
        url: "http://127.0.0.1:5050/gateway/mlflow/v1/chat/completions",
        model: mock ? (fallback ? "chat" : "chat-nofb") : model,
      };
    case "litellm":
      return {
        url: "http://127.0.0.1:4000/v1/chat/completions",
        model: mock ? "mock-model" : `minimax/${model}`,
        fallbacks: mock && fallback ? ["mock-fallback"] : undefined,
      };
  }
}

const agent = new Agent({
  connections: 8192,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  headersTimeout: 180_000,
  bodyTimeout: 180_000,
});

// ---- Types ------------------------------------------------------------------

export type Target = "mock" | "minimax" | "commandcode";

/** Command Code models exposed through the gateways; `mlflow` is the endpoint name (set up by setup_mlflow_cmd.py). */
export const CMD_MODELS = [
  { id: "deepseek/deepseek-v4.1-flash-fast", mlflow: "cmd-deepseek-v4-1-flash-fast" },
  { id: "deepseek/deepseek-v4.1-flash", mlflow: "cmd-deepseek-v4-1-flash" },
  { id: "gpt-5.4-mini", mlflow: "cmd-gpt-5-4-mini" },
];
export type Mode = "concurrency" | "rps" | "ramp";

export interface RunConfig {
  gateway: Gateway;
  target: Target;
  model: string;
  mode: Mode;
  concurrency: number;
  rps: number;
  durationSec: number;
  rampStart: number;
  rampStep: number;
  rampStepSec: number;
  rampMax: number;
  stream: boolean;
  fallback: boolean;
  maxTokens: number;
  promptChars: number;
  maxRequests: number; // 0 = unlimited (mock only)
}

export const MLFLOW_STREAM_NOTE = "MLflow 3.12 无法解析 MiniMax 的流式响应（KeyError: finish_reason），请关闭流式";

export const REAL_LIMITS = { concurrency: 3, maxRequests: 30, maxTokens: 512, durationSec: 120 };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GatewayTiming {
  durationMs?: number;
  overheadMs?: number;
  attemptedFallbacks?: number;
}

export interface RequestRecord {
  traceId: string;
  runId: string;
  kind: "load" | "chat";
  turn?: number;
  gateway: Gateway;
  gatewayTiming?: GatewayTiming;
  target: Target;
  model: string;
  stream: boolean;
  startedAt: number;
  ttfbMs?: number;
  ttftMs?: number;
  totalMs?: number;
  status: number; // 0 = network error before any response
  ok: boolean;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseHeaders?: Record<string, string>;
  responsePreview?: string;
}

export interface SecondStat {
  t: number; // seconds since the run started
  started: number;
  ok: number;
  err: number;
  inflight: number;
  targetConcurrency: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  ttftP50: number | null;
  ttftP95: number | null;
  statuses: Record<string, number>;
  loopLagMs: number;
}

export interface RunSummary {
  total: number;
  ok: number;
  err: number;
  durationSec: number;
  avgRps: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  ttftP50: number | null;
  ttftP95: number | null;
  statuses: Record<string, number>;
  maxLoopLagMs: number;
  loggedInBifrost: number | null;
  fallbackAttempts: number | null;
  droppedByBifrost: number | null; // log rows Bifrost itself reports dropping during this run
}

export interface RunState {
  runId: string;
  config: RunConfig;
  state: "running" | "stopping" | "finished";
  startedAt: number;
  series: SecondStat[];
  summary?: RunSummary;
}

// ---- Validation -------------------------------------------------------------

export function validateConfig(c: RunConfig): string | null {
  if (!GATEWAYS.includes(c.gateway)) return "未知网关";
  const positive = [c.durationSec, c.maxTokens].every((n) => Number.isFinite(n) && n > 0);
  if (!positive) return "时长和 max_tokens 必须大于 0";
  if (c.mode === "concurrency" && !(c.concurrency >= 1 && c.concurrency <= 5000)) return "并发需在 1–5000";
  if (c.mode === "rps" && !(c.rps >= 1 && c.rps <= 20000)) return "RPS 需在 1–20000";
  if (c.mode === "ramp" && !(c.rampStart >= 1 && c.rampStep >= 1 && c.rampStepSec >= 1 && c.rampMax >= c.rampStart && c.rampMax <= 5000)) {
    return "阶梯参数无效（起始 ≥ 1，峰值 ≤ 5000）";
  }
  if (!(c.promptChars >= 1 && c.promptChars <= 20000)) return "提示词长度需在 1–20000";

  if (c.target === "commandcode" && !CMD_MODELS.some((m) => m.id === c.model)) return "未知的 Command Code 模型";
  if (c.target !== "mock") {
    const L = REAL_LIMITS;
    if (c.mode === "concurrency" && c.concurrency > L.concurrency) return `真实 key 并发上限为 ${L.concurrency}`;
    if (c.mode === "ramp" && c.rampMax > L.concurrency) return `真实 key 并发上限为 ${L.concurrency}`;
    if (c.mode === "rps" && c.rps > L.concurrency) return `真实 key RPS 上限为 ${L.concurrency}`;
    if (!(c.maxRequests >= 1 && c.maxRequests <= L.maxRequests)) return `真实 key 总请求数需在 1–${L.maxRequests}`;
    if (c.maxTokens > L.maxTokens) return `真实 key max_tokens 上限为 ${L.maxTokens}`;
    if (c.durationSec > L.durationSec) return `真实 key 时长上限为 ${L.durationSec} 秒`;
    if (c.fallback) return "真实 key 压测不支持 fallback";
    if (c.target === "minimax" && c.gateway === "mlflow" && c.stream) return MLFLOW_STREAM_NOTE;
  }
  return null;
}

// ---- Record store -----------------------------------------------------------

const MAX_RECORDS = 20000;
const records = new Map<string, RequestRecord>();

export function storeRecord(r: RequestRecord) {
  records.set(r.traceId, r);
  if (records.size > MAX_RECORDS) records.delete(records.keys().next().value!);
}
export const getRecord = (id: string) => records.get(id);

export function listRecords(q: {
  runId?: string;
  status?: string;
  minMs?: number;
  sort?: string;
  limit?: number;
}): { total: number; items: RequestRecord[] } {
  let items = [...records.values()];
  if (q.runId) items = items.filter((r) => r.runId === q.runId);
  if (q.status === "ok") items = items.filter((r) => r.ok);
  if (q.status === "error") items = items.filter((r) => !r.ok);
  if (q.minMs) items = items.filter((r) => (r.totalMs ?? 0) >= q.minMs!);
  if (q.sort === "slowest") items.sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0));
  else items.reverse();
  const total = items.length;
  return { total, items: items.slice(0, Math.min(q.limit ?? 200, 1000)) };
}

// ---- One request ------------------------------------------------------------

export interface CallParams {
  runId: string;
  kind: "load" | "chat";
  turn?: number;
  gateway: Gateway;
  target: Target;
  route: Route;
  messages: ChatMessage[];
  stream: boolean;
  maxTokens: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

const PREVIEW = 1500;
const BODY_LIMIT = 4000;

const firstDelta = /"(?:content|reasoning|reasoning_content|reasoning_details)":\s*(?:"[^"]|\[)/;

function usageFrom(text: string, r: RequestRecord) {
  const num = (k: string) => {
    const ms = [...text.matchAll(new RegExp(`"${k}":\\s*(\\d+)`, "g"))];
    return ms.length ? Number(ms[ms.length - 1][1]) : undefined;
  };
  r.promptTokens = num("prompt_tokens") ?? r.promptTokens;
  r.completionTokens = num("completion_tokens") ?? r.completionTokens;
  r.totalTokens = num("total_tokens") ?? r.totalTokens;
}

function gatewayTiming(gateway: Gateway, h: Record<string, string>): GatewayTiming | undefined {
  const num = (k: string) => (h[k] === undefined || Number.isNaN(Number(h[k])) ? undefined : Number(h[k]));
  if (gateway === "mlflow") {
    return { durationMs: num("x-mlflow-gateway-duration-ms"), overheadMs: num("x-mlflow-gateway-overhead-duration-ms") };
  }
  if (gateway === "litellm") {
    return {
      durationMs: num("x-litellm-response-duration-ms"),
      overheadMs: num("x-litellm-overhead-duration-ms"),
      attemptedFallbacks: num("x-litellm-attempted-fallbacks"),
    };
  }
  return undefined;
}

export async function callGateway(p: CallParams): Promise<RequestRecord> {
  const traceId = randomUUID();
  const body = JSON.stringify({
    model: p.route.model,
    messages: p.messages,
    max_tokens: p.maxTokens,
    stream: p.stream,
    ...(p.stream ? { stream_options: { include_usage: true } } : {}),
    ...(p.route.fallbacks?.length ? { fallbacks: p.route.fallbacks } : {}),
    // Each gateway passes a different thing through to the upstream, so the tap correlates differently.
    ...(p.gateway === "mlflow" ? { user: TRACE_USER_PREFIX + traceId } : {}),
    ...(p.gateway === "litellm" ? { extra_headers: { [TRACE_HEADER]: traceId } } : {}),
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (p.gateway === "bifrost") {
    headers["x-bf-session-id"] = p.runId;
    headers["x-bf-lh-loadlab-trace"] = traceId;
    headers[`x-bf-eh-${TRACE_HEADER}`] = traceId;
  }
  const wireHeaders = p.gateway === "litellm" ? { ...headers, authorization: litellmAuth() } : headers;
  const shownHeaders = p.gateway === "litellm" ? { ...headers, authorization: "Bearer ***" } : headers;
  const rec: RequestRecord = {
    traceId,
    runId: p.runId,
    kind: p.kind,
    turn: p.turn,
    gateway: p.gateway,
    target: p.target,
    model: p.route.model,
    stream: p.stream,
    startedAt: Date.now(),
    status: 0,
    ok: false,
    requestHeaders: shownHeaders,
    requestBody: body.length > BODY_LIMIT && p.kind === "load" ? body.slice(0, BODY_LIMIT) + "…" : body,
  };
  storeRecord(rec);

  const t0 = performance.now();
  try {
    const res = await request(p.route.url, {
      method: "POST",
      headers: wireHeaders,
      body,
      dispatcher: agent,
      signal: p.signal,
    });
    rec.ttfbMs = performance.now() - t0;
    rec.status = res.statusCode;
    const rh: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) rh[k] = String(v);
    rec.responseHeaders = rh;
    rec.gatewayTiming = gatewayTiming(p.gateway, rh);

    let preview = "";
    let tail = "";
    let sseBuf = "";
    let full = "";
    for await (const chunk of res.body) {
      const text = (chunk as Buffer).toString("utf8");
      if (preview.length < PREVIEW) preview += text.slice(0, PREVIEW - preview.length);
      tail = (tail + text).slice(-4096);
      if (p.onDelta && !p.stream) full += text;
      if (p.stream && rec.ttftMs === undefined && res.statusCode === 200 && firstDelta.test(text)) {
        rec.ttftMs = performance.now() - t0;
      }
      if (p.onDelta && p.stream) {
        sseBuf += text;
        let i: number;
        while ((i = sseBuf.indexOf("\n")) >= 0) {
          const line = sseBuf.slice(0, i).trim();
          sseBuf = sseBuf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) p.onDelta(delta);
          } catch {
            /* partial or non-JSON event */
          }
        }
      }
    }
    rec.totalMs = performance.now() - t0;
    rec.responsePreview = preview;
    if (p.onDelta && !p.stream && res.statusCode === 200) {
      try {
        const content = JSON.parse(full)?.choices?.[0]?.message?.content;
        if (typeof content === "string") p.onDelta(content);
      } catch {
        /* the status check below reports the failure */
      }
    }
    usageFrom(tail, rec);
    rec.ok = res.statusCode >= 200 && res.statusCode < 300;
    if (!rec.ok) rec.error = preview.slice(0, 500);
    else if (p.stream && /"error"\s*:\s*\{/.test(tail)) {
      rec.ok = false;
      rec.error = tail.slice(-500);
    }
  } catch (e) {
    rec.totalMs = performance.now() - t0;
    rec.error = e instanceof Error ? e.message : String(e);
  }
  return rec;
}

// ---- Run --------------------------------------------------------------------

function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
const sortNum = (a: number[]) => a.slice().sort((x, y) => x - y);

function buildPrompt(chars: number): ChatMessage[] {
  const seed = "请用一句话介绍负载测试。";
  return [{ role: "user", content: seed.length >= chars ? seed.slice(0, chars) : seed + "测".repeat(chars - seed.length) }];
}

export function effectiveDuration(c: RunConfig): number {
  if (c.mode !== "ramp") return c.durationSec;
  return (Math.ceil((c.rampMax - c.rampStart) / c.rampStep) + 1) * c.rampStepSec;
}

export interface Engine {
  current(): RunState | null;
  start(c: RunConfig): RunState;
  stop(): void;
}

export function createEngine(hooks: {
  onTick: (runId: string, s: SecondStat) => void;
  onFinish: (run: RunState) => Promise<void> | void;
}): Engine {
  let run: RunState | null = null;
  let stopFlag: (() => void) | null = null;

  function start(c: RunConfig): RunState {
    if (run && run.state !== "finished") throw new Error("已有压测在运行");
    const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const state: RunState = { runId, config: c, state: "running", startedAt: Date.now(), series: [] };
    run = state;

    const route = routeFor(c.gateway, c.target, c.model, c.fallback);
    const messages = buildPrompt(c.promptChars);
    const duration = effectiveDuration(c);

    const abort = new AbortController();
    let stopping = false;
    stopFlag = () => {
      stopping = true;
      state.state = "stopping";
    };

    let issued = 0;
    let inflight = 0;
    let bucket = freshBucket();
    const allLat: number[] = [];
    const allTtft: number[] = [];
    const totals: Record<string, number> = {};
    let okTotal = 0;
    let errTotal = 0;
    let maxLag = 0;
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const t0 = performance.now();
    const elapsed = () => (performance.now() - t0) / 1000;
    const budgetLeft = () => c.maxRequests <= 0 || issued < c.maxRequests;

    function desired(): number {
      if (c.mode === "concurrency") return c.concurrency;
      if (c.mode === "ramp") {
        return Math.min(c.rampMax, c.rampStart + Math.floor(elapsed() / c.rampStepSec) * c.rampStep);
      }
      return 0;
    }

    async function fire() {
      issued++;
      inflight++;
      bucket.started++;
      const r = await callGateway({
        runId,
        kind: "load",
        gateway: c.gateway,
        target: c.target,
        route,
        messages,
        stream: c.stream,
        maxTokens: c.maxTokens,
        signal: abort.signal,
      });
      inflight--;
      const code = String(r.status);
      bucket.statuses[code] = (bucket.statuses[code] ?? 0) + 1;
      totals[code] = (totals[code] ?? 0) + 1;
      if (r.ok) {
        bucket.ok++;
        okTotal++;
        if (r.totalMs !== undefined) {
          bucket.lat.push(r.totalMs);
          allLat.push(r.totalMs);
        }
        if (r.ttftMs !== undefined) {
          bucket.ttft.push(r.ttftMs);
          allTtft.push(r.ttftMs);
        }
      } else {
        bucket.err++;
        errTotal++;
      }
    }

    // Closed-loop workers: each loops request after request while it is within the desired level.
    const workers: Promise<void>[] = [];
    let spawned = 0;
    async function worker(index: number) {
      while (!stopping && elapsed() < duration && budgetLeft()) {
        if (index >= desired()) {
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        await fire();
      }
    }
    function spawnUpTo(n: number) {
      while (spawned < n) workers.push(worker(spawned++));
    }

    // Open-loop pacing for RPS mode.
    const openLoop: Promise<void>[] = [];
    let credit = 0;
    let lastPace = performance.now();
    const pacer =
      c.mode === "rps"
        ? setInterval(() => {
            const now = performance.now();
            credit += ((now - lastPace) / 1000) * c.rps;
            lastPace = now;
            while (credit >= 1 && !stopping && elapsed() < duration && budgetLeft() && inflight < 8000) {
              credit--;
              openLoop.push(fire());
            }
          }, 5)
        : null;

    if (c.mode !== "rps") spawnUpTo(desired());

    const ticker = setInterval(() => {
      if (c.mode === "ramp") spawnUpTo(desired());
      const b = bucket;
      bucket = freshBucket();
      const lat = sortNum(b.lat);
      const ttft = sortNum(b.ttft);
      const lagMs = lag.max / 1e6;
      lag.reset();
      maxLag = Math.max(maxLag, lagMs);
      const s: SecondStat = {
        t: state.series.length + 1,
        started: b.started,
        ok: b.ok,
        err: b.err,
        inflight,
        targetConcurrency: c.mode === "rps" ? c.rps : desired(),
        p50: percentile(lat, 0.5),
        p95: percentile(lat, 0.95),
        p99: percentile(lat, 0.99),
        ttftP50: percentile(ttft, 0.5),
        ttftP95: percentile(ttft, 0.95),
        statuses: b.statuses,
        loopLagMs: lagMs,
      };
      state.series.push(s);
      hooks.onTick(runId, s);
    }, 1000);

    const hardStop = setTimeout(() => abort.abort(), (duration + 200) * 1000);

    void (async () => {
      // Wait for the window to close, then for in-flight requests to settle.
      while (!stopping && elapsed() < duration && budgetLeft()) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (pacer) clearInterval(pacer);
      if (stopping) abort.abort();
      await Promise.all([...workers, ...openLoop]);
      clearInterval(ticker);
      clearTimeout(hardStop);
      lag.disable();

      const lat = sortNum(allLat);
      const ttft = sortNum(allTtft);
      const durationSec = elapsed();
      state.summary = {
        total: okTotal + errTotal,
        ok: okTotal,
        err: errTotal,
        durationSec,
        avgRps: (okTotal + errTotal) / durationSec,
        p50: percentile(lat, 0.5),
        p95: percentile(lat, 0.95),
        p99: percentile(lat, 0.99),
        ttftP50: percentile(ttft, 0.5),
        ttftP95: percentile(ttft, 0.95),
        statuses: totals,
        maxLoopLagMs: maxLag,
        loggedInBifrost: null,
        fallbackAttempts: null,
        droppedByBifrost: null,
      };
      state.state = "finished";
      await hooks.onFinish(state);
    })();

    return state;
  }

  return {
    current: () => run,
    start,
    stop: () => stopFlag?.(),
  };
}

function freshBucket() {
  return { started: 0, ok: 0, err: 0, lat: [] as number[], ttft: [] as number[], statuses: {} as Record<string, number> };
}
