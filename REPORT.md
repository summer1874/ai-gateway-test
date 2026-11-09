# MLflow 3.12.0 vs Bifrost v2.4.0 本地故障 mock 测试

测试日期 2026-11-06，全部在本机完成，没有访问生产。原始数据在 `results/results.json`，日志在 `logs/`。

## 结论

| 故障 | MLflow 3.12.0 AI Gateway | Bifrost v2.4.0 |
|---|---|---|
| PostgreSQL 宕机 25 秒 | **全部失败**：238/238 返回 503 `TEMPORARILY_UNAVAILABLE` | **请求不受影响**：244/244 成功 |
| 宕机期间的观测数据 | 请求被拒，没有 trace | 216 条日志被丢弃，只写入 44 条 |
| PG 恢复后 | 立即恢复，第一个请求就成功 | 立即恢复 |
| 主上游返回 500 | 20/20 切到备用，成功 | 20/20 切到备用，成功 |
| 主上游返回 429 | 170/170 切到备用，成功 | 167/170 成功，有 1 次 429、2 次 502 没切过去（约 1.8%） |
| 主上游卡死不响应 | 0/5 成功：上游超时写死 300 秒，nginx 60 秒先返回 504，fallback 来不及触发 | 5/5 成功：10 秒超时后切到备用 |
| 经 nginx HTTP/1.0 走 SSE 流式 | 正常，首字 0.17 秒（直连 0.02 秒） | 正常，首字 0.01 秒 |
| pgloader 建的库直接升级 | **失败**，找不到 `index_jobs_function_status_creation_time` | 不适用 |
| 用修复脚本对齐后升级 | 成功，3.5.0 → 3.12.0 (`7d34483879f0`) | 不适用 |
| 实验 ID 没有 sequence | 新建实验和新建 gateway endpoint 都失败，报错还被误报成 "already exists" | 不适用 |
| `duration_ns` 被改成 integer | 每个 span 都是 0（实际 2ms 到 3s），按耗时筛选和排序失效 | 不适用 |
| spans 被截断 | 该 trace 从搜索结果里消失（4 → 3），`get_trace` 报 "not fully exported yet"，没有任何告警 | 不适用 |

一句话：**数据库挂掉时 MLflow 网关直接不可用，Bifrost 能继续转发，但那段时间的日志会丢。** 上游卡死时，MLflow 的 fallback 在 nginx 默认超时下不会生效。

## 测试环境

全部是本机进程，没用 Docker。

| 组件 | 地址 | 说明 |
|---|---|---|
| PostgreSQL 16 | `localhost:55432` | 独立实例，数据在 `pgdata/`，不影响本机原有的 5432 |
| mock LiteLLM（主上游） | `127.0.0.1:18001` | OpenAI 兼容，可以运行时切换 ok / 500 / 429 / timeout / slow |
| mock DashScope（备用上游） | `127.0.0.1:18002` | 同上 |
| MLflow 3.12.0 | `127.0.0.1:5050`，nginx `18080` | 库 `mlflow_clean`，endpoint `chat`：主 LiteLLM，备 DashScope，SEQUENTIAL fallback |
| Bifrost v2.4.0 | `127.0.0.1:8080`，nginx `18081` | config store 和 logs store 都在 PG 库 `bifrost`；请求带 `fallbacks: ["groq/mock-model"]`，指向备用上游 |
| nginx 1.31.8 | 18080 / 18081 | 用默认配置模拟生产代理：`proxy_http_version 1.0`，`proxy_read_timeout 60s` |
| Bifrost 中文控制台 | `127.0.0.1:18082` | nginx 注入翻译脚本，可以切换中英文，见 `bifrost-zh/README.md`。不参与测试 |
| 网关压测台 | `127.0.0.1:18100` | Bifrost、MLflow、LiteLLM 的压测、请求链路和长对话页面，tap 代理在 18090，见 `loadlab/README.md`。不参与测试 |
| LiteLLM 网关 | `127.0.0.1:4000` | v1.106.0，只供压测台使用。不要和 18001 的 mock 上游混淆 |

