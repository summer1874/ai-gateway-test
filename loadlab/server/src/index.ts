// LoadLab server: REST + SSE API for the page, and the tap proxy.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { CHAT_LIMITS, createChat, type ChatEvent } from "./chat.js";
import { CMD_MODELS, createEngine, GATEWAYS, getRecord, listRecords, REAL_LIMITS, validateConfig, type Gateway, type RunConfig, type RunState } from "./engine.js";
import { countFallbacks, logsForTrace, settledLogCount } from "./logs.js";
import { registerPiAdapter } from "./piAdapter.js";
import { startTap, tapAttempts, tapHasKey } from "./tap.js";

const PORT = 18100;
const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "../../results");
const WEB_DIST = join(HERE, "../../web/dist");
const MOCKS = { primary: "http://127.0.0.1:18001", fallback: "http://127.0.0.1:18002" } as const;
const MODES = ["ok", "500", "429", "timeout", "slow"];
const CMD_ENV = join(HERE, "../../../.env.commandcode");
const hasCmdKey = () => existsSync(CMD_ENV) && /^CMD_API_KEY=\S+/m.test(readFileSync(CMD_ENV, "utf8"));
const MINIMAX_MODELS = ["MiniMax-M2.7-highspeed", "MiniMax-M2.7", "MiniMax-M2.5-highspeed", "MiniMax-M2.5", "MiniMax-M3", "MiniMax-M3.1-Flash"];

mkdirSync(RESULTS, { recursive: true });
startTap();

// ---- Event stream -----------------------------------------------------------

const clients = new Set<ServerResponse>();
function broadcast(event: unknown) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.write(line);
}

function save(name: string, data: unknown) {
  writeFileSync(join(RESULTS, `${name}.json`), JSON.stringify(data, null, 1));
}

// Bifrost's own "log rows dropped" counter. Needs the local setup token; returns null once
// dashboard auth is configured, and the page then just omits the figure.
const droppedAtStart = new Map<string, number>();
async function droppedCounter(): Promise<number | null> {
  try {
    const token = readFileSync(join(HERE, "../../../bifrost/setup_token.txt"), "utf8").trim();
    const r = await fetch("http://127.0.0.1:8080/api/logs/dropped", {
      headers: { "X-Bifrost-Setup-Token": token },
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { dropped_requests?: number };
    return d.dropped_requests ?? null;
  } catch {
    return null;
  }
}

// Finished runs, newest last, for the comparison table. Survives restarts via results/.
const history: RunState[] = readdirSync(RESULTS)
  .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(RESULTS, f), "utf8")) as RunState)
  .map((r) => ({ ...r, config: { ...r.config, gateway: r.config.gateway ?? ("bifrost" as Gateway) } }))
  .sort((a, b) => a.startedAt - b.startedAt);

const engine = createEngine({
  onTick: (runId, stat) => broadcast({ type: "tick", runId, stat }),
  onFinish: async (run) => {
    history.push(run);
    broadcast({ type: "run", run }); // summary is usable right away; log count follows
    if (run.config.gateway !== "bifrost") {
      save(run.runId, run);
      return;
    }
    run.summary!.loggedInBifrost = await settledLogCount(run.runId, run.summary!.total).catch(() => null);
    run.summary!.fallbackAttempts = await countFallbacks(run.runId).catch(() => null);
    const droppedAfter = await droppedCounter();
    const droppedBefore = droppedAtStart.get(run.runId) ?? null;
    droppedAtStart.delete(run.runId);
    if (droppedAfter !== null && droppedBefore !== null) run.summary!.droppedByBifrost = droppedAfter - droppedBefore;
    save(run.runId, run);
    broadcast({ type: "run", run });
  },
});

const chat = createChat({
  emit: (e: ChatEvent) => broadcast(e),
  onFinish: (c) => save(c.chatId, c),
});

// ---- API --------------------------------------------------------------------

const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

app.get("/api/meta", async () => ({
  hasRealKey: tapHasKey(),
  minimaxModels: MINIMAX_MODELS,
  cmdModels: CMD_MODELS.map((m) => m.id),
  hasCmdKey: hasCmdKey(),
  realLimits: REAL_LIMITS,
  chatLimits: CHAT_LIMITS,
  faultModes: MODES,
  gateways: GATEWAYS,
}));

app.get("/api/runs", async () =>
  history.slice(-30).reverse().map(({ series: _s, ...rest }) => rest),
);

