-- Wave A growth: first-touch acquisition attribution per account.
--
-- `AccountAcquisition` is account-owned (keyed by the owning User.id) with no
-- workspace column — marketing/attribution context, never tenant data and
-- never visible to workspace coworkers. Rows are created once (first-touch
-- wins) from a bounded sign-up cookie and read by the owner or the platform
-- admin console only.
--
-- Additive and forward-only: new table, new indexes, new RLS policies. The
-- onboarding_states.buildTool column is additive and nullable.

ALTER TABLE "onboarding_states" ADD COLUMN "buildTool" TEXT;

CREATE TABLE "account_acquisitions" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "source" TEXT,
  "cta" TEXT,
  "utmSource" TEXT,
  "utmMedium" TEXT,
  "utmCampaign" TEXT,
  "utmContent" TEXT,
  "landingRoute" TEXT,
  "targetTypeHint" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_acquisitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "account_acquisitions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "account_acquisitions_accountId_key" ON "account_acquisitions"("accountId");

-- Account-scoped RLS, mirroring the BillingAccount pattern: the row is
-- visible only while app.current_account_id matches, and the restrictive
-- owner boundary can never widen access beyond the owner.
ALTER TABLE "account_acquisitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_acquisitions" FORCE ROW LEVEL SECURITY;

CREATE POLICY accountacquisition_rls_account ON "account_acquisitions"
  FOR ALL USING ("accountId" = app.current_account_id())
  WITH CHECK ("accountId" = app.current_account_id());

CREATE POLICY accountacquisition_owner_boundary ON "account_acquisitions" AS RESTRICTIVE
  FOR ALL USING ("accountId" = app.current_account_id())
  WITH CHECK ("accountId" = app.current_account_id());
