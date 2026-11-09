"""Repair a pgloader-created MLflow schema so alembic can upgrade it.

Compares the damaged DB against a reference DB that alembic created at the same revision, then:
  - renames idx_<oid>_<name> indexes / PK / unique back to <name>
  - renames FK constraints to the reference name (matched by table + columns + referenced table)
  - restores spans.duration_ns as a generated column
  - restores the experiments.experiment_id sequence and moves it past max(id)
Usage: python repair_schema.py <damaged_dsn> <reference_dsn> [--apply]
"""
import re
import sys

import psycopg

damaged_dsn, ref_dsn = sys.argv[1], sys.argv[2]
apply = "--apply" in sys.argv

FK_SQL = """
SELECT c.conname, c.conrelid::regclass::text, c.confrelid::regclass::text,
       array_agg(a.attname ORDER BY a.attnum)
FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace GROUP BY 1, 2, 3"""

with psycopg.connect(ref_dsn) as ref:
    ref_idx = {r[0] for r in ref.execute("SELECT indexname FROM pg_indexes WHERE schemaname='public'")}
    ref_fk = {(t, rt, tuple(cols)): n for n, t, rt, cols in ref.execute(FK_SQL)}

stmts = []
with psycopg.connect(damaged_dsn) as db:
    for (name,) in db.execute("SELECT indexname FROM pg_indexes WHERE schemaname='public'"):
        m = re.match(r"idx_\d+_(.+)", name)
        if m and m.group(1) in ref_idx:
            stmts.append(f'ALTER INDEX "{name}" RENAME TO "{m.group(1)}"')
    for n, t, rt, cols in db.execute(FK_SQL):
        target = ref_fk.get((t, rt, tuple(cols)))
        if target and target != n:
            stmts.append(f'ALTER TABLE "{t}" RENAME CONSTRAINT "{n}" TO "{target}"')
    gen = db.execute("SELECT is_generated FROM information_schema.columns "
                     "WHERE table_name='spans' AND column_name='duration_ns'").fetchone()
    if gen and gen[0] != "ALWAYS":
        stmts += [
            "ALTER TABLE spans DROP COLUMN duration_ns",
            "ALTER TABLE spans ADD COLUMN duration_ns bigint GENERATED ALWAYS AS "
            "(end_time_unix_nano - start_time_unix_nano) STORED",
            "CREATE INDEX index_spans_experiment_id_duration ON spans (experiment_id, duration_ns)",
        ]
    default = db.execute("SELECT column_default FROM information_schema.columns "
                         "WHERE table_name='experiments' AND column_name='experiment_id'").fetchone()[0]
    if not default:
        stmts += [
            "CREATE SEQUENCE IF NOT EXISTS experiments_experiment_id_seq OWNED BY experiments.experiment_id",
            "SELECT setval('experiments_experiment_id_seq', GREATEST((SELECT max(experiment_id) FROM experiments), 1))",
            "ALTER TABLE experiments ALTER COLUMN experiment_id SET DEFAULT nextval('experiments_experiment_id_seq')",
        ]
    for s in stmts:
        print(s + ";")
    if apply:
        with db.transaction():
            for s in stmts:
                db.execute(s)
        print(f"-- applied {len(stmts)} statements")
