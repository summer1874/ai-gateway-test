import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TextureCard } from "@/components/ui/texture-card";
import { Pick } from "@/components/common";
import { api, gatewayName, int, ms, type BifrostLog, type RequestRow, type TapAttempt, type TraceDetail } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Span {
  label: string;
  source: "客户端实测" | "Bifrost 日志" | "tap 实测";
  start: number;
  end: number;
  parts?: { from: number; to: number; tone: "wait" | "data" }[];
  marks?: { at: number; label: string }[];
  note?: string;
}

function buildSpans(d: TraceDetail): Span[] {
  const r = d.record;
  const spans: Span[] = [];
  const total = r.totalMs ?? 0;
  const clientMarks: { at: number; label: string }[] = [];
  if (r.ttfbMs !== undefined) clientMarks.push({ at: r.ttfbMs, label: "首字节" });
  if (r.ttftMs !== undefined) clientMarks.push({ at: r.ttftMs, label: "首 token" });
  spans.push({
    label: "客户端请求",
    source: "客户端实测",
    start: 0,
    end: total,
    marks: clientMarks,
    note: `HTTP ${r.status || "无响应"}`,
  });

  d.logs.forEach((l: BifrostLog, i) => {
    const start = new Date(l.timestamp).getTime() - r.startedAt;
    const fb = l.fallback_index ? `（fallback #${l.fallback_index}）` : "";
    spans.push({
      label: `Bifrost 处理${d.logs.length > 1 ? ` #${i + 1}` : ""}${fb}`,
      source: "Bifrost 日志",
      start,
      end: start + (l.latency ?? 0),
      note: `${l.provider} · ${l.status}`,
    });
  });

  d.tap.forEach((a: TapAttempt) => {
    const start = a.receivedAt - r.startedAt;
    const ttfb = a.upstreamTtfbMs ?? a.endMs ?? 0;
    const end = a.endMs ?? ttfb;
    spans.push({
      label: `上游 MiniMax 第 ${a.attempt} 次`,
      source: "tap 实测",
      start,
      end: start + end,
      parts: [
        { from: start, to: start + ttfb, tone: "wait" },
        { from: start + ttfb, to: start + end, tone: "data" },
      ],
      note: `HTTP ${a.status ?? "—"} · ${int(a.bytes)} 字节${a.error ? ` · ${a.error}` : ""}`,
    });
  });
  return spans;
}

function Waterfall({ detail }: { detail: TraceDetail }) {
  const spans = buildSpans(detail);
  const max = Math.max(...spans.map((s) => s.end), 1);
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;

  return (
    <div className="grid gap-2.5">
      {spans.map((s, i) => (
        <div key={i} className="grid gap-1 sm:grid-cols-[176px_minmax(0,1fr)_76px] sm:items-center sm:gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm">{s.label}</div>
            <div className="truncate text-[11px] text-muted-foreground">{s.source}{s.note ? ` · ${s.note}` : ""}</div>
          </div>
          <div className="relative h-6 rounded bg-muted/60">
            {s.parts ? (
              s.parts.map((p, j) => (
                <div
                  key={j}
                  className="absolute top-1 bottom-1 rounded-[3px]"
                  style={{
                    left: pct(p.from),
                    width: `max(2px, calc(${pct(p.to)} - ${pct(p.from)}))`,
                    background: p.tone === "wait" ? "var(--viz-2)" : "var(--viz-1)",
                  }}
                />
              ))
            ) : (
              <div
                className="absolute top-1 bottom-1 rounded-[3px]"
                style={{
                  left: pct(s.start),
                  width: `max(2px, calc(${pct(s.end)} - ${pct(s.start)}))`,
                  background: s.source === "Bifrost 日志" ? "var(--viz-3)" : "var(--viz-neutral)",
                }}
              />
            )}
            {s.marks?.map((m) => (
              <div key={m.label} className="absolute top-0 bottom-0 w-0.5 bg-foreground" style={{ left: pct(m.at) }} title={`${m.label}：${ms(m.at)}`} />
            ))}
          </div>
          <div className="tnum text-right text-xs">{ms(s.end - s.start)}</div>
        </div>
      ))}
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><i className="h-2 w-3 rounded-sm" style={{ background: "var(--viz-neutral)" }} />客户端全程</span>
        <span className="flex items-center gap-1.5"><i className="h-2 w-3 rounded-sm" style={{ background: "var(--viz-3)" }} />Bifrost 处理</span>
        <span className="flex items-center gap-1.5"><i className="h-2 w-3 rounded-sm" style={{ background: "var(--viz-2)" }} />等待上游首字节</span>
        <span className="flex items-center gap-1.5"><i className="h-2 w-3 rounded-sm" style={{ background: "var(--viz-1)" }} />上游返回数据</span>
        <span className="flex items-center gap-1.5"><i className="h-3 w-0.5 bg-foreground" />首字节 / 首 token（客户端）</span>
      </div>
    </div>
  );
}

