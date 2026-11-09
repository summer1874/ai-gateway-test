"""Fault-injection comparison: MLflow AI Gateway 3.12.0 vs Bifrost v2.4.0, both behind nginx (HTTP/1.0 proxy).

Scenarios mirror what happened in the test/prod environment:
  S0 baseline              S1 primary upstream 500      S2 primary upstream 429
  S3 primary upstream hang S4 PostgreSQL down + recovery S5 SSE streaming through nginx HTTP/1.0
Writes results/results.json and prints a summary table.
"""
import asyncio
import json
import statistics
import subprocess
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).parent
PG_CTL = "/opt/homebrew/opt/postgresql@16/bin/pg_ctl"
ENV = {"LC_ALL": "C", "LANG": "C", "PATH": "/usr/bin:/bin:/opt/homebrew/bin"}
GATEWAYS = {
    "mlflow": {"url": "http://127.0.0.1:18080/gateway/mlflow/v1/chat/completions",
               "body": {"model": "chat"}},
    "bifrost": {"url": "http://127.0.0.1:18081/v1/chat/completions",
                "body": {"model": "openai/mock-model", "fallbacks": ["groq/mock-model"]}},
}
MSG = [{"role": "user", "content": "hi"}]


def psql(db: str, sql: str) -> str:
    r = subprocess.run([str(ROOT / "pg.sh"), "-d", db, "-Atc", sql], capture_output=True, text=True)
    return r.stdout.strip()


def persisted() -> dict:
    return {"mlflow": int(psql("mlflow_clean", "select count(*) from trace_info") or 0),
            "bifrost": int(psql("bifrost", "select count(*) from logs") or 0)}


async def mode(m: str):
    async with httpx.AsyncClient() as c:
        await c.post("http://127.0.0.1:18001/__mode", json={"mode": m})


async def upstream_hits() -> dict:
    async with httpx.AsyncClient() as c:
        return {n: (await c.get(f"http://127.0.0.1:{p}/__stats")).json()["hits"] for n, p in
                [("litellm", 18001), ("dashscope", 18002)]}


async def call(client, gw, timeout=70):
    g = GATEWAYS[gw]
    t = time.perf_counter()
    try:
        r = await client.post(g["url"], json={**g["body"], "messages": MSG}, timeout=timeout)
        served = ""
        if r.status_code == 200:
            served = "dashscope" if "dashscope" in r.text else "litellm"
        return {"code": r.status_code, "sec": time.perf_counter() - t, "served": served, "err": r.text[:160] if r.status_code != 200 else ""}
    except Exception as e:
        return {"code": type(e).__name__, "sec": time.perf_counter() - t, "served": "", "err": str(e)[:160]}


def summarize(rs):
    ok = [r for r in rs if r["code"] == 200]
    codes = {}
    for r in rs:
        codes[str(r["code"])] = codes.get(str(r["code"]), 0) + 1
    lat = sorted(r["sec"] for r in rs)
    return {"n": len(rs), "ok": len(ok), "success_rate": round(len(ok) / max(len(rs), 1), 3), "codes": codes,
            "served_by": {s: sum(1 for r in ok if r["served"] == s) for s in ("litellm", "dashscope")},
            "p50_s": round(statistics.median(lat), 3) if lat else None, "max_s": round(lat[-1], 3) if lat else None,
            "sample_err": next((r["err"] for r in rs if r["err"]), "")}


async def burst(gw, n=20, conc=5, timeout=70):
    sem = asyncio.Semaphore(conc)
    async with httpx.AsyncClient() as c:
        async def one():
            async with sem:
                return await call(c, gw, timeout)
        return await asyncio.gather(*[one() for _ in range(n)])


async def scenario_upstream(name, m, n=20, timeout=70):
    out = {}
    for gw in GATEWAYS:
        await mode(m)
        before_db, before_up = persisted(), await upstream_hits()
        rs = await burst(gw, n=n, timeout=timeout)
        await asyncio.sleep(3)
        after_db, after_up = persisted(), await upstream_hits()
        s = summarize(rs)
        s["persisted"] = after_db[gw] - before_db[gw]
        s["upstream_calls"] = {k: after_up[k] - before_up[k] for k in after_up}
        out[gw] = s
    await mode("ok")
    return out


