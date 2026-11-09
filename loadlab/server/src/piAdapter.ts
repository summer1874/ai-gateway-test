// pi always streams, but MLflow 3.12 fails on MiniMax's streaming chunks (KeyError: finish_reason).
// This route calls MLflow without streaming and replays the whole answer as one SSE response, so
// pi can use MLflow with no change to MLflow or the tap proxy. Output arrives all at once.
import type { FastifyInstance } from "fastify";

const MLFLOW_CHAT = "http://127.0.0.1:5050/gateway/mlflow/v1/chat/completions";
const BODY_LIMIT = 64 * 1024 * 1024; // pi resends the whole session on every turn

type ToolCall = Record<string, unknown>;
type Completion = {
  id: string;
  created: number;
  model: string;
  choices: { message: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason: string }[];
  usage?: unknown;
};

function toSse(c: Completion): string {
  const base = { id: c.id, object: "chat.completion.chunk", created: c.created, model: c.model };
  const { message, finish_reason } = c.choices[0];
  const delta: Record<string, unknown> = { role: "assistant", content: message.content ?? "" };
  if (message.tool_calls?.length) delta.tool_calls = message.tool_calls.map((t, index) => ({ index, ...t }));
  const chunks = [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason }] },
    ...(c.usage ? [{ ...base, choices: [], usage: c.usage }] : []),
  ];
  return chunks.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n";
}

export function registerPiAdapter(app: FastifyInstance) {
  app.post("/pi/mlflow/v1/chat/completions", { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const { stream, stream_options: _ignored, ...body } = req.body as Record<string, unknown>;
    const abort = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) abort.abort();
    });
    try {
      const r = await fetch(MLFLOW_CHAT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      const text = await r.text();
      if (!r.ok || !stream) return reply.code(r.status).type(r.headers.get("content-type") ?? "application/json").send(text);
      return reply.type("text/event-stream").send(toSse(JSON.parse(text) as Completion));
    } catch (e) {
      return reply.code(502).send({ error: { message: `MLflow adapter: ${(e as Error).message}` } });
    }
  });
}
