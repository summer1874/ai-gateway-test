import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, CircleX, MessagesSquare, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { TextureButton } from "@/components/ui/texture-button";
import { TextureCard } from "@/components/ui/texture-card";
import { Field, NumberInput, Pick, Stat, TimeChart } from "@/components/common";
import { api, GATEWAY_OPTIONS, int, ms, type ChatRun, type Gateway, type Meta } from "@/lib/api";

type ChatTarget = "minimax" | "commandcode";

const display = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
const turnLabel = (x: unknown) => `第 ${x} 轮`;

export function ChatTab({
  chat,
  streaming,
  meta,
  onOpenTrace,
}: {
  chat: ChatRun | null;
  streaming: { turn: number; text: string } | null;
  meta: Meta | null;
  onOpenTrace: (runId: string, traceId: string) => void;
}) {
  const [gateway, setGateway] = useState<Gateway>("bifrost");
  const [target, setTarget] = useState<ChatTarget>("minimax");
  const [model, setModel] = useState("MiniMax-M2.7-highspeed");
  const [turns, setTurns] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const active = chat?.state === "running" || chat?.state === "stopping";

  async function start() {
    setError(null);
    try {
      await api("/chat", { gateway, model, turns, target });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const data = useMemo(
    () =>
      (chat?.turns ?? [])
        .filter((t) => t.totalMs !== undefined)
        .map((t) => ({
          turn: t.turn,
          promptTokens: t.promptTokens ?? null,
          ttft: t.ttftMs ?? null,
          total: t.totalMs ?? null,
          overhead: t.overheadMs ?? null,
        })),
    [chat],
  );

  const liveTurn = chat?.turns[chat.turns.length - 1];
  const liveLen = streaming?.text.length ?? 0;
  useEffect(() => {
    if (active && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [active, liveLen, chat?.turns.length]);

  const done = chat?.turns.filter((t) => t.totalMs !== undefined).length ?? 0;
  const lastDone = data[data.length - 1];
  const avg = (key: "ttft" | "total" | "overhead") => {
    const v = data.map((d) => d[key]).filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <TextureCard className="self-start">
      <aside className="grid content-start gap-3 p-4">
        <Field label="网关">
          <Pick<Gateway> value={gateway} disabled={active} onChange={setGateway} options={GATEWAY_OPTIONS} />
        </Field>
        <Field label="上游">
          <Pick<ChatTarget>
            value={target}
            disabled={active}
            onChange={(t) => {
              setTarget(t);
              setModel((t === "commandcode" ? meta?.cmdModels : meta?.minimaxModels)?.[0] ?? model);
            }}
            options={[
              { value: "minimax", label: "MiniMax 真实 key" },
              { value: "commandcode", label: "Command Code 真实 key" },
            ]}
          />
        </Field>
        <Field label="模型">
          <Pick value={model} disabled={active} onChange={setModel} options={((target === "commandcode" ? meta?.cmdModels : meta?.minimaxModels) ?? [model]).map((m) => ({ value: m, label: m }))} />
        </Field>
        <Field label="对话轮数" hint={`${meta?.chatLimits.minTurns ?? 3}–${meta?.chatLimits.maxTurns ?? 40} 轮。每轮带完整历史，遇错即停。`}>
          <NumberInput value={turns} disabled={active} onChange={setTurns} />
        </Field>
        {gateway === "mlflow" && target === "minimax" && <p className="text-xs leading-relaxed text-muted-foreground">MLflow 3.12 无法解析 MiniMax 的流式响应，这条路径用非流式，没有 TTFT，回答整段显示。</p>}
        <p className="text-xs leading-relaxed text-muted-foreground">
          第 1 轮埋入三个事实，最后一轮要求模型复述，用来校验历史消息确实传到了模型。走真实 {target === "commandcode" ? "Command Code" : "MiniMax"} key，单轮 max_tokens 为 {meta?.chatLimits.maxTokens ?? 1024}。
        </p>
        {active ? (
          <TextureButton variant="destructive" onClick={() => api("/chat/stop", {})}><Square className="size-4" /> 停止对话</TextureButton>
        ) : (
          <TextureButton className="disabled:cursor-not-allowed disabled:opacity-50" onClick={start} disabled={meta ? !(target === "commandcode" ? meta.hasCmdKey : meta.hasRealKey) : false}><MessagesSquare className="size-4" /> 开始长对话</TextureButton>
        )}
        {meta && !(target === "commandcode" ? meta.hasCmdKey : meta.hasRealKey) && <p className="text-xs text-destructive">未找到 {target === "commandcode" ? "Command Code" : "MiniMax"} key</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </aside>
      </TextureCard>

      <div className="grid min-w-0 content-start gap-3">
        <TextureCard>
        <section className="grid gap-3 p-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
            <Stat label="进度" value={chat ? `${done} / ${chat.plannedTurns}` : "—"} sub={chat ? ({ running: "进行中", stopping: "停止中", finished: "已结束", failed: "失败" } as const)[chat.state] : undefined} />
            <Stat label="最新 Prompt tokens" value={int(lastDone?.promptTokens)} sub="随历史增长" />
            <Stat label="平均 TTFT" value={ms(avg("ttft"))} />
            <Stat label="平均网关开销" value={ms(avg("overhead"))} />
            <Stat label="累计 tokens" value={chat ? int(chat.totalPromptTokens + chat.totalCompletionTokens) : "—"} sub={chat ? `输入 ${int(chat.totalPromptTokens)} · 输出 ${int(chat.totalCompletionTokens)}` : undefined} />
          </div>
          {chat && <Progress value={(done / chat.plannedTurns) * 100} />}
          {chat?.recall && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {chat.recall.passed ? <CircleCheck className="size-4 text-[var(--viz-good)]" /> : <CircleX className="size-4 text-destructive" />}
              <span className="font-medium">上下文校验{chat.recall.passed ? "通过" : "未通过"}</span>
              <span className="text-muted-foreground">
                {chat.recall.passed ? `模型复述：${chat.recall.answer}` : `缺少：${chat.recall.missing.join("、")}；模型回答：${chat.recall.answer}`}
              </span>
            </div>
          )}
          {chat?.error && <p className="text-sm text-destructive">{chat.error}</p>}
        </section>
        </TextureCard>

        <div className="grid gap-3 xl:grid-cols-2">
          <TimeChart title="每轮 Prompt tokens" data={data} x="turn" xLabel={turnLabel} format={(v) => int(Math.round(v))} series={[{ key: "promptTokens", name: "Prompt tokens", color: "var(--viz-1)" }]} empty="开始对话后显示" />
          <TimeChart
            title="每轮耗时"
            data={data}
            x="turn"
            xLabel={turnLabel}
            format={ms}
            series={[
              { key: "ttft", name: "首 token", color: "var(--viz-1)" },
              { key: "total", name: "总耗时", color: "var(--viz-2)" },
            ]}
            empty="开始对话后显示"
          />
        </div>

        <TextureCard>
        <section ref={logRef} className="max-h-[560px] overflow-auto p-4">
          {!chat && <p className="py-10 text-center text-sm text-muted-foreground">对话内容会实时显示在这里。</p>}
          <ol className="grid gap-4">
            {chat?.turns.map((t) => {
              const text = t.assistant || (liveTurn?.turn === t.turn && streaming?.turn === t.turn ? display(streaming.text) : "");
              return (
                <li key={t.turn} className="grid gap-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="tnum font-medium text-foreground">第 {t.turn} 轮</span>
                    {t.totalMs !== undefined && (
                      <>
                        <span className="tnum">TTFT {ms(t.ttftMs)}</span>
                        <span className="tnum">总 {ms(t.totalMs)}</span>
                        {t.overheadMs != null && <span className="tnum">网关 {ms(t.overheadMs)}</span>}
                        <span className="tnum">{int(t.promptTokens)} → {int(t.completionTokens)} tokens</span>
                        {t.ok === false && <Badge variant="destructive">HTTP {t.status}</Badge>}
                        {t.traceId && (
                          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onOpenTrace(chat.chatId, t.traceId!)}>
                            查看链路
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                  <p className="justify-self-end rounded-lg bg-secondary px-3 py-2 text-sm leading-relaxed sm:max-w-[78%]">{t.user}</p>
                  <p className="rounded-lg px-1 py-1 text-sm leading-relaxed whitespace-pre-wrap sm:max-w-[88%]">{text || (t.totalMs === undefined ? "生成中…" : "")}</p>
                </li>
              );
            })}
          </ol>
        </section>
        </TextureCard>
      </div>
    </div>
  );
}
