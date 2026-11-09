# 网关压测台（LoadLab）

地址：http://127.0.0.1:18100 （只监听本机）。`../start.sh` / `../stop.sh` 会一起启停。

## 支持的网关

| 网关 | 地址 | 备注 |
|---|---|---|
| Bifrost v2.4.0 | 127.0.0.1:8080 | |
| MLflow AI Gateway 3.12.0 | 127.0.0.1:5050 | 端点由 `setup_mlflow_endpoints.py` 创建 |
| LiteLLM 1.106.0 | 127.0.0.1:4000 | 独立环境 `.venv-litellm`，配置在 `litellm/config.yaml`，master key 在 `litellm/master_key.txt` |

注意：`18001` 上的 “mock LiteLLM” 只是假上游，真正的 LiteLLM 网关在 4000。

## 三个页面

- **压测**：选网关，上游选 Mock 或 MiniMax，模式有阶梯、固定并发、固定 RPS，可注入 mock 故障（500 / 429 / timeout / slow）。页面下方有各次运行的对比表。Bifrost 还会对比「发送数」和「日志落库数」。
- **请求链路**：选一条请求看瀑布图、网关内部各阶段耗时、请求/响应内容。
- **长对话**：用真实 MiniMax key 跑一段完整对话，每轮带全部历史，最后一轮校验上下文。

## 链路数据来源

| 层 | 来源 |
|---|---|
| 客户端请求 | 压测引擎实测 |
| Bifrost 处理 | Bifrost `logs` 表 |
| MLflow / LiteLLM 处理 | 网关响应头里的耗时和开销，只显示数值，不画在时间轴上 |
| 上游 MiniMax | tap 代理（18090）实测，mock 路径没有这一层 |

trace id 的传递方式因网关而异：

- Bifrost：`x-bf-lh-loadlab-trace` 写入日志 metadata，`x-bf-eh-x-loadlab-trace` 透传到 tap，`x-bf-session-id` 是运行 ID。
- MLflow：请求体 `user` 字段，tap 转发给 MiniMax 前删除。
- LiteLLM：请求体 `extra_headers`（`user` 会被它丢弃）。

## key 的处理

真实 key 从 `~/.config/pixel-science-video/minimax.env` 读入，只存在 LoadLab 进程内存里，由 tap 写进发往 MiniMax 的请求。三个网关里配的都是占位 key。

## Command Code 上游

压测页「上游」可选 Command Code 真实 key（只支持压测页，长对话仍是 MiniMax）。三个网关经 `../cmdtap.py`（18091）转发，由它注入 `../.env.commandcode` 里的真实 key；MLflow 的 endpoint 由 `../setup_mlflow_cmd.py` 创建。模型列表在 `server/src/engine.ts` 的 `CMD_MODELS`。限制与下面的真实 key 上限相同；MLflow 走 Command Code 可以用流式。该上游没有 tap 层，请求链路页没有独立的上游时序。

## 真实 key 上限（服务端强制）

压测：并发 ≤ 3、总请求 ≤ 30、max_tokens ≤ 512、时长 ≤ 120 秒、不支持 fallback。长对话：3–40 轮，单轮 max_tokens 1024（模型可能先输出思考内容，需要留余量）。上限在 `server/src/engine.ts` 的 `REAL_LIMITS` 和 `server/src/chat.ts` 的 `CHAT_LIMITS`。

## 已知限制

- MLflow 3.12 读取流式片段时直接取 `finish_reason`（`mlflow/gateway/providers/openai.py:115`），MiniMax 的片段没有这个字段，会报 `KeyError`。所以 MLflow 走 MiniMax 时只能用非流式，没有 TTFT。
- LiteLLM 没有配数据库，因此没有网关侧的请求日志，页面只用响应头。

## 开发

```bash
cd loadlab/web && pnpm build      # 改前端后重新构建
cd loadlab/server && pnpm start   # 单独启动后端
```

每次运行的结果保存在 `loadlab/results/`。请求明细只在内存里保留最近 20000 条，重启后清空。

## 注意

- 落库数和 Bifrost 自报的丢弃数依赖 `bifrost/setup_token.txt`。建好管理员账号后，丢弃数这一项不再显示，其余功能不受影响。
- 压测机和 Bifrost、mock 在同一台电脑上，结果用于相对比较，不代表线上容量。mock 是单进程 uvicorn，高并发下瓶颈可能在 mock。这台 Mac 的 `kern.ipc.somaxconn` 是 128，高并发时 Python 网关的 `ECONNRESET` 可能部分来自这个系统限制。

## 接入 pi

`~/.pi/agent/models.json` 里有三个 provider，都指向本地网关：

| provider | baseUrl | 模型 ID 示例 |
|---|---|---|
| `bifrost-minimax` | `http://127.0.0.1:8080/v1` | `minimax-tap/MiniMax-M2.7-highspeed` |
| `litellm-minimax` | `http://127.0.0.1:4000/v1` | `minimax/MiniMax-M2.7-highspeed` |
| `mlflow-minimax` | `http://127.0.0.1:18100/pi/mlflow/v1` | `MiniMax-M2.7-highspeed` |

pi 总是用流式，而 MLflow 3.12 解析 MiniMax 流式会报 `KeyError: finish_reason`，所以 MLflow 这条走
`server/src/piAdapter.ts`：非流式请求 MLflow，再把完整回答转成 SSE 返回，回答是整段出现的。
三条路都依赖 LoadLab 进程里的 tap 代理（18090）。

## LiteLLM 管理界面

地址 `http://127.0.0.1:4000/ui/`，用户名 `admin`，密码是 `litellm/master_key.txt` 里的 master key。
登录需要数据库，`litellm/start.sh` 通过 `DATABASE_URL` 连本地 PG（55432）的 `litellm` 库。
接库之前跑的 LiteLLM 压测数据和接库之后的不能直接对比。
