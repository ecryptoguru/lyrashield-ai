-- A single durable checkpoint and lease for the report-only billing sweep.
-- The worker queries this through DATABASE_SYSTEM_URL; tenant runtime roles
-- must not read or mutate the global cursor.
CREATE TABLE "billing_reconciliation_state" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "coverage_from" TIMESTAMPTZ(3) NOT NULL,
  "last_completed_at" TIMESTAMPTZ(3),
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_reconciliation_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_reconciliation_state_singleton_check" CHECK ("id" = 'singleton'),
  CONSTRAINT "billing_reconciliation_state_lease_check" CHECK (
    ("lease_token" IS NULL AND "lease_expires_at" IS NULL)
    OR ("lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
  )
);

ALTER TABLE "billing_reconciliation_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_reconciliation_state" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "billing_reconciliation_state" FROM PUBLIC;

CREATE POLICY "billing_reconciliation_state_system_only"
  ON "billing_reconciliation_state"
  FOR ALL
  USING (current_user = 'app_system_prod')
  WITH CHECK (current_user = 'app_system_prod');

DO $billing_reconciliation_state_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime_prod') THEN
    REVOKE ALL PRIVILEGES ON TABLE "billing_reconciliation_state" FROM app_runtime_prod;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system_prod') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "billing_reconciliation_state" TO app_system_prod;
  END IF;
END
$billing_reconciliation_state_grants$;
