import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Play, Square, TriangleAlert } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { BorderBeamCard } from "@/components/ui/border-beam-card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TextureButton } from "@/components/ui/texture-button";
import { TextureCard, TextureSeparator } from "@/components/ui/texture-card";
import { Field, Metric, NumberInput, Pick, TimeChart } from "@/components/common";
import { api, GATEWAY_OPTIONS, gatewayName, int, ms, type Gateway, type Meta, type Mode, type RunConfig, type RunListItem, type RunState, type Target } from "@/lib/api";
import { cn } from "@/lib/utils";

const DEFAULTS: RunConfig = {
  gateway: "bifrost",
  target: "mock",
  model: "openai/mock-model",
  mode: "ramp",
  concurrency: 50,
  rps: 200,
  durationSec: 30,
  rampStart: 50,
  rampStep: 150,
  rampStepSec: 5,
  rampMax: 800,
  stream: false,
  fallback: true,
  maxTokens: 64,
  promptChars: 200,
  maxRequests: 0,
};

const REAL_DEFAULTS: Partial<RunConfig> = {
  model: "MiniMax-M2.7-highspeed",
  mode: "concurrency",
  concurrency: 2,
  durationSec: 60,
  stream: true,
  fallback: false,
  maxTokens: 256,
  maxRequests: 10,
};

const statusColor = (code: string) => {
  if (code.startsWith("2")) return "var(--viz-good)";
  if (code === "429" || code.startsWith("4")) return "var(--viz-warn)";
  if (code === "0") return "var(--viz-neutral)";
  return "var(--viz-bad)";
};
const statusName = (code: string) => (code === "0" ? "网络错误" : code);
const tSec = (x: unknown) => `第 ${x} 秒`;
const targetName = (t: Target) => (t === "mock" ? "Mock" : t === "commandcode" ? "Command Code" : "MiniMax");
const loadLabel = (c: RunConfig) => (c.mode === "ramp" ? `阶梯 ${c.rampStart}→${c.rampMax}` : c.mode === "rps" ? `${c.rps} RPS` : `并发 ${c.concurrency}`);
const RUN_STATE: Record<RunState["state"], string> = { running: "运行中", stopping: "正在停止", finished: "已完成" };

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="text-xs font-semibold text-foreground/80">{title}</h2>
      {children}
    </section>
  );
}

