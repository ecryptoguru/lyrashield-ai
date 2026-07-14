-- Result integrity: every claim is recorded as a detection before it can be
-- independently validated. Existing findings remain compatible through the
-- legacy boolean while new scans use the explicit verification status.

CREATE TYPE "FindingCandidateStatus" AS ENUM ('DETECTED', 'PROMOTED', 'SUPPRESSED');
CREATE TYPE "FindingVerificationStatus" AS ENUM ('DETECTED', 'VALIDATED', 'VERIFIED', 'BLOCKED', 'INCONCLUSIVE');
CREATE TYPE "FindingVerificationMethod" AS ENUM ('ENGINE_CLAIM', 'SCANNER_DETECTION', 'SOURCE_RULE', 'DEPENDENCY_ADVISORY', 'URL_CHECK', 'RETEST', 'HUMAN_REVIEW');
CREATE TYPE "ScanCoverageStatus" AS ENUM ('COMPLETED', 'NOT_APPLICABLE', 'BLOCKED', 'TIMED_OUT', 'FAILED');

ALTER TABLE "Finding"
  ADD COLUMN "verificationStatus" "FindingVerificationStatus" NOT NULL DEFAULT 'DETECTED',
  ADD COLUMN "verificationMethod" "FindingVerificationMethod",
  ADD COLUMN "verificationReason" TEXT;

-- Historical `verified` values were derived from scanner confidence rather
-- than retained independent proof. Preserve the findings, but require a fresh
-- validation receipt before displaying them as verified risk.
UPDATE "Finding"
SET "verified" = false,
    "verificationStatus" = 'DETECTED',
    "verificationReason" = 'Legacy finding requires independent validation.'
WHERE "verified" = true;

CREATE TABLE "ScanResultManifest" (
  "id" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "manifest" JSONB NOT NULL,
  "checksum" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ScanResultManifest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScanCoverageReceipt" (
  "id" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "scanner" TEXT NOT NULL,
  "controlId" TEXT NOT NULL,
  "status" "ScanCoverageStatus" NOT NULL,
  "reason" TEXT,
  "subject" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ScanCoverageReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FindingCandidate" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "findingId" TEXT,
  "scannerSource" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "status" "FindingCandidateStatus" NOT NULL DEFAULT 'DETECTED',
  "payload" JSONB NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FindingCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FindingVerification" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "findingId" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "candidateId" TEXT,
  "status" "FindingVerificationStatus" NOT NULL,
  "method" "FindingVerificationMethod" NOT NULL,
  "reason" TEXT NOT NULL,
  "verifierVersion" TEXT,
  "sourceRevision" TEXT,
  "evidence" JSONB,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FindingVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScanResultManifest_scanId_key" ON "ScanResultManifest"("scanId");
CREATE UNIQUE INDEX "ScanCoverageReceipt_scanId_controlId_key" ON "ScanCoverageReceipt"("scanId", "controlId");
CREATE INDEX "ScanCoverageReceipt_scanId_idx" ON "ScanCoverageReceipt"("scanId");
CREATE INDEX "ScanCoverageReceipt_status_idx" ON "ScanCoverageReceipt"("status");
CREATE UNIQUE INDEX "FindingCandidate_scanId_dedupeKey_scannerSource_key" ON "FindingCandidate"("scanId", "dedupeKey", "scannerSource");
CREATE INDEX "FindingCandidate_workspaceId_idx" ON "FindingCandidate"("workspaceId");
CREATE INDEX "FindingCandidate_scanId_idx" ON "FindingCandidate"("scanId");
CREATE INDEX "FindingCandidate_targetId_idx" ON "FindingCandidate"("targetId");
CREATE INDEX "FindingCandidate_findingId_idx" ON "FindingCandidate"("findingId");
CREATE UNIQUE INDEX "FindingVerification_idempotencyKey_key" ON "FindingVerification"("idempotencyKey");
CREATE INDEX "FindingVerification_workspaceId_idx" ON "FindingVerification"("workspaceId");
CREATE INDEX "FindingVerification_findingId_createdAt_idx" ON "FindingVerification"("findingId", "createdAt");
CREATE INDEX "FindingVerification_scanId_idx" ON "FindingVerification"("scanId");
CREATE INDEX "FindingVerification_candidateId_idx" ON "FindingVerification"("candidateId");
CREATE INDEX "FindingVerification_status_idx" ON "FindingVerification"("status");

ALTER TABLE "ScanResultManifest"
  ADD CONSTRAINT "ScanResultManifest_scanId_fkey"
  FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScanCoverageReceipt"
  ADD CONSTRAINT "ScanCoverageReceipt_scanId_fkey"
  FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FindingCandidate"
  ADD CONSTRAINT "FindingCandidate_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FindingCandidate"
  ADD CONSTRAINT "FindingCandidate_scanId_fkey"
  FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FindingCandidate"
  ADD CONSTRAINT "FindingCandidate_targetId_fkey"
  FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FindingCandidate"
  ADD CONSTRAINT "FindingCandidate_findingId_fkey"
  FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FindingVerification"
  ADD CONSTRAINT "FindingVerification_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FindingVerification"
  ADD CONSTRAINT "FindingVerification_findingId_fkey"
  FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FindingVerification"
  ADD CONSTRAINT "FindingVerification_scanId_fkey"
  FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FindingVerification"
  ADD CONSTRAINT "FindingVerification_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "FindingCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- These are direct workspace-owned tables, so they receive the same
-- permissive-when-unset / strict-when-bound RLS policy pair as the existing
-- workspace-scoped models. ScanResultManifest and ScanCoverageReceipt are
-- child tables without workspaceId and stay explicitly scoped through Scan.
ALTER TABLE "FindingCandidate" ENABLE ROW LEVEL SECURITY;
CREATE POLICY findingcandidate_rls_permissive ON "FindingCandidate"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY findingcandidate_rls_strict ON "FindingCandidate"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

ALTER TABLE "FindingVerification" ENABLE ROW LEVEL SECURITY;
CREATE POLICY findingverification_rls_permissive ON "FindingVerification"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY findingverification_rls_strict ON "FindingVerification"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
