#!/bin/bash
# Start the whole mock stack. Ports: PG 55432, mock LiteLLM 18001, mock DashScope 18002,
# MLflow 5050 (via nginx 18080), Bifrost 8080 (via nginx 18081).
cd "$(dirname "$0")"; mkdir -p logs run
export LC_ALL=C LANG=C
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D pgdata status >/dev/null 2>&1 || /opt/homebrew/opt/postgresql@16/bin/pg_ctl -D pgdata -o "-p 55432 -k /tmp" -l logs/pg.log start
nohup .venv/bin/python mock_llm.py 18001 litellm  > logs/mock-litellm.log 2>&1 & echo $! > run/mock1.pid
nohup .venv/bin/python mock_llm.py 18002 dashscope > logs/mock-dashscope.log 2>&1 & echo $! > run/mock2.pid
MLFLOW_CRYPTO_KEK_PASSPHRASE=mock-kek nohup .venv/bin/mlflow server \
  --backend-store-uri postgresql://postgres@localhost:55432/mlflow_clean \
  --host 127.0.0.1 --port 5050 --workers 2 > logs/mlflow.log 2>&1 & echo $! > run/mlflow.pid
BIFROST_SETUP_TOKEN="$(cat bifrost/setup_token.txt 2>/dev/null)" nohup bin/bifrost -app-dir ./bifrost -port 8080 -host 127.0.0.1 > logs/bifrost.log 2>&1 & echo $! > run/bifrost.pid
nohup .venv/bin/python cmdtap.py > logs/cmdtap.log 2>&1 & echo $! > run/cmdtap.pid  # Command Code key-injecting forwarder on 18091
nginx -c "$PWD/nginx.conf" -p "$PWD"
# LiteLLM proxy on 4000 (a real gateway, unlike the mock upstream on 18001)
nohup loadlab/litellm/start.sh > logs/litellm.log 2>&1 & echo $! > run/litellm.pid
# LoadLab: load test + request trace page on 18100, tap proxy on 18090
(cd loadlab/server && nohup node_modules/.bin/tsx src/index.ts > ../../logs/loadlab.log 2>&1 & echo $! > ../../run/loadlab.pid)