async def scenario_db_down(outage_s=25, recover_s=20):
    """Continuous traffic to both gateways; PostgreSQL is stopped then restarted mid-run."""
    results = {gw: [] for gw in GATEWAYS}
    before = persisted()
    phase = {"v": "before"}

    async def driver(gw):
        async with httpx.AsyncClient() as c:
            while phase["v"] != "done":
                p = phase["v"]
                r = await call(c, gw, timeout=30)
                r["phase"] = p
                results[gw].append(r)
                await asyncio.sleep(0.2)

    tasks = [asyncio.create_task(driver(gw)) for gw in GATEWAYS for _ in range(2)]
    await asyncio.sleep(5)
    subprocess.run([PG_CTL, "-D", str(ROOT / "pgdata"), "stop", "-m", "fast"], env=ENV, capture_output=True)
    phase["v"] = "outage"
    await asyncio.sleep(outage_s)
    subprocess.run([PG_CTL, "-D", str(ROOT / "pgdata"), "-o", "-p 55432 -k /tmp", "-l",
                    str(ROOT / "logs/pg.log"), "start", "-w"], env=ENV, capture_output=True)
    phase["v"] = "recovered"
    await asyncio.sleep(recover_s)
    phase["v"] = "done"
    await asyncio.gather(*tasks)
    await asyncio.sleep(8)  # let async loggers flush
    after = persisted()
    out = {}
    for gw, rs in results.items():
        out[gw] = {p: summarize([r for r in rs if r["phase"] == p]) for p in ("before", "outage", "recovered")}
        out[gw]["requests_total"] = len(rs)
        out[gw]["ok_total"] = sum(1 for r in rs if r["code"] == 200)
        out[gw]["persisted_total"] = after[gw] - before[gw]
        # first success after restart
        rec = [r for r in rs if r["phase"] == "recovered"]
        first_ok = next((i for i, r in enumerate(rec) if r["code"] == 200), None)
        out[gw]["failed_after_restart_before_first_ok"] = first_ok
    return out


async def scenario_stream():
    out = {}
    for gw, g in GATEWAYS.items():
        for via, url in [("nginx_http1.0", g["url"]),
                         ("direct", g["url"].replace("18080", "5050").replace("18081", "8080"))]:
            t = time.perf_counter()
            first, chunks, status = None, 0, None
            async with httpx.AsyncClient(timeout=30) as c:
                async with c.stream("POST", url, json={**g["body"], "messages": MSG, "stream": True}) as r:
                    status = r.status_code
                    proto = r.http_version
                    te = r.headers.get("transfer-encoding", "")
                    async for line in r.aiter_lines():
                        if line.startswith("data:"):
                            chunks += 1
                            if first is None:
                                first = time.perf_counter() - t
            out[f"{gw}/{via}"] = {"status": status, "http": proto, "transfer_encoding": te,
                                  "ttft_s": round(first or -1, 2), "total_s": round(time.perf_counter() - t, 2),
                                  "chunks": chunks}
    return out


async def main():
    res = {}
    print("S0 baseline");          res["S0_baseline"] = await scenario_upstream("baseline", "ok")
    print("S1 upstream 500");      res["S1_upstream_500"] = await scenario_upstream("500", "500")
    print("S2 upstream 429");      res["S2_upstream_429"] = await scenario_upstream("429", "429")
    print("S3 upstream hang");     res["S3_upstream_hang"] = await scenario_upstream("hang", "timeout", n=5, timeout=150)
    print("S5 streaming");         res["S5_streaming"] = await scenario_stream()
    print("S4 postgres down");     res["S4_db_down"] = await scenario_db_down()
    (ROOT / "results").mkdir(exist_ok=True)
    (ROOT / "results/results.json").write_text(json.dumps(res, indent=2, ensure_ascii=False))
    print(json.dumps(res, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
