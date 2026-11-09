#!/bin/bash
cd "$(dirname "$0")"
nginx -c "$PWD/nginx.conf" -p "$PWD" -s stop 2>/dev/null
for p in run/*.pid; do [ "$p" = run/nginx.pid ] && continue; pkill -P "$(cat $p)" 2>/dev/null; kill "$(cat $p)" 2>/dev/null; rm -f "$p"; done
LC_ALL=C /opt/homebrew/opt/postgresql@16/bin/pg_ctl -D pgdata stop -m fast 2>/dev/null
