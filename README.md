# AI Gateway Test

在本机对比 AI 网关的可靠性和性能：**Bifrost v2.4.0**、**MLflow AI Gateway 3.12.0**、**LiteLLM 1.106.0**。

项目用 mock 上游和真实的 PostgreSQL、nginx 复现生产环境里的故障，再用一个 Web 控制台（LoadLab）做压测、看请求链路、跑长对话。全部是本机进程，不用 Docker，也不会访问生产环境。

## 包含什么

| 模块 | 路径 | 作用 |
|---|---|---|
| 故障对比测试 | `run_tests.py` | 让 MLflow 和 Bifrost 经 nginx 跑相同的请求，覆盖上游 500 / 429 / 卡死、PostgreSQL 宕机、SSE 流式 |
| mock 上游 | `mock_llm.py` | OpenAI 兼容接口，可在运行时切换 ok / 500 / 429 / timeout / slow |
| 数据库故障模拟与修复 | `faults/` | 模拟 pgloader 迁移留下的 schema 损坏，验证 MLflow 升级失败，并用脚本修复 |
| 网关压测台 LoadLab | `loadlab/` | Fastify + React 控制台，详见 [loadlab/README.md](loadlab/README.md) |
| 真实 key 转发 | `cmdtap.py`、`loadlab/server/src/tap.ts` | 在转发时注入真实 key，网关配置里只放占位值 |
| Bifrost 控制台中文化 | `bifrost-zh/` | 通过 nginx 注入或用户脚本翻译界面，详见 [bifrost-zh/README.md](bifrost-zh/README.md) |

## 主要结论

| 故障 | MLflow 3.12.0 | Bifrost v2.4.0 |
|---|---|---|
| PostgreSQL 宕机 25 秒 | 238/238 返回 503 | 244/244 成功，但丢失 216 条日志 |
| 主上游返回 500 | 20/20 切到备用 | 20/20 切到备用 |
| 主上游返回 429 | 170/170 切到备用 | 167/170 成功 |
| 主上游卡死 | 0/5 成功，上游超时固定 300 秒，nginx 60 秒先返回 504 | 5/5 成功，10 秒后切到备用 |
| pgloader 建的库直接升级 | 失败，修复 schema 后成功 | 不适用 |

数据库挂掉时 MLflow 网关直接不可用；Bifrost 能继续转发，但那段时间的日志会丢。测试方法和完整结果见 [REPORT.md](REPORT.md)。

这些结果来自单机 mock 环境，适合做相对比较，不代表线上容量。

## LoadLab 功能

- **压测**：选择网关和上游（Mock、MiniMax、Command Code），支持阶梯加压、固定并发、固定 RPS，可注入 mock 故障，实时显示吞吐、延迟、并发和状态码，并对比历史运行。
- **请求链路**：查看单条请求的瀑布图、网关内部各阶段耗时和请求 / 响应内容。
- **长对话**：用真实 key 跑多轮对话，每轮携带完整历史，最后一轮校验上下文是否真的传到了模型。

使用真实 key 时，服务端会强制限制并发、总请求数、`max_tokens` 和时长，避免误耗额度。

## 环境要求

脚本里写死了 Homebrew 路径，目前只适用于 Apple Silicon 的 macOS。

- PostgreSQL 16（`/opt/homebrew/opt/postgresql@16`）、nginx
- Python 3.11
- Node.js 24、pnpm
- Bifrost v2.4.0 二进制

## 从零搭建

仓库不包含二进制、虚拟环境、数据库和密钥，克隆后需要自己准备。以下步骤根据现有脚本整理，尚未在全新机器上完整验证过。

**1. 安装依赖**

```bash
python3.11 -m venv .venv
.venv/bin/pip install "mlflow==3.12.0" fastapi uvicorn httpx "psycopg[binary]" psycopg2-binary

python3.11 -m venv .venv-litellm
.venv-litellm/bin/pip install "litellm[proxy]==1.106.0" prisma

(cd loadlab/server && pnpm install)
(cd loadlab/web && pnpm install && pnpm build)
```

把 Bifrost v2.4.0 的二进制放到 `bin/bifrost`。

**2. 初始化数据库**

PostgreSQL 监听 55432，不影响本机原有实例。

```bash
/opt/homebrew/opt/postgresql@16/bin/initdb -D pgdata -U postgres --auth=trust
mkdir -p logs
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D pgdata -o "-p 55432 -k /tmp" -l logs/pg.log start
for db in mlflow_clean bifrost litellm; do ./pg.sh -d postgres -c "create database $db"; done
```

**3. 生成本地密钥**

```bash
echo "sk-$(openssl rand -hex 16)" > loadlab/litellm/master_key.txt
openssl rand -hex 16 > bifrost/setup_token.txt
```

**4. 配置真实 key（可选，只用 Mock 上游时不需要）**

| 上游 | 文件 | 内容 |
|---|---|---|
| Command Code | 项目根目录 `.env.commandcode` | `CMD_API_KEY=你的 key` |
| MiniMax | `~/.config/pixel-science-video/minimax.env` | `MINIMAX_API_KEY=你的 key` |

**5. 启动并创建 MLflow endpoint**

setup 脚本依赖 MLflow 服务，要等 `start.sh` 启动完成后再运行，每个库只需运行一次。

```bash
./start.sh
.venv/bin/python setup_mlflow_gateway.py
.venv/bin/python loadlab/setup_mlflow_endpoints.py
.venv/bin/python setup_mlflow_cmd.py
```

打开 http://127.0.0.1:18100 进入压测台。停止所有服务：

```bash
./stop.sh
```

## 运行故障测试

```bash
.venv/bin/python run_tests.py
./faults/upgrade_test.sh
```

`run_tests.py` 会把结果写入 `results/results.json`。

## 端口

服务只监听本机。

| 端口 | 服务 |
|---|---|
| 18100 | LoadLab 控制台 |
| 18090 | LoadLab 的 tap 代理（注入 MiniMax key） |
| 18091 | cmdtap（注入 Command Code key） |
| 8080 | Bifrost |
| 5050 | MLflow AI Gateway |
| 4000 | LiteLLM 网关 |
| 18001 / 18002 | mock 主上游 / 备用上游 |
| 18080 / 18081 | nginx 代理 MLflow / Bifrost，模拟生产的 HTTP/1.0 和 60 秒超时 |
| 18082 | Bifrost 中文控制台 |
| 55432 | PostgreSQL 16 |

## 密钥与安全

- 真实 key 不进入网关配置，只存在转发进程的内存里；网关中配置的 `sk-mock`、`sk-placeholder-*` 都是占位值。
- `.env.*`、`master_key.txt`、`setup_token.txt`、数据库、日志和运行结果都已写入 `.gitignore`。
- 本地数据库使用 `trust` 认证，`mock-kek` 等配置也只用于本地测试，不要把这套配置用到生产环境或暴露到公网。
