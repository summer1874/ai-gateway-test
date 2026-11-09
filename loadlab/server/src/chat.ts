// Long conversation test: one real, growing conversation through Bifrost, start to finish.
import { randomUUID } from "node:crypto";
import { callGateway, routeFor, type ChatMessage, type Gateway, type Target } from "./engine.js";
import { logsForTrace } from "./logs.js";
import { tapAttempts } from "./tap.js";

export const CHAT_LIMITS = { minTurns: 3, maxTurns: 40, maxTokens: 1024 };

// Facts planted in turn 1 and asked back in the last turn, to prove history really reaches the model.
const FACTS = { code: "青橙-7", budget: "4280", owner: "林岚" };

const OPENING = `我们来规划一个虚构的社区图书馆改造项目。请记住这三个事实，后面会用到：项目代号「${FACTS.code}」，预算 ${FACTS.budget} 万元，负责人${FACTS.owner}。先用一句话确认你记住了。`;

const TOPICS = ["选址与空间布局", "儿童阅读区", "老年人无障碍设施", "数字借阅系统", "藏书采购策略", "志愿者招募", "开放时间安排", "社区活动策划", "节能与照明", "安全与消防", "运营资金来源", "读者反馈机制", "分期施工计划"];
const ASKS = ["给出最关键的一条建议", "指出最容易被忽视的风险", "结合前面讨论过的内容，说明它会如何影响整体计划"];

export function buildTurns(n: number): string[] {
  const middle: string[] = [];
  for (const ask of ASKS) {
    for (const t of TOPICS) middle.push(`关于「${t}」，请${ask}。控制在 80 字以内。`);
  }
  const recall = `对话到此结束。请不要解释，只根据最开始的约定，按「代号/预算万元/负责人」的格式输出这三项。`;
  return [OPENING, ...middle.slice(0, n - 2), recall];
}

const stripThink = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();

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

export interface RecallCheck {
  passed: boolean;
  expected: typeof FACTS;
  missing: string[];
  answer: string;
}

export interface ChatRun {
  chatId: string;
  gateway: Gateway;
  target: Target;
  model: string;
  plannedTurns: number;
  state: "running" | "stopping" | "finished" | "failed";
  startedAt: number;
  finishedAt?: number;
  turns: ChatTurn[];
  recall?: RecallCheck;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  error?: string;
}

export type ChatEvent =
  | { type: "chat_state"; chat: ChatRun }
  | { type: "chat_delta"; chatId: string; turn: number; text: string };

export function createChat(hooks: { emit: (e: ChatEvent) => void; onFinish: (c: ChatRun) => Promise<void> | void }) {
  let chat: ChatRun | null = null;
  let abort: AbortController | null = null;

  async function enrich(c: ChatRun, t: ChatTurn) {
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const logs = await logsForTrace(c.chatId, t.traceId!).catch(() => []);
      if (logs.length) {
        const last = logs[logs.length - 1];
        t.upstreamMs = last.upstream_latency;
        t.overheadMs = last.overhead_latency;
        hooks.emit({ type: "chat_state", chat: c });
        return;
      }
    }
  }

  async function run(c: ChatRun, script: string[]) {
    const history: ChatMessage[] = [{ role: "system", content: "你是一位简洁的项目顾问，用中文回答。" }];
    const enrichments: Promise<void>[] = [];
    try {
      for (let i = 0; i < script.length; i++) {
        if ((c.state as string) === "stopping") break;
        history.push({ role: "user", content: script[i] });
        const turn: ChatTurn = { turn: i + 1, user: script[i], assistant: "", historyMessages: history.length };
        c.turns.push(turn);
        hooks.emit({ type: "chat_state", chat: c });

        let raw = "";
        const rec = await callGateway({
          runId: c.chatId,
          kind: "chat",
          turn: i + 1,
          gateway: c.gateway,
          target: c.target,
          route: routeFor(c.gateway, c.target, c.model, false),
          messages: [...history],
          stream: !(c.target === "minimax" && c.gateway === "mlflow"), // see MLFLOW_STREAM_NOTE; Command Code streams fine through MLflow
          maxTokens: CHAT_LIMITS.maxTokens,
          signal: abort!.signal,
          onDelta: (text) => {
            raw += text;
            hooks.emit({ type: "chat_delta", chatId: c.chatId, turn: i + 1, text });
          },
        });

        turn.traceId = rec.traceId;
        turn.ok = rec.ok;
        turn.status = rec.status;
        turn.error = rec.error;
        turn.ttftMs = rec.ttftMs;
        turn.totalMs = rec.totalMs;
        turn.promptTokens = rec.promptTokens;
        turn.completionTokens = rec.completionTokens;
        turn.assistant = stripThink(raw);
        c.totalPromptTokens += rec.promptTokens ?? 0;
        c.totalCompletionTokens += rec.completionTokens ?? 0;
        hooks.emit({ type: "chat_state", chat: c });

        if (!rec.ok) {
          if ((c.state as string) === "stopping") break;
          throw new Error(`第 ${i + 1} 轮失败：HTTP ${rec.status} ${rec.error ?? ""}`.slice(0, 400));
        }
        if (!turn.assistant) throw new Error(`第 ${i + 1} 轮模型没有返回正文（可能被 max_tokens 截断）`);
        if (c.gateway === "bifrost") {
          enrichments.push(enrich(c, turn));
        } else {
          turn.overheadMs = rec.gatewayTiming?.overheadMs ?? null;
          turn.upstreamMs = tapAttempts(rec.traceId)[0]?.endMs ?? null;
        }
        history.push({ role: "assistant", content: turn.assistant });
      }

      const last = c.turns[c.turns.length - 1];
      if (c.turns.length === script.length && last?.ok) {
        const norm = last.assistant.replace(/[\s,，]/g, "");
        const missing = Object.values(FACTS).filter((f) => !norm.includes(f));
        c.recall = { passed: missing.length === 0, expected: FACTS, missing, answer: last.assistant };
      }
      c.state = "finished";
    } catch (e) {
      c.state = "failed";
      c.error = e instanceof Error ? e.message : String(e);
    }
    c.finishedAt = Date.now();
    hooks.emit({ type: "chat_state", chat: c });
    await Promise.all(enrichments);
    await hooks.onFinish(c);
  }

  return {
    current: () => chat,
    start(gateway: Gateway, model: string, turns: number, target: Target = "minimax"): ChatRun {
      if (chat && (chat.state === "running" || chat.state === "stopping")) throw new Error("已有长对话在运行");
      const c: ChatRun = {
        chatId: `chat-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
        gateway,
        target,
        model,
        plannedTurns: turns,
        state: "running",
        startedAt: Date.now(),
        turns: [],
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
      };
      chat = c;
      abort = new AbortController();
      void run(c, buildTurns(turns));
      return c;
    },
    stop() {
      if (chat?.state === "running") {
        chat.state = "stopping";
        abort?.abort();
      }
    },
  };
}
