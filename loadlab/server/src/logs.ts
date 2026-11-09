// Read-only access to Bifrost's own log table.
import pg from "pg";

const pool = new pg.Pool({
  host: "localhost",
  port: 55432,
  user: "postgres",
  database: "bifrost",
  max: 3,
  options: "-c default_transaction_read_only=on",
});
pool.on("error", () => {
  /* the page reports missing rows; a dropped idle client must not kill the server */
});

const COLUMNS = `id, parent_request_id, "timestamp", provider, model, served_model, status, stream,
  fallback_index, number_of_retries, latency, upstream_latency, overhead_latency, overhead_breakdown,
  attempt_trail, routing_engines_used, selected_key_name, stop_reason, error_details,
  prompt_tokens, completion_tokens, total_tokens, cached_read_tokens, session_id, metadata`;

export interface BifrostLog {
  id: string;
  parent_request_id: string | null;
  timestamp: string;
  provider: string;
  model: string;
  served_model: string | null;
  status: string;
  stream: boolean;
  fallback_index: number | null;
  number_of_retries: number | null;
  latency: number | null;
  upstream_latency: number | null;
  overhead_latency: number | null;
  overhead_breakdown: Record<string, number> | null;
  attempt_trail: unknown;
  routing_engines_used: string | null;
  selected_key_name: string | null;
  stop_reason: string | null;
  error_details: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_read_tokens: number | null;
  session_id: string | null;
  metadata: unknown;
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string" || !v) return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function normalize(row: Record<string, unknown>): BifrostLog {
  const n = (k: string) => (row[k] === null || row[k] === undefined ? null : Number(row[k]));
  return {
    ...(row as unknown as BifrostLog),
    timestamp: new Date(row.timestamp as string).toISOString(),
    fallback_index: n("fallback_index"),
    number_of_retries: n("number_of_retries"),
    latency: n("latency"),
    upstream_latency: n("upstream_latency"),
    overhead_latency: n("overhead_latency"),
    overhead_breakdown: parseJson(row.overhead_breakdown) as Record<string, number> | null,
    attempt_trail: parseJson(row.attempt_trail),
    metadata: parseJson(row.metadata),
    prompt_tokens: n("prompt_tokens"),
    completion_tokens: n("completion_tokens"),
    total_tokens: n("total_tokens"),
    cached_read_tokens: n("cached_read_tokens"),
  };
}

export async function logsForTrace(runId: string, traceId: string): Promise<BifrostLog[]> {
  const { rows } = await pool.query(
    `select ${COLUMNS} from logs where session_id = $1 and metadata like $2 order by "timestamp" asc`,
    [runId, `%${traceId}%`],
  );
  return rows.map(normalize);
}

/** Top-level requests only: a fallback attempt is a separate row pointing at its parent. */
export async function countLogs(runId: string): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as c from logs where session_id = $1 and parent_request_id is null`,
    [runId],
  );
  return rows[0].c as number;
}

export async function countFallbacks(runId: string): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as c from logs where session_id = $1 and parent_request_id is not null`,
    [runId],
  );
  return rows[0].c as number;
}

/** Bifrost flushes logs in batches, so poll until the count stops moving. */
export async function settledLogCount(runId: string, expected: number, timeoutMs = 120000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const c = await countLogs(runId);
    if (c >= expected) return c;
    stable = c === last ? stable + 1 : 0;
    last = c;
    if (stable >= 20 && c > 0) return c; // no new rows for 10s: whatever is missing was dropped
    await new Promise((r) => setTimeout(r, 500));
  }
  return Math.max(last, 0);
}
