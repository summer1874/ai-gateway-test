import { useEffect, useState } from "react";

export type Gateway = "bifrost" | "mlflow" | "litellm";
export const GATEWAY_OPTIONS: { value: Gateway; label: string }[] = [
  { value: "bifrost", label: "Bifrost" },
  { value: "mlflow", label: "MLflow AI Gateway" },
  { value: "litellm", label: "LiteLLM" },
];
export const gatewayName = (g: Gateway) => GATEWAY_OPTIONS.find((o) => o.value === g)?.label ?? g;

export type Target = "mock" | "minimax" | "commandcode";
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
  maxRequests: number;
}

export interface SecondStat {
  t: number;
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
  droppedByBifrost: number | null;
}

export interface RunState {
  runId: string;
  config: RunConfig;
  state: "running" | "stopping" | "finished";
  startedAt: number;
  series: SecondStat[];
  summary?: RunSummary;
}

export interface ChatTurn {
  turn: number;
  user: string;
  assistant: string;
  traceId?: string;
  ok?: boolean;
  status?: number;
  error?: string;
  ttftMs?: number;
  totalMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  historyMessages: number;
  upstreamMs?: number | null;
  overheadMs?: number | null;
}

export interface ChatRun {
  chatId: string;
  target?: Target;
  gateway: Gateway;
  model: string;
  plannedTurns: number;
  state: "running" | "stopping" | "finished" | "failed";
  startedAt: number;
  finishedAt?: number;
  turns: ChatTurn[];
  recall?: { passed: boolean; expected: Record<string, string>; missing: string[]; answer: string };
  totalPromptTokens: number;
  totalCompletionTokens: number;
  error?: string;
}

export interface Meta {
  hasRealKey: boolean;
  minimaxModels: string[];
  cmdModels: string[];
  hasCmdKey: boolean;
  realLimits: { concurrency: number; maxRequests: number; maxTokens: number; durationSec: number };
  chatLimits: { minTurns: number; maxTurns: number; maxTokens: number };
  faultModes: string[];
}

export type RunListItem = Omit<RunState, "series">;

export interface RequestRow {
  traceId: string;
  runId: string;
  kind: "load" | "chat";
  turn?: number;
  gateway: Gateway;
  gatewayTiming?: { durationMs?: number; overheadMs?: number; attemptedFallbacks?: number };
  target: Target;
  model: string;
  stream: boolean;
  startedAt: number;
  ttfbMs?: number;
  ttftMs?: number;
  totalMs?: number;
  status: number;
  ok: boolean;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface RequestRecord extends RequestRow {
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseHeaders?: Record<string, string>;
  responsePreview?: string;
}

export interface TapAttempt {
  attempt: number;
  receivedAt: number;
  upstreamTtfbMs?: number;
  firstChunkMs?: number;
  endMs?: number;
  status?: number;
  bytes: number;
  error?: string;
  forwardedHeaders: Record<string, string>;
}

export interface BifrostLog {
  id: string;
  parent_request_id: string | null;
  timestamp: string;
  provider: string;
  model: string;
  status: string;
  fallback_index: number | null;
  number_of_retries: number | null;
  latency: number | null;
  upstream_latency: number | null;
  overhead_latency: number | null;
  overhead_breakdown: Record<string, number> | null;
  attempt_trail: unknown;
  selected_key_name: string | null;
  error_details: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_read_tokens: number | null;
}

export interface TraceDetail {
  record: RequestRecord;
  tap: TapAttempt[];
  logs: BifrostLog[];
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export function useLive() {
  const [run, setRun] = useState<RunState | null>(null);
  const [chat, setChat] = useState<ChatRun | null>(null);
  const [streaming, setStreaming] = useState<{ turn: number; text: string } | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    api<{ run: RunState | null; chat: ChatRun | null }>("/state")
      .then((s) => {
        setRun(s.run);
        setChat(s.chat);
      })
      .catch(() => undefined);

    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "tick") {
        setRun((r) => (r && r.runId === e.runId ? { ...r, series: [...r.series, e.stat] } : r));
      } else if (e.type === "run") {
        setRun(e.run);
      } else if (e.type === "chat_state") {
        setChat(e.chat);
      } else if (e.type === "chat_delta") {
        setStreaming((s) => (s && s.turn === e.turn ? { turn: e.turn, text: s.text + e.text } : { turn: e.turn, text: e.text }));
      }
    };
    return () => es.close();
  }, []);

  return { run, chat, streaming, connected };
}

export const ms = (v: number | null | undefined) => {
  if (v === null || v === undefined) return "—";
  if (v >= 10000) return `${(v / 1000).toFixed(1)} s`;
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  return `${v.toFixed(v < 10 ? 2 : 0)} ms`;
};

export const int = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("zh-CN"));