function Overhead({ log }: { log: BifrostLog }) {
  const entries = Object.entries(log.overhead_breakdown ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = Math.max(...entries.map((e) => e[1]), 1);
  if (!entries.length) return null;
  return (
    <div className="grid gap-1">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_64px] items-center gap-2 text-xs">
          <span className="truncate font-mono text-[11px] text-muted-foreground">{k}</span>
          <div className="h-1.5 rounded-full bg-muted/60">
            <div className="h-full rounded-full" style={{ width: `${(v / max) * 100}%`, background: "var(--viz-3)" }} />
          </div>
          <span className="tnum text-right">{ms(v / 1000)}</span>
        </div>
      ))}
    </div>
  );
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer px-3 py-2 text-sm">{title}</summary>
      <pre className="max-h-72 overflow-auto border-t p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">{text}</pre>
    </details>
  );
}

const pretty = (s?: string) => {
  if (!s) return "（无）";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

function Detail({ traceId }: { traceId: string }) {
  const [d, setD] = useState<TraceDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    return api<TraceDetail>(`/requests/${traceId}`)
      .then((x) => {
        setD(x);
        return x;
      })
      .catch((e) => {
        setErr((e as Error).message);
        return null;
      });
  }, [traceId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setD(null);
    // Bifrost writes logs in batches: keep re-reading for a while until the row appears.
    const poll = async (left: number) => {
      const x = await load();
      if (!cancelled && x && x.record.gateway === "bifrost" && !x.logs.length && left > 0) timer = setTimeout(() => poll(left - 1), 2000);
    };
    void poll(10);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  if (err) return <p className="p-4 text-sm text-destructive">{err}</p>;
  if (!d) return <p className="p-4 text-sm text-muted-foreground">加载中…</p>;
  const r = d.record;
  const log = d.logs[d.logs.length - 1];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={r.ok ? "secondary" : "destructive"}>{r.ok ? "成功" : "失败"} · {r.status || "无响应"}</Badge>
        <span className="font-mono text-xs break-all text-muted-foreground">{r.traceId}</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={load}><RefreshCw /> 刷新</Button>
      </div>

      <Waterfall detail={d} />
      {r.target === "mock" && <p className="text-xs text-muted-foreground">Mock 路径不经过 tap，因此没有独立的上游时序。</p>}
      {r.gatewayTiming && (
        <section className="grid grid-cols-2 gap-3 rounded-md border p-3 sm:grid-cols-4">
          {[
            ["网关", gatewayName(r.gateway)],
            ["网关自报耗时", ms(r.gatewayTiming.durationMs)],
            ["网关自报开销", ms(r.gatewayTiming.overheadMs)],
            ["尝试 fallback", r.gatewayTiming.attemptedFallbacks === undefined ? "未上报" : String(r.gatewayTiming.attemptedFallbacks)],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <div className="text-[11px] text-muted-foreground">{k}</div>
              <div className="tnum truncate text-sm font-medium">{v}</div>
            </div>
          ))}
          <p className="col-span-full text-[11px] text-muted-foreground">来自网关响应头。这类网关不提供每个阶段的时间戳，所以不画在时间轴上；流式请求的耗时可能只统计到响应开始。</p>
        </section>
      )}
      {r.gateway === "bifrost" && !d.logs.length && <p className="text-xs text-muted-foreground">Bifrost 日志中暂未找到这条记录（可能还在批量写入，或已被丢弃）。</p>}

      {log && (
        <section className="grid grid-cols-2 gap-3 rounded-md border p-3 sm:grid-cols-4">
          {[
            ["Bifrost 总耗时", ms(log.latency)],
            ["上游耗时", ms(log.upstream_latency)],
            ["网关开销", ms(log.overhead_latency)],
            ["重试 / fallback", `${log.number_of_retries ?? 0} / ${log.fallback_index ?? 0}`],
            ["Prompt tokens", int(log.prompt_tokens)],
            ["Completion tokens", int(log.completion_tokens)],
            ["缓存命中 tokens", int(log.cached_read_tokens)],
            ["使用的 key", log.selected_key_name ?? "—"],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <div className="text-[11px] text-muted-foreground">{k}</div>
              <div className="tnum truncate text-sm font-medium">{v}</div>
            </div>
          ))}
        </section>
      )}

      {log?.overhead_breakdown && (
        <section>
          <h4 className="mb-2 text-sm font-medium">网关内部各阶段</h4>
          <Overhead log={log} />
          <p className="mt-2 text-[11px] text-muted-foreground">Bifrost 记录的分项，部分阶段相互嵌套，相加不等于网关开销。</p>
        </section>
      )}

      <div className="grid gap-2">
        <Block title="客户端请求头" text={JSON.stringify(r.requestHeaders, null, 2)} />
        <Block title="请求体" text={pretty(r.requestBody)} />
        {d.tap[0] && <Block title="网关发往上游的请求头（Authorization 已打码）" text={JSON.stringify(d.tap[0].forwardedHeaders, null, 2)} />}
        <Block title="响应头" text={JSON.stringify(r.responseHeaders ?? {}, null, 2)} />
        <Block title="响应内容（前 1500 字符）" text={r.responsePreview ?? r.error ?? "（无）"} />
        {log && <Block title="重试轨迹 attempt_trail" text={JSON.stringify(log.attempt_trail, null, 2)} />}
        {d.logs.some((l) => l.error_details) && <Block title="Bifrost 错误详情" text={d.logs.map((l) => l.error_details).filter(Boolean).map((e) => pretty(e!)).join("\n\n")} />}
      </div>
    </div>
  );
}

