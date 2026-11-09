#!/bin/bash
# Reproduce: MLflow 3.5.0 schema -> pgloader damage -> 3.12.0 upgrade (fails) -> repair -> upgrade (succeeds).
# Needs the stack's PG running (./start.sh). Uses databases up_base, up_damaged, up_ref.
set -u
cd "$(dirname "$0")/.."
DSN=postgresql://postgres@localhost:55432
init_35() { .venv-old/bin/python -W ignore -c "from mlflow.store.tracking.sqlalchemy_store import SqlAlchemyStore as S; S('$DSN/$1','./run/art')" >/dev/null 2>&1; }
for d in up_base up_damaged up_ref; do ./pg.sh -qc "drop database if exists $d" -c "create database $d"; init_35 $d; done
./pg.sh -d up_damaged -q -f faults/pgloader_damage.sql
.venv/bin/mlflow db upgrade $DSN/up_base > logs/up-control.log 2>&1; echo "control upgrade exit=$?"
.venv/bin/mlflow db upgrade $DSN/up_damaged > logs/up-damaged.log 2>&1; echo "damaged upgrade exit=$? ($(grep -m1 -o 'index "[a-z_]*" does not exist' logs/up-damaged.log))"
.venv/bin/python faults/repair_schema.py $DSN/up_damaged $DSN/up_ref --apply | tail -1
.venv/bin/mlflow db upgrade $DSN/up_damaged > logs/up-repaired.log 2>&1; echo "repaired upgrade exit=$?"
