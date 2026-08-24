-- Policy.maxBudgetUsd is an internal spend ceiling. A negative value is never
-- meaningful and would silently defeat the effective-budget calculation in
-- resolveScanBudgetUsd(), so PostgreSQL owns the invariant at the schema
-- boundary. NULL remains valid ("use the profile cap").
--
-- Idempotent by design: deployments re-run migration files only once per
-- _prisma_migrations, but keeping the guard is cheap and makes the shadow
-- database and manual replays safe.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Policy_maxBudgetUsd_nonnegative'
      AND conrelid = '"Policy"'::regclass
  ) THEN
    ALTER TABLE "Policy"
    ADD CONSTRAINT "Policy_maxBudgetUsd_nonnegative"
    CHECK ("maxBudgetUsd" IS NULL OR "maxBudgetUsd" >= 0);
  END IF;
END
$$;