app.get("/api/state", async () => ({ run: engine.current(), chat: chat.current() }));

app.get("/api/events", (req, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.raw.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

app.post<{ Body: RunConfig }>("/api/run", async (req, reply) => {
  const err = validateConfig(req.body);
  if (err) return reply.code(400).send({ error: err });
  if (req.body.target === "minimax" && !tapHasKey()) return reply.code(400).send({ error: "未找到 MiniMax key" });
  if (req.body.target === "commandcode" && !hasCmdKey()) return reply.code(400).send({ error: "未找到 Command Code key（.env.commandcode）" });
  try {
    if (engine.current() && engine.current()!.state !== "finished") throw new Error("已有压测在运行");
    const before = await droppedCounter();
    const run = engine.start(req.body);
    if (before !== null) droppedAtStart.set(run.runId, before);
    broadcast({ type: "run", run });
    return { runId: run.runId };
  } catch (e) {
    return reply.code(409).send({ error: (e as Error).message });
  }
});

app.post("/api/run/stop", async () => {
  engine.stop();
  const run = engine.current();
  if (run) broadcast({ type: "run", run });
  return { ok: true };
});

app.post<{ Body: { gateway: Gateway; model: string; turns: number; target?: "minimax" | "commandcode" } }>("/api/chat", async (req, reply) => {
  const { gateway, model, turns } = req.body;
  const target = req.body.target ?? "minimax";
  if (!GATEWAYS.includes(gateway)) return reply.code(400).send({ error: "未知网关" });
  if (target !== "minimax" && target !== "commandcode") return reply.code(400).send({ error: "未知上游" });
  if (!(target === "commandcode" ? CMD_MODELS.some((m) => m.id === model) : MINIMAX_MODELS.includes(model))) return reply.code(400).send({ error: "未知模型" });
  if (!Number.isInteger(turns) || turns < CHAT_LIMITS.minTurns || turns > CHAT_LIMITS.maxTurns) {
    return reply.code(400).send({ error: `轮数需在 ${CHAT_LIMITS.minTurns}–${CHAT_LIMITS.maxTurns}` });
  }
  if (target === "minimax" && !tapHasKey()) return reply.code(400).send({ error: "未找到 MiniMax key" });
  if (target === "commandcode" && !hasCmdKey()) return reply.code(400).send({ error: "未找到 Command Code key（.env.commandcode）" });
  try {
    const c = chat.start(gateway, model, turns, target);
    return { chatId: c.chatId };
  } catch (e) {
    return reply.code(409).send({ error: (e as Error).message });
  }
});

app.post("/api/chat/stop", async () => {
  chat.stop();
  return { ok: true };
});

app.get<{ Querystring: { runId?: string; status?: string; minMs?: string; sort?: string; limit?: string } }>(
  "/api/requests",
  async (req) => {
    const q = req.query;
    const { total, items } = listRecords({
      runId: q.runId,
      status: q.status,
      minMs: q.minMs ? Number(q.minMs) : undefined,
      sort: q.sort,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return {
      total,
      items: items.map(({ requestHeaders: _h, requestBody: _b, responseHeaders: _r, responsePreview: _p, ...rest }) => rest),
    };
  },
);

app.get<{ Params: { id: string } }>("/api/requests/:id", async (req, reply) => {
  const record = getRecord(req.params.id);
  if (!record) return reply.code(404).send({ error: "请求明细已被清理或不存在" });
  const logs = await logsForTrace(record.runId, record.traceId).catch(() => []);
  return { record, tap: tapAttempts(record.traceId), logs };
});

app.get("/api/mock", async () => {
  const read = async (url: string) => {
    try {
      const r = await fetch(`${url}/__stats`, { signal: AbortSignal.timeout(2000) });
      return await r.json();
    } catch {
      return null;
    }
  };
  return { primary: await read(MOCKS.primary), fallback: await read(MOCKS.fallback) };
});

app.post<{ Body: { upstream: "primary" | "fallback"; mode: string } }>("/api/fault", async (req, reply) => {
  const { upstream, mode } = req.body;
  if (!(upstream in MOCKS) || !MODES.includes(mode)) return reply.code(400).send({ error: "参数无效" });
  const r = await fetch(`${MOCKS[upstream]}/__mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  return { ok: r.ok };
});

if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST });
}

registerPiAdapter(app);

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`LoadLab listening on http://127.0.0.1:${PORT}`);
