"""Key-injecting forwarder to Command Code's Provider API, so the real key lives only in this process.
Gateways point at http://127.0.0.1:18091/v1 with a placeholder key. Key is read from .env.commandcode.
Usage: python cmdtap.py   (listens on 18091)
"""
import os
import pathlib

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

UPSTREAM = "https://api.commandcode.ai/provider/v1"
ALLOWED = {"chat/completions", "responses", "models", "messages"}


def load_key() -> str:
    for line in (pathlib.Path(__file__).parent / ".env.commandcode").read_text().splitlines():
        if line.startswith("CMD_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("CMD_API_KEY missing in .env.commandcode")


KEY = load_key()
client = httpx.AsyncClient(timeout=httpx.Timeout(120, connect=10), limits=httpx.Limits(max_connections=200))
app = FastAPI()


@app.api_route("/v1/{path:path}", methods=["GET", "POST"])
async def proxy(path: str, request: Request):
    if path not in ALLOWED:
        return JSONResponse({"error": {"message": f"cmdtap does not allow {path}"}}, status_code=403)
    body = await request.body()
    headers = {"accept-encoding": "identity", "authorization": f"Bearer {KEY}", "content-type": request.headers.get("content-type", "application/json")}
    if "x-api-key" in request.headers or "anthropic-version" in request.headers:
        headers["anthropic-version"] = request.headers.get("anthropic-version", "2023-06-01")
    req = client.build_request(request.method, f"{UPSTREAM}/{path}", content=body, headers=headers)
    up = await client.send(req, stream=True)
    drop = {"transfer-encoding", "connection", "content-length", "content-encoding"}
    return StreamingResponse(up.aiter_raw(), status_code=up.status_code, background=None,
                             headers={k: v for k, v in up.headers.items() if k.lower() not in drop})


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=18091, log_level="warning")
