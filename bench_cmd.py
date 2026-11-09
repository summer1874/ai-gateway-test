"""Small side-by-side of Command Code via direct(cmdtap) / Bifrost / LiteLLM / MLflow. Real money: keep N small.
Usage: python bench_cmd.py [N=20] [concurrency=3]   Measures non-stream latency and stream TTFT."""
import asyncio, json, statistics as st, sys, time
import httpx

N = int(sys.argv[1]) if len(sys.argv) > 1 else 20
C = int(sys.argv[2]) if len(sys.argv) > 2 else 3
M = "deepseek/deepseek-v4.1-flash-fast"
MK = open("loadlab/litellm/master_key.txt").read().strip()
GW = {
    "direct(cmdtap)": ("http://127.0.0.1:18091/v1/chat/completions", M, {}),
    "bifrost": ("http://127.0.0.1:8080/v1/chat/completions", "cmd-tap/" + M, {}),
    "litellm": ("http://127.0.0.1:4000/v1/chat/completions", "cmd/" + M, {"authorization": f"Bearer {MK}"}),
    "mlflow": ("http://127.0.0.1:5050/gateway/mlflow/v1/chat/completions", "cmd-deepseek-v4-1-flash-fast", {}),
}
BODY = lambda m, s: {"model": m, "stream": s, "max_tokens": 300, "messages": [{"role": "user", "content": "Reply with the single word: ok"}]}


async def one(cli, url, model, hdr, stream):
    t0 = time.perf_counter(); ttft = None
    try:
        if not stream:
            r = await cli.post(url, json=BODY(model, False), headers=hdr)
            return r.status_code, time.perf_counter() - t0, None
        async with cli.stream("POST", url, json=BODY(model, True), headers=hdr) as r:
            async for line in r.aiter_lines():
                if line.startswith("data:") and ttft is None:
                    ttft = time.perf_counter() - t0
            return r.status_code, time.perf_counter() - t0, ttft
    except Exception as e:
        return type(e).__name__, time.perf_counter() - t0, None


async def run(name, url, model, hdr, stream):
    sem = asyncio.Semaphore(C)
    async with httpx.AsyncClient(timeout=120) as cli:
        async def g():
            async with sem:
                return await one(cli, url, model, hdr, stream)
        res = await asyncio.gather(*[g() for _ in range(N)])
    ok = [r for r in res if r[0] == 200]
    lat = sorted(r[1] for r in ok)
    pct = lambda p: lat[min(len(lat) - 1, int(len(lat) * p))] if lat else float("nan")
    tt = [r[2] for r in ok if r[2] is not None]
    errs = {}
    for r in res:
        if r[0] != 200: errs[str(r[0])] = errs.get(str(r[0]), 0) + 1
    print(f"{name:15} {'stream' if stream else 'plain ':6} ok={len(ok)}/{N} p50={pct(.5):.2f}s p95={pct(.95):.2f}s"
          + (f" ttft_p50={st.median(tt):.2f}s" if tt else "") + (f" errs={errs}" if errs else ""))


async def main():
    for stream in (False, True):
        for name, (url, model, hdr) in GW.items():
            await run(name, url, model, hdr, stream)

asyncio.run(main())
