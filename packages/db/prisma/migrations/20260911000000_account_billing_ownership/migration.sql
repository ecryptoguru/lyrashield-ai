-- Account-owned subscriptions (launch-review remediation WP-A / F1).
--
-- Subscriptions belong to accounts, not workspaces. `BillingAccount.workspaceId`
-- becomes nullable purchase attribution (unique is preserved so the previous
-- image's upsert-by-workspace keeps working); `purchaseWorkspaceId` retains
-- provenance when attribution is NULL. `accountId` carries ownership on
-- BillingAccount / UsageRecord / MinutePack.
--
-- Additive and forward-only: no columns are dropped, no data is rewritten,
-- and the new RLS policies are permissive-OR additions that only activate
-- when the transaction binds `app.current_account_id`.

ALTER TABLE "BillingAccount" ALTER COLUMN "workspaceId" DROP NOT NULL;
ALTER TABLE "BillingAccount" ADD COLUMN "accountId" TEXT;
ALTER TABLE "BillingAccount" ADD COLUMN "purchaseWorkspaceId" TEXT;
ALTER TABLE "BillingAccount" ADD COLUMN "graceUsedMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BillingAccount" ADD COLUMN "graceCycleStart" TIMESTAMP(3);

-- Workspace deletion must not delete the account's subscription contract:
-- the attribution link detaches instead of cascading.
ALTER TABLE "BillingAccount" DROP CONSTRAINT "BillingAccount_workspaceId_fkey";
ALTER TABLE "BillingAccount" ADD CONSTRAINT "BillingAccount_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Subscription identity: one row per (provider, external subscription id).
-- NULL externalId rows (trials) do not conflict under SQL NULL semantics.
CREATE UNIQUE INDEX "BillingAccount_provider_externalId_key"
  ON "BillingAccount"("provider", "externalId");
CREATE INDEX "BillingAccount_workspaceId_idx" ON "BillingAccount"("workspaceId");
CREATE INDEX "BillingAccount_accountId_idx" ON "BillingAccount"("accountId");
CREATE INDEX "BillingAccount_status_currentPeriodEnd_idx"
  ON "BillingAccount"("status", "currentPeriodEnd");

ALTER TABLE "UsageRecord" ADD COLUMN "accountId" TEXT;
-- Ledger rows belong to the account: attribution detaches instead of
-- cascading when the workspace is deleted.
ALTER TABLE "UsageRecord" ALTER COLUMN "workspaceId" DROP NOT NULL;
ALTER TABLE "UsageRecord" DROP CONSTRAINT "UsageRecord_workspaceId_fkey";
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "UsageRecord_accountId_idx" ON "UsageRecord"("accountId");
CREATE INDEX "UsageRecord_accountId_cycleStart_idx"
  ON "UsageRecord"("accountId", "cycleStart");

ALTER TABLE "MinutePack" ADD COLUMN "accountId" TEXT;
ALTER TABLE "MinutePack" ALTER COLUMN "workspaceId" DROP NOT NULL;
ALTER TABLE "MinutePack" DROP CONSTRAINT "MinutePack_workspaceId_fkey";
ALTER TABLE "MinutePack" ADD CONSTRAINT "MinutePack_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "MinutePack_accountId_idx" ON "MinutePack"("accountId");

-- Account-scoped RLS context, mirroring app.current_workspace_id().
CREATE OR REPLACE FUNCTION app.current_account_id() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_account_id', true), '')
$$;

-- Permissive account policies: OR-ed with the existing workspace policies, so
-- a row is visible when its workspace matches the workspace context OR its
-- accountId matches the account context. With no account context bound the
-- right side is never true and behavior is exactly as before.
CREATE POLICY billingaccount_rls_account ON "BillingAccount"
  FOR ALL USING ("accountId" IS NOT NULL AND "accountId" = app.current_account_id())
  WITH CHECK ("accountId" IS NOT NULL AND "accountId" = app.current_account_id());

CREATE POLICY usagerecord_rls_account ON "UsageRecord"
  FOR ALL USING ("accountId" IS NOT NULL AND "accountId" = app.current_account_id())
  WITH CHECK ("accountId" IS NOT NULL AND "accountId" = app.current_account_id());

CREATE POLICY minutepack_rls_account ON "MinutePack"
  FOR ALL USING ("accountId" IS NOT NULL AND "accountId" = app.current_account_id())
  WITH CHECK ("accountId" IS NOT NULL AND "accountId" = app.current_account_id());

-- Workspace attribution must never expose an account-owned row to coworkers.
-- Legacy NULL-owner rows retain the existing workspace policy until mapped.
CREATE POLICY billingaccount_owner_boundary ON "BillingAccount" AS RESTRICTIVE
  FOR ALL USING ("accountId" IS NULL OR "accountId" = app.current_account_id())
  WITH CHECK ("accountId" IS NULL OR "accountId" = app.current_account_id());
CREATE POLICY usagerecord_owner_boundary ON "UsageRecord" AS RESTRICTIVE
  FOR ALL USING ("accountId" IS NULL OR "accountId" = app.current_account_id())
  WITH CHECK ("accountId" IS NULL OR "accountId" = app.current_account_id());
CREATE POLICY minutepack_owner_boundary ON "MinutePack" AS RESTRICTIVE
  FOR ALL USING ("accountId" IS NULL OR "accountId" = app.current_account_id())
  WITH CHECK ("accountId" IS NULL OR "accountId" = app.current_account_id());