## 怎么模拟生产故障

1. **pgloader 留下的 schema**（`faults/pgloader_damage.sql`）：
   - 所有索引、主键和唯一约束都改名成 `idx_<oid>_<原名>`，外键也改名。
   - `spans.duration_ns` 从生成列改成 `integer DEFAULT 0`。
   - `experiments.experiment_id` 去掉了 sequence。
2. **升级测试**：先用 MLflow 3.5.0 建库，然后：
   - 对照组：不做破坏，直接升级到 3.12.0，结果成功。
   - 破坏组：施加上面的破坏后再升级，结果失败。
   - 修复组：先运行 `faults/repair_schema.py`，再升级，结果成功。
3. **运行时测试**：
   - 用 3.12.0 建库并施加破坏（库 `mlflow_prodlike`），在 5051 端口单独起一个 MLflow。
   - 在上面检查新建 endpoint、`duration_ns` 和截断 spans 的效果。测完已经停掉。
4. **网关对比**（`run_tests.py`）：两个网关都走 nginx，跑同样的请求。
   - 上游故障：切换 mock 上游的模式，每个场景 20 个请求，并发 5。
   - DB 宕机：两个网关各 2 个并发持续请求；第 5 秒运行 `pg_ctl stop` 停库，25 秒后重启，再观察 20 秒。

## 修复异常状态的 MLflow

`faults/repair_schema.py` 拿受损库和一个由 alembic 在同一版本建出来的参考库做对比：

- 把 `idx_<oid>_` 前缀去掉，恢复索引、主键和唯一约束的原名。
- 按"表 + 列 + 被引用表"匹配外键，恢复参考库里的名字。
- 把 `duration_ns` 恢复成生成列。生成列由 PG 根据开始和结束时间重算，历史数据也会一起修正。
- 重建 `experiments_experiment_id_seq`，并把它推进到 `max(experiment_id)` 之后。

先不加 `--apply` 运行，它只打印 SQL，可以先审。本次测试库一共生成 105 条语句，执行后 `mlflow db upgrade` 成功。

```bash
.venv/bin/python faults/repair_schema.py <受损库DSN> <参考库DSN>
```

生产上执行前，需要先用生产当前的 alembic 版本单独建一个参考库，并且先在备份上演练。

## 需要注意的地方

- **Bifrost 宕机时丢日志**：日志显示 `batch insert of N log entries dropped after transient store failure`，4 批共 216 条，不会补写。Bifrost 能保住请求，但保不住那段时间的观测数据。
- **Bifrost 429 时偶尔切不过去**：3 轮测试里，每 50 个请求有 1 个返回 502，第一轮还有 1 个原样返回 429，原因还没查清。如果真要切换到 Bifrost，这个要先复现清楚。
- **MLflow 的上游超时没法改**：300 秒写死在 `mlflow/gateway/constants.py:25`。要让上游卡死时 fallback 能生效，只能把 nginx 的 `proxy_read_timeout` 调到 300 秒以上，但那样客户端就要等 5 分钟。
- **MLflow 的错误信息会误导**：缺 sequence 导致的 NotNullViolation 被报成 `RESOURCE_ALREADY_EXISTS`，排查时容易走偏。
- **本次没覆盖的内容**：真实的 LiteLLM 1.88.1、DashScope、mmt-cowork 的 SDK 埋点、大数据量下的 pgloader 截断过程（只模拟了结果），以及高并发压测。

## 复现

```bash
./start.sh
```

```bash
.venv/bin/python setup_mlflow_gateway.py
```

```bash
.venv/bin/python run_tests.py
```

```bash
./faults/upgrade_test.sh
```

```bash
./stop.sh
```

`setup_mlflow_gateway.py` 每个库只需要运行一次，重复运行会因为 secret 已存在而报错。Bifrost 配置在 `bifrost/config.json`，首次启动后会写进 PG；之后改了配置，要先清空 `bifrost` 库。
