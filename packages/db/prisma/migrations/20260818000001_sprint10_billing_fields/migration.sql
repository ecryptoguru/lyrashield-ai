-- Sprint 10 / Track A: Billing fields, workspace grace/trial, usage cycle, MinutePack model.

-- BillingAccount: subscription interval, period boundaries, cancellation, region, spend limit
ALTER TABLE "BillingAccount" ADD COLUMN "interval" TEXT;
ALTER TABLE "BillingAccount" ADD COLUMN "currentPeriodStart" TIMESTAMP(3);
ALTER TABLE "BillingAccount" ADD COLUMN "currentPeriodEnd" TIMESTAMP(3);
ALTER TABLE "BillingAccount" ADD COLUMN "canceledAt" TIMESTAMP(3);
ALTER TABLE "BillingAccount" ADD COLUMN "region" TEXT;
ALTER TABLE "BillingAccount" ADD COLUMN "spendLimitCents" INTEGER;

-- Workspace: grace period tracking, deep-scan entitlement, trial start
ALTER TABLE "Workspace" ADD COLUMN "graceUsedMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Workspace" ADD COLUMN "graceCycleStart" TIMESTAMP(3);
ALTER TABLE "Workspace" ADD COLUMN "deepAllowed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Workspace" ADD COLUMN "trialStartedAt" TIMESTAMP(3);

-- UsageRecord: billing cycle boundary for balance queries
ALTER TABLE "UsageRecord" ADD COLUMN "cycleStart" TIMESTAMP(3);
CREATE INDEX "UsageRecord_workspaceId_cycleStart_idx" ON "UsageRecord"("workspaceId", "cycleStart");

-- MinutePack: prepaid agent-minute packs purchased by a workspace
CREATE TABLE "MinutePack" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "minutes" INTEGER NOT NULL,
  "remainingMinutes" INTEGER NOT NULL,
  "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MinutePack_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MinutePack_workspaceId_externalId_key" ON "MinutePack"("workspaceId", "externalId");
CREATE INDEX "MinutePack_workspaceId_expiresAt_idx" ON "MinutePack"("workspaceId", "expiresAt");

ALTER TABLE "MinutePack" ADD CONSTRAINT "MinutePack_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: MinutePack is workspace-scoped
ALTER TABLE "MinutePack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MinutePack" FORCE ROW LEVEL SECURITY;

CREATE POLICY minutepack_rls_strict ON "MinutePack"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