export function LoadTab({ run, meta, onOpenTraces }: { run: RunState | null; meta: Meta | null; onOpenTraces: (runId: string) => void }) {
  const [cfg, setCfg] = useState<RunConfig>(DEFAULTS);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [faults, setFaults] = useState({ primary: "ok", fallback: "ok" });
  const active = run && run.state !== "finished";
  const [history, setHistory] = useState<RunListItem[]>([]);
  const historyKey = `${run?.runId}:${run?.state}:${run?.summary?.loggedInBifrost}`;

  useEffect(() => {
    api<RunListItem[]>("/runs").then(setHistory).catch(() => undefined);
  }, [historyKey]);

  useEffect(() => {
    api<{ primary: { mode?: string } | null; fallback: { mode?: string } | null }>("/mock")
      .then((m) => setFaults({ primary: m.primary?.mode ?? "ok", fallback: m.fallback?.mode ?? "ok" }))
      .catch(() => undefined);
  }, []);

  const set = <K extends keyof RunConfig>(k: K, v: RunConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));

  function switchTarget(t: Target) {
    setCfg((c) => {
      if (t === "minimax") return { ...DEFAULTS, ...REAL_DEFAULTS, gateway: c.gateway, target: t, stream: c.gateway !== "mlflow" };
      if (t === "commandcode") return { ...DEFAULTS, ...REAL_DEFAULTS, model: meta?.cmdModels?.[0] ?? "deepseek/deepseek-v4.1-flash-fast", gateway: c.gateway, target: t, stream: true };
      return { ...DEFAULTS, gateway: c.gateway, target: t };
    });
  }

  async function start() {
    setError(null);
    try {
      await api("/run", cfg);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setFault(upstream: "primary" | "fallback", mode: string) {
    setFaults((f) => ({ ...f, [upstream]: mode }));
    await api("/fault", { upstream, mode }).catch((e) => setError((e as Error).message));
  }

  const series = useMemo(() => run?.series ?? [], [run]);
  const codes = useMemo(() => [...new Set(series.flatMap((s) => Object.keys(s.statuses)))].sort(), [series]);
  const statusData = useMemo(() => series.map((s) => ({ t: s.t, ...s.statuses })), [series]);
  const last = series[series.length - 1];
  const sum = run?.summary;
  const real = cfg.target !== "mock";
  const mlflowReal = cfg.target === "minimax" && cfg.gateway === "mlflow";
  const L = meta?.realLimits;
  const lost = sum && sum.loggedInBifrost !== null ? sum.total - sum.loggedInBifrost : null;
  const errorRate = sum ? (sum.total ? (sum.err / sum.total) * 100 : 0) : last && last.ok + last.err ? (last.err / (last.ok + last.err)) * 100 : null;
  const faultOptions = (meta?.faultModes ?? ["ok"]).map((m) => ({ value: m, label: m === "ok" ? "正常" : m }));

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <TextureCard className="min-w-0 self-start lg:sticky lg:top-19">
        <aside className="flex flex-col lg:max-h-[calc(100svh-6rem-10px)]">
          <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto p-4">
            <FormSection title="目标">
              <Field label="网关">
                <Pick<Gateway> value={cfg.gateway} disabled={!!active} onChange={(v) => setCfg((c) => ({ ...c, gateway: v, stream: v === "mlflow" && c.target === "minimax" ? false : c.stream }))} options={GATEWAY_OPTIONS} />
              </Field>
              <Field label="上游">
                <Pick<Target>
                  value={cfg.target}
                  disabled={!!active}
                  onChange={switchTarget}
                  options={[
                    { value: "mock", label: "Mock 上游（不消耗额度）" },
                    { value: "minimax", label: "MiniMax 真实 key" },
                    { value: "commandcode", label: "Command Code 真实 key" },
                  ]}
                />
              </Field>
              {real && (
                <>
                  <Alert>
                    <TriangleAlert />
                    <AlertDescription className="text-xs">
                      会消耗真实额度。服务端限制：并发 ≤ {L?.concurrency}，总请求 ≤ {L?.maxRequests}，max_tokens ≤ {L?.maxTokens}。
                    </AlertDescription>
                  </Alert>
                  <Field label="模型">
                    <Pick
                      value={cfg.model}
                      disabled={!!active}
                      onChange={(v) => set("model", v)}
                      options={((cfg.target === "commandcode" ? meta?.cmdModels : meta?.minimaxModels) ?? []).map((m) => ({ value: m, label: m }))}
                    />
                  </Field>
                </>
              )}
            </FormSection>

            <TextureSeparator />

            <FormSection title="负载">
              <Field label="压测模式">
                <Pick<Mode>
                  value={cfg.mode}
                  disabled={!!active}
                  onChange={(v) => set("mode", v)}
                  options={[
                    { value: "ramp", label: "阶梯加压" },
                    { value: "concurrency", label: "固定并发" },
                    { value: "rps", label: "固定 RPS" },
                  ]}
                />
              </Field>
              {cfg.mode === "ramp" ? (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="起始并发"><NumberInput value={cfg.rampStart} disabled={!!active} onChange={(v) => set("rampStart", v)} /></Field>
                  <Field label="每阶增加"><NumberInput value={cfg.rampStep} disabled={!!active} onChange={(v) => set("rampStep", v)} /></Field>
                  <Field label="每阶秒数"><NumberInput value={cfg.rampStepSec} disabled={!!active} onChange={(v) => set("rampStepSec", v)} /></Field>
                  <Field label="峰值并发"><NumberInput value={cfg.rampMax} disabled={!!active} onChange={(v) => set("rampMax", v)} /></Field>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {cfg.mode === "concurrency" ? (
                    <Field label="并发"><NumberInput value={cfg.concurrency} disabled={!!active} onChange={(v) => set("concurrency", v)} /></Field>
                  ) : (
                    <Field label="RPS"><NumberInput value={cfg.rps} disabled={!!active} onChange={(v) => set("rps", v)} /></Field>
                  )}
                  <Field label="时长（秒）"><NumberInput value={cfg.durationSec} disabled={!!active} onChange={(v) => set("durationSec", v)} /></Field>
                </div>
              )}
              {real && <Field label="总请求数上限"><NumberInput value={cfg.maxRequests} disabled={!!active} onChange={(v) => set("maxRequests", v)} /></Field>}
            </FormSection>

            <TextureSeparator />

            <FormSection title="请求">
              <div className="grid grid-cols-2 gap-3">
                <Field label="max_tokens"><NumberInput value={cfg.maxTokens} disabled={!!active} onChange={(v) => set("maxTokens", v)} /></Field>
                <Field label="提示词字数"><NumberInput value={cfg.promptChars} disabled={!!active} onChange={(v) => set("promptChars", v)} /></Field>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">流式响应</span>
                <Switch checked={cfg.stream} disabled={!!active || mlflowReal} onCheckedChange={(v) => set("stream", v)} />
              </div>
              {mlflowReal && <p className="text-[11px] leading-snug text-muted-foreground">MLflow 3.12 无法解析 MiniMax 的流式响应，这条路径只能用非流式。</p>}
              {!real && (
                <div className="flex items-center justify-between">
                  <span className="text-sm">失败转 fallback</span>
                  <Switch checked={cfg.fallback} disabled={!!active} onCheckedChange={(v) => set("fallback", v)} />
                </div>
              )}
            </FormSection>

            {!real && (
              <>
                <TextureSeparator />
                <FormSection title="故障注入">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="主上游">
                      <Pick value={faults.primary} onChange={(v) => setFault("primary", v)} options={faultOptions} />
                    </Field>
                    <Field label="fallback">
                      <Pick value={faults.fallback} onChange={(v) => setFault("fallback", v)} options={faultOptions} />
                    </Field>
                  </div>
                </FormSection>
              </>
            )}
          </div>

          <div className="grid gap-2 border-t p-4">
            {active ? (
              <TextureButton variant="destructive" onClick={() => api("/run/stop", {})}>
                <Square className="size-4" /> {run.state === "stopping" ? "正在停止…" : "停止压测"}
              </TextureButton>
            ) : (
              <TextureButton onClick={start}>
                <Play className="size-4" /> 开始压测
              </TextureButton>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </aside>
      </TextureCard>

      <div className="grid min-w-0 content-start gap-3">
        {run && (
          <BorderBeamCard active={!!active} colorVariant="ocean" borderRadius={10} cardClassName="py-0 ring-border">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-sm">
              <span className="flex items-center gap-2 font-medium">
                <span className={cn("size-2 rounded-full", active && "animate-pulse")} style={{ background: active ? "var(--viz-good)" : "var(--viz-neutral)" }} />
                {RUN_STATE[run.state]}
              </span>
              <span className="text-muted-foreground">
                {gatewayName(run.config.gateway)} → {targetName(run.config.target)} · {loadLabel(run.config)}
                {last ? ` · 第 ${last.t} 秒` : ""}
              </span>
              {sum && (
                <>
                  <span>
                    发送 <b className="tnum">{int(sum.total)}</b> 条
                  </span>
                  {run.config.gateway === "bifrost" && (
                    <span>
                      Bifrost 日志落库{" "}
                      <b className="tnum">{sum.loggedInBifrost === null ? "统计中…" : int(sum.loggedInBifrost)}</b> 条
                    </span>
                  )}
                  {lost !== null && (
                    <Badge variant={lost > 0 ? "destructive" : "secondary"}>{lost > 0 ? `缺失 ${int(lost)} 条` : "全部落库"}</Badge>
                  )}
                  {!!sum.fallbackAttempts && <span>转 fallback <b className="tnum">{int(sum.fallbackAttempts)}</b> 次</span>}
                  {!!sum.droppedByBifrost && <span>Bifrost 自报丢弃日志 <b className="tnum">{int(sum.droppedByBifrost)}</b> 行（写入队列满）</span>}
                  <span className="text-muted-foreground">压测机事件循环最大延迟 {ms(sum.maxLoopLagMs)}</span>
                  <TextureButton variant="minimal" size="sm" className="ml-auto w-auto" onClick={() => onOpenTraces(run.runId)}>
                    查看请求链路
                  </TextureButton>
                </>
              )}
            </div>
          </BorderBeamCard>
        )}

        <TextureCard>
          <section className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 min-[1400px]:grid-cols-6">
            <Metric label="当前 / 平均 RPS" value={last ? last.ok + last.err : null} format={(v) => int(Math.round(v))} sub={sum ? `平均 ${sum.avgRps.toFixed(1)}` : undefined} />
            <Metric label="在途请求" value={last?.inflight} format={(v) => int(Math.round(v))} sub={last ? `目标 ${int(last.targetConcurrency)}` : undefined} />
            <Metric label="P50" value={sum ? sum.p50 : last?.p50} format={ms} precision={2} sub={run ? (sum ? "全程" : "当前秒") : undefined} />
            <Metric label="P95" value={sum ? sum.p95 : last?.p95} format={ms} precision={2} sub={run ? (sum ? "全程" : "当前秒") : undefined} />
            <Metric label="P99" value={sum ? sum.p99 : last?.p99} format={ms} precision={2} sub={run ? (sum ? "全程" : "当前秒") : undefined} />
            <Metric label="错误率" value={errorRate} format={(v) => `${v.toFixed(2)}%`} precision={2} bad={!!errorRate} sub={sum ? `${int(sum.err)} / ${int(sum.total)}` : undefined} />
          </section>
        </TextureCard>

        <div className="grid gap-3 min-[1400px]:grid-cols-2">
          <TimeChart
            title="吞吐（次/秒）"
            data={series}
            x="t"
            xLabel={tSec}
            format={(v) => int(Math.round(v))}
            series={[
              { key: "ok", name: "成功", color: "var(--viz-1)" },
              { key: "err", name: "失败", color: "var(--viz-bad)" },
            ]}
          />
          <TimeChart
            title="延迟（客户端实测）"
            data={series}
            x="t"
            xLabel={tSec}
            format={ms}
            series={[
              { key: "p50", name: "P50", color: "var(--viz-1)" },
              { key: "p95", name: "P95", color: "var(--viz-2)" },
              { key: "p99", name: "P99", color: "var(--viz-3)" },
            ]}
          />
          <TimeChart
            title="并发"
            data={series}
            x="t"
            xLabel={tSec}
            format={(v) => int(Math.round(v))}
            series={[
              { key: "inflight", name: "在途", color: "var(--viz-1)" },
              { key: "targetConcurrency", name: run?.config.mode === "rps" ? "目标 RPS" : "目标并发", color: "var(--viz-2)" },
            ]}
          />
          {run?.config.stream ? (
            <TimeChart
              title="首 token 时间（TTFT）"
              data={series}
              x="t"
              xLabel={tSec}
              format={ms}
              series={[
                { key: "ttftP50", name: "P50", color: "var(--viz-1)" },
                { key: "ttftP95", name: "P95", color: "var(--viz-2)" },
              ]}
            />
          ) : (
            <TextureCard className="min-w-0">
            <div className="p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">状态码（次/秒）</h3>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {codes.map((c) => (
                    <span key={c} className="flex items-center gap-1.5">
                      <span className="size-2 rounded-sm" style={{ background: statusColor(c) }} />
                      {statusName(c)}
                    </span>
                  ))}
                </div>
              </div>
              {statusData.length === 0 ? (
                <div className="grid h-[180px] place-items-center text-xs text-muted-foreground">运行后显示</div>
              ) : (
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={statusData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                    <XAxis dataKey="t" tickLine={false} axisLine={{ stroke: "var(--viz-grid)" }} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} minTickGap={32} />
                    <YAxis width={64} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
                    <Tooltip
                      isAnimationActive={false}
                      cursor={{ fill: "var(--muted)" }}
                      contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}
                      labelFormatter={tSec}
                    />
                    {codes.map((c) => (
                      <Bar key={c} dataKey={c} name={statusName(c)} stackId="s" fill={statusColor(c)} stroke="var(--card)" strokeWidth={1} isAnimationActive={false} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            </TextureCard>
          )}
        </div>

        {history.length > 0 && (
          <TextureCard className="min-w-0">
          <section className="min-w-0">
            <h3 className="px-4 pt-3 pb-1 text-sm font-medium">运行对比</h3>
            <div className="max-h-80 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {["时间", "网关", "上游", "并发 / RPS", "请求数", "错误率", "RPS", "P50", "P95", "P99"].map((h) => (
                      <TableHead key={h}>{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody className="tnum">
                  {history.map((h) => {
                    const c = h.config;
                    const s = h.summary;
                    if (!s) return null;
                    return (
                      <TableRow key={h.runId}>
                        <TableCell>{new Date(h.startedAt).toLocaleTimeString("zh-CN", { hour12: false })}</TableCell>
                        <TableCell>{gatewayName(c.gateway)}</TableCell>
                        <TableCell>{targetName(c.target)}</TableCell>
                        <TableCell>{c.mode === "ramp" ? `${c.rampStart}→${c.rampMax}` : c.mode === "rps" ? `${c.rps} RPS` : c.concurrency}</TableCell>
                        <TableCell>{int(s.total)}</TableCell>
                        <TableCell>{s.total ? ((s.err / s.total) * 100).toFixed(2) : "0"}%</TableCell>
                        <TableCell>{s.avgRps.toFixed(0)}</TableCell>
                        <TableCell>{ms(s.p50)}</TableCell>
                        <TableCell>{ms(s.p95)}</TableCell>
                        <TableCell>{ms(s.p99)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </section>
          </TextureCard>
        )}

        {series.length > 0 && (
          <div>
            <Button variant="ghost" size="sm" onClick={() => setShowTable((s) => !s)}>
              {showTable ? "收起逐秒明细" : "查看逐秒明细"}
            </Button>
            {showTable && (
              <TextureCard className="mt-2">
              <div className="max-h-80 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {["秒", "发出", "成功", "失败", "在途", "P50", "P95", "P99", "状态码"].map((h) => (
                        <TableHead key={h}>{h}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody className="tnum">
                    {series.map((s) => (
                      <TableRow key={s.t}>
                        <TableCell>{s.t}</TableCell>
                        <TableCell>{int(s.started)}</TableCell>
                        <TableCell>{int(s.ok)}</TableCell>
                        <TableCell>{int(s.err)}</TableCell>
                        <TableCell>{int(s.inflight)}</TableCell>
                        <TableCell>{ms(s.p50)}</TableCell>
                        <TableCell>{ms(s.p95)}</TableCell>
                        <TableCell>{ms(s.p99)}</TableCell>
                        <TableCell>{Object.entries(s.statuses).map(([k, v]) => `${statusName(k)}×${v}`).join("  ")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              </TextureCard>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
