// Tap proxy: sits between Bifrost and MiniMax. Records real per-attempt timing and
// swaps Bifrost's placeholder key for the real one, so the key lives only in this process.
import http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request as undiciRequest } from "undici";

export const TAP_PORT = 18090;
export const TRACE_HEADER = "x-loadlab-trace";
export const TRACE_USER_PREFIX = "loadlab-";
const UPSTREAM = "https://api.minimaxi.com";
const ALLOWED_PATH = "/v1/chat/completions";
const KEY_FILE = join(homedir(), ".config/pixel-science-video/minimax.env");

export interface TapAttempt {
  traceId: string;
  attempt: number;
  receivedAt: number; // epoch ms: Bifrost's request reached the tap
  upstreamTtfbMs?: number; // headers back from MiniMax, relative to receivedAt
  firstChunkMs?: number;
  endMs?: number;
  status?: number;
  bytes: number;
  error?: string;
  forwardedHeaders: Record<string, string>; // what Bifrost sent, Authorization masked
}

function loadKey(): string | null {
  try {
    for (const line of readFileSync(KEY_FILE, "utf8").split("\n")) {
      if (line.startsWith("MINIMAX_API_KEY=")) {
        return line.slice("MINIMAX_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* handled by the null return */
  }
  return null;
}

const attempts = new Map<string, TapAttempt[]>();
const order: string[] = [];
const MAX_TRACES = 5000;

function record(a: TapAttempt) {
  const list = attempts.get(a.traceId);
  if (list) {
    list.push(a);
    return;
  }
  attempts.set(a.traceId, [a]);
  order.push(a.traceId);
  if (order.length > MAX_TRACES) attempts.delete(order.shift()!);
}

export function tapAttempts(traceId: string): TapAttempt[] {
  return attempts.get(traceId) ?? [];
}

let hasKey = false;
export const tapHasKey = () => hasKey;

export function startTap(): http.Server {
  const key = loadKey();
  hasKey = !!key;

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url?.split("?")[0] !== ALLOWED_PATH) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "tap only allows POST " + ALLOWED_PATH } }));
      return;
    }
    if (!key) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "MINIMAX_API_KEY not found" } }));
      return;
    }

    const t0 = performance.now();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let upstreamBody = Buffer.concat(chunks);

    // Bifrost forwards the trace header. MLflow and LiteLLM don't, so they carry it in `user`,
    // which is removed here and never reaches MiniMax.
    let traceId = req.headers[TRACE_HEADER] ? String(req.headers[TRACE_HEADER]) : "untraced";
    try {
      const parsed = JSON.parse(upstreamBody.toString("utf8"));
      if (typeof parsed.user === "string" && parsed.user.startsWith(TRACE_USER_PREFIX)) {
        traceId = parsed.user.slice(TRACE_USER_PREFIX.length);
        delete parsed.user;
        upstreamBody = Buffer.from(JSON.stringify(parsed));
      }
    } catch {
      /* not JSON: forward unchanged and let MiniMax reject it */
    }

    const forwardedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      forwardedHeaders[k] = k === "authorization" ? "Bearer ***" : String(v);
    }
    const attempt: TapAttempt = {
      traceId,
      attempt: (attempts.get(traceId)?.length ?? 0) + 1,
      receivedAt: Date.now(),
      bytes: 0,
      forwardedHeaders,
    };
    record(attempt);

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    try {
      const up = await undiciRequest(UPSTREAM + ALLOWED_PATH, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": String(req.headers["content-type"] ?? "application/json"),
          accept: String(req.headers["accept"] ?? "*/*"),
        },
        body: upstreamBody,
        signal: abort.signal,
        headersTimeout: 120_000,
        bodyTimeout: 120_000,
      });
      attempt.upstreamTtfbMs = performance.now() - t0;
      attempt.status = up.statusCode;

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v !== undefined && !["transfer-encoding", "connection", "content-length"].includes(k)) {
          headers[k] = String(v);
        }
      }
      res.writeHead(up.statusCode, headers);
      for await (const chunk of up.body) {
        if (attempt.firstChunkMs === undefined) attempt.firstChunkMs = performance.now() - t0;
        attempt.bytes += (chunk as Buffer).length;
        res.write(chunk);
      }
      res.end();
    } catch (e) {
      attempt.error = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "tap upstream error: " + attempt.error } }));
    } finally {
      attempt.endMs = performance.now() - t0;
    }
  });

  server.listen(TAP_PORT, "127.0.0.1");
  return server;
}