export function TraceTab({
  runIds,
  focusRun,
  focusTrace,
  live,
}: {
  runIds: { value: string; label: string }[];
  focusRun: string | null;
  focusTrace: string | null;
  live: boolean;
}) {
  const [runId, setRunId] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("latest");
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (focusRun) setRunId(focusRun);
    if (focusTrace) setSelected(focusTrace);
  }, [focusRun, focusTrace]);

  const load = useCallback(() => {
    const q = new URLSearchParams({ sort, limit: "200" });
    if (runId !== "all") q.set("runId", runId);
    if (status !== "all") q.set("status", status);
    api<{ total: number; items: RequestRow[] }>(`/requests?${q}`)
      .then((d) => {
        setRows(d.items);
        setTotal(d.total);
      })
      .catch(() => undefined);
  }, [runId, status, sort]);

  useEffect(() => {
    load();
    if (!live) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load, live]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <TextureCard className="min-w-0 lg:h-[calc(100svh-6rem)]">
      <section className="flex h-full min-w-0 flex-col">
        <div className="grid grid-cols-3 gap-2 border-b p-3">
          <Pick value={runId} onChange={setRunId} options={[{ value: "all", label: "全部运行" }, ...runIds]} />
          <Pick value={status} onChange={setStatus} options={[{ value: "all", label: "全部状态" }, { value: "ok", label: "成功" }, { value: "error", label: "失败" }]} />
          <Pick value={sort} onChange={setSort} options={[{ value: "latest", label: "最新" }, { value: "slowest", label: "最慢" }]} />
        </div>
        <div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground">
          <span className="tnum">共 {int(total)} 条，显示 {int(rows.length)} 条</span>
          <Button variant="ghost" size="sm" onClick={load}><RefreshCw /> 刷新</Button>
        </div>
        <div className="max-h-96 min-h-0 flex-1 overflow-auto border-t lg:max-h-none">
          {rows.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">还没有请求。先运行一次压测或长对话。</p>}
          {rows.map((r) => (
            <button
              key={r.traceId}
              onClick={() => setSelected(r.traceId)}
              className={cn(
                "grid w-full grid-cols-[52px_minmax(0,1fr)_72px] items-center gap-2 border-b px-3 py-2 text-left text-xs hover:bg-accent/60",
                selected === r.traceId && "bg-accent",
              )}
            >
              <Badge variant={r.ok ? "secondary" : "destructive"} className="tnum justify-self-start">{r.status || "ERR"}</Badge>
              <span className="min-w-0">
                <span className="block truncate">{gatewayName(r.gateway)} · {r.turn ? `第 ${r.turn} 轮 · ` : ""}{r.model}</span>
                <span className="tnum block truncate text-[11px] text-muted-foreground">{new Date(r.startedAt).toLocaleTimeString("zh-CN", { hour12: false })}{r.totalTokens ? ` · ${int(r.totalTokens)} tokens` : ""}</span>
              </span>
              <span className="tnum text-right">{ms(r.totalMs)}</span>
            </button>
          ))}
        </div>
      </section>
      </TextureCard>

      <TextureCard className="min-w-0 lg:h-[calc(100svh-6rem)]">
      <section className="h-full min-w-0 overflow-auto p-4">
        {selected ? <Detail traceId={selected} /> : <p className="py-16 text-center text-sm text-muted-foreground">从左侧选择一条请求，查看完整链路。</p>}
      </section>
      </TextureCard>
    </div>
  );
}
