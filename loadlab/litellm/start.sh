#!/bin/bash
# Start the LiteLLM proxy on 127.0.0.1:4000. The master key is local to this mock stack.
cd "$(dirname "$0")/../.."
export LITELLM_MASTER_KEY="$(cat loadlab/litellm/master_key.txt)"
export LITELLM_LOCAL_MODEL_COST_MAP=True
# Admin UI login needs a database; the prisma CLI must be on PATH for migrations.
export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/litellm
export PATH="$PWD/.venv-litellm/bin:$PATH"
exec .venv-litellm/bin/litellm --config loadlab/litellm/config.yaml --host 127.0.0.1 --port 4000 --num_workers 2
