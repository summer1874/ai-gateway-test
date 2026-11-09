"""OpenAI-compatible mock upstream (stands in for LiteLLM / DashScope).

Fault mode is switched at runtime:  POST /__mode  {"mode": "ok|500|429|timeout|slow|reset"}
Counters:                           GET  /__stats
Usage: python mock_llm.py <port> <name>
"""
import asyncio
import json
import sys
import time

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

PORT, NAME = int(sys.argv[1]), sys.argv[2]
app = FastAPI()
state = {"mode": "ok", "hits": 0}


def completion(model: str, text: str) -> dict:
    return {
        "id": f"chatcmpl-{NAME}-{state['hits']}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


@app.post("/__mode")
async def set_mode(req: Request):
    state["mode"] = (await req.json())["mode"]
    return state


@app.get("/__stats")
async def stats():
    return state


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": "mock-model", "object": "model"}]}


@app.post("/v1/chat/completions")
async def chat(req: Request):
    state["hits"] += 1
    body = await req.json()
    mode = state["mode"]
    model = body.get("model", "mock-model")
    if mode == "500":
        return JSONResponse({"error": {"message": f"{NAME} internal error", "type": "server_error"}}, 500)
    if mode == "429":
        return JSONResponse({"error": {"message": f"{NAME} rate limited", "type": "rate_limit"}}, 429)
    if mode == "timeout":
        await asyncio.sleep(120)
    if mode == "slow":
        await asyncio.sleep(3)
    text = f"hello from {NAME}"
    if body.get("stream"):
        async def gen():
            for i, tok in enumerate(text.split()):
                chunk = {"id": "c", "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
                         "choices": [{"index": 0, "delta": {"role": "assistant", "content": tok + " "}, "finish_reason": None}]}
                yield f"data: {json.dumps(chunk)}\n\n"
                await asyncio.sleep(0.5)
            end = {"id": "c", "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
                   "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
            yield f"data: {json.dumps(end)}\n\ndata: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")
    return completion(model, text)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
