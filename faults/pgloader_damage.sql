-- Reproduce what pgloader left in prod (schema not created by alembic):
-- 1) every index / PK / unique renamed to idx_<oid>_<name>
-- 2) spans.duration_ns becomes a plain integer DEFAULT 0 (no generated column)
-- 3) experiments.experiment_id loses its sequence default
-- 4) FK constraints renamed to pgloader style
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT i.indexrelid::regclass::text AS iname, i.indexrelid AS oid
           FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.iname, left('idx_' || r.oid || '_' || r.iname, 63));
  END LOOP;
  FOR r IN SELECT conname, conrelid::regclass::text AS tbl, oid FROM pg_constraint
           WHERE contype = 'f' AND connamespace = 'public'::regnamespace LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.conname, left('fk_' || r.oid || '_' || r.tbl, 63));
  END LOOP;
END $$;
ALTER TABLE spans DROP COLUMN duration_ns;
ALTER TABLE spans ADD COLUMN duration_ns integer DEFAULT 0;
CREATE INDEX idx_99999_index_spans_experiment_id_duration ON spans (experiment_id, duration_ns);
ALTER TABLE experiments ALTER COLUMN experiment_id DROP DEFAULT;
