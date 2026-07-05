-- Reconciling migration: brings migrations in sync with schema.prisma
-- Creates missing tables (ApiKey, Retest, OnboardingState) and adds all
-- missing columns/indexes/constraints that were applied via `prisma db push`
-- but never captured in a migration. This migration MUST run before the RLS
-- migration (20260705100000) which references ApiKey and Retest tables.

-- ─── Missing Tables ────────────────────────────────────────────────────────

-- CreateTable: ApiKey
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Retest
CREATE TABLE "Retest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultBefore" TEXT,
    "resultAfter" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Retest_pkey" PRIMARY KEY ("id")
);

-- CreateTable: OnboardingState (mapped to onboarding_states)
CREATE TABLE "onboarding_states" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "workspaceId" TEXT,
    "targetId" TEXT,
    "selectedGoal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_states_pkey" PRIMARY KEY ("id")
);

-- ─── Missing Columns ───────────────────────────────────────────────────────

-- Soft-delete columns missing from migrations
ALTER TABLE "Project" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Policy" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Scan" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "ScanEvent" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "FixProposal" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "PullRequest" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Ticket" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Integration" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "UsageRecord" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Report" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Schedule" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "BillingAccount" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Invitation" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "WebhookEvent" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Integration: missing columns
ALTER TABLE "Integration" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Integration" ADD COLUMN "metadata" JSONB;

-- UsageRecord: missing idempotencyKey
ALTER TABLE "UsageRecord" ADD COLUMN "idempotencyKey" TEXT;

-- Report: missing revokedAt + rename shareToken → shareTokenHash
ALTER TABLE "Report" ADD COLUMN "revokedAt" TIMESTAMP(3);
DROP INDEX "Report_shareToken_key";
ALTER TABLE "Report" RENAME COLUMN "shareToken" TO "shareTokenHash";

-- AuditLog: missing prevHash (hash was added in batch3_cvss migration)
ALTER TABLE "AuditLog" ADD COLUMN "prevHash" TEXT;

-- Evidence: missing encryptionKeyRef
ALTER TABLE "Evidence" ADD COLUMN "encryptionKeyRef" TEXT;

-- ─── Missing Indexes ───────────────────────────────────────────────────────

-- ApiKey indexes
CREATE UNIQUE INDEX "ApiKey_hashedKey_key" ON "ApiKey"("hashedKey");
CREATE INDEX "ApiKey_workspaceId_idx" ON "ApiKey"("workspaceId");
CREATE INDEX "ApiKey_prefix_idx" ON "ApiKey"("prefix");

-- Retest indexes
CREATE INDEX "Retest_workspaceId_idx" ON "Retest"("workspaceId");
CREATE INDEX "Retest_findingId_idx" ON "Retest"("findingId");
CREATE INDEX "Retest_scanId_idx" ON "Retest"("scanId");

-- OnboardingState indexes
CREATE UNIQUE INDEX "onboarding_states_userId_key" ON "onboarding_states"("userId");
CREATE INDEX "onboarding_states_userId_idx" ON "onboarding_states"("userId");

-- Target: missing unique constraints
CREATE UNIQUE INDEX "Target_workspaceId_repoFullName_key" ON "Target"("workspaceId", "repoFullName");
CREATE UNIQUE INDEX "Target_workspaceId_url_key" ON "Target"("workspaceId", "url");

-- Finding: replace wrong unique constraint + add composite index
DROP INDEX "Finding_workspaceId_dedupeKey_key";
CREATE UNIQUE INDEX "Finding_targetId_dedupeKey_key" ON "Finding"("targetId", "dedupeKey");
CREATE INDEX "Finding_workspaceId_status_severity_idx" ON "Finding"("workspaceId", "status", "severity");

-- Integration: missing unique constraint
CREATE UNIQUE INDEX "Integration_workspaceId_type_externalId_key" ON "Integration"("workspaceId", "type", "externalId");

-- UsageRecord: missing unique constraint
CREATE UNIQUE INDEX "UsageRecord_idempotencyKey_key" ON "UsageRecord"("idempotencyKey");

-- AuditLog: missing composite index
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- Report: new unique index on renamed column
CREATE UNIQUE INDEX "Report_shareTokenHash_key" ON "Report"("shareTokenHash");

-- ─── Missing Foreign Keys ──────────────────────────────────────────────────

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Retest" ADD CONSTRAINT "Retest_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Retest" ADD CONSTRAINT "Retest_findingId_fkey"
    FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Retest" ADD CONSTRAINT "Retest_scanId_fkey"
    FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
