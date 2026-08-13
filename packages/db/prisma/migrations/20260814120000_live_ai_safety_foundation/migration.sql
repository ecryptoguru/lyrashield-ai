CREATE TYPE "DomainVerificationMethod" AS ENUM ('DNS_TXT', 'GOOGLE_SEARCH_CONSOLE');
CREATE TYPE "DomainVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED');
CREATE TYPE "LiveAiSafetyPlanStatus" AS ENUM ('DRAFT', 'READY', 'PENDING_APPROVAL', 'RUNNING', 'STOPPED', 'COMPLETED', 'FAILED');
CREATE TYPE "LiveAiSafetyRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'STOPPED', 'COMPLETED', 'FAILED');

CREATE TABLE "TargetDomainVerification" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "method" "DomainVerificationMethod" NOT NULL,
  "status" "DomainVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "challengeToken" TEXT,
  "challengeId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TargetDomainVerification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveAiSafetySettings" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "incidentContact" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LiveAiSafetySettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveAiSafetyPlan" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "domainVerificationId" TEXT NOT NULL,
  "endpointUrl" TEXT NOT NULL,
  "approvedHost" TEXT NOT NULL,
  "authMode" TEXT NOT NULL,
  "credentialId" TEXT,
  "incidentContact" TEXT NOT NULL,
  "maxRequests" INTEGER NOT NULL,
  "maxDurationSeconds" INTEGER NOT NULL,
  "maxResponseBytes" INTEGER NOT NULL,
  "rawSampleStorage" TEXT NOT NULL,
  "cases" JSONB NOT NULL,
  "status" "LiveAiSafetyPlanStatus" NOT NULL DEFAULT 'DRAFT',
  "approvalId" TEXT,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "terminalReason" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LiveAiSafetyPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveAiSafetyRun" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "status" "LiveAiSafetyRunStatus" NOT NULL DEFAULT 'QUEUED',
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "terminalReason" TEXT,
  "receipts" JSONB,
  "startedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LiveAiSafetyRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TargetDomainVerification_workspaceId_domain_key" ON "TargetDomainVerification"("workspaceId", "domain");
CREATE INDEX "TargetDomainVerification_workspaceId_status_expiresAt_idx" ON "TargetDomainVerification"("workspaceId", "status", "expiresAt");
CREATE UNIQUE INDEX "LiveAiSafetySettings_workspaceId_key" ON "LiveAiSafetySettings"("workspaceId");
CREATE INDEX "LiveAiSafetyPlan_workspaceId_targetId_createdAt_idx" ON "LiveAiSafetyPlan"("workspaceId", "targetId", "createdAt");
CREATE INDEX "LiveAiSafetyPlan_workspaceId_status_idx" ON "LiveAiSafetyPlan"("workspaceId", "status");
CREATE INDEX "LiveAiSafetyPlan_domainVerificationId_idx" ON "LiveAiSafetyPlan"("domainVerificationId");
CREATE INDEX "LiveAiSafetyRun_workspaceId_targetId_createdAt_idx" ON "LiveAiSafetyRun"("workspaceId", "targetId", "createdAt");
CREATE INDEX "LiveAiSafetyRun_workspaceId_status_idx" ON "LiveAiSafetyRun"("workspaceId", "status");
CREATE INDEX "LiveAiSafetyRun_planId_idx" ON "LiveAiSafetyRun"("planId");

ALTER TABLE "TargetDomainVerification" ADD CONSTRAINT "TargetDomainVerification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveAiSafetySettings" ADD CONSTRAINT "LiveAiSafetySettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveAiSafetyPlan" ADD CONSTRAINT "LiveAiSafetyPlan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveAiSafetyPlan" ADD CONSTRAINT "LiveAiSafetyPlan_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveAiSafetyPlan" ADD CONSTRAINT "LiveAiSafetyPlan_domainVerificationId_fkey" FOREIGN KEY ("domainVerificationId") REFERENCES "TargetDomainVerification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveAiSafetyRun" ADD CONSTRAINT "LiveAiSafetyRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveAiSafetyRun" ADD CONSTRAINT "LiveAiSafetyRun_planId_fkey" FOREIGN KEY ("planId") REFERENCES "LiveAiSafetyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TargetDomainVerification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TargetDomainVerification" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LiveAiSafetySettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LiveAiSafetySettings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LiveAiSafetyPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LiveAiSafetyPlan" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LiveAiSafetyRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LiveAiSafetyRun" FORCE ROW LEVEL SECURITY;

CREATE POLICY targetdomainverification_rls_strict ON "TargetDomainVerification"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
CREATE POLICY liveaisafetysettings_rls_strict ON "LiveAiSafetySettings"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
CREATE POLICY liveaisafetyplan_rls_strict ON "LiveAiSafetyPlan"
  FOR ALL USING (
    "workspaceId" = app.current_workspace_id()
    AND EXISTS (SELECT 1 FROM "Target" WHERE id = "targetId" AND "workspaceId" = app.current_workspace_id())
    AND EXISTS (SELECT 1 FROM "TargetDomainVerification" WHERE id = "domainVerificationId" AND "workspaceId" = app.current_workspace_id())
  )
  WITH CHECK (
    "workspaceId" = app.current_workspace_id()
    AND EXISTS (SELECT 1 FROM "Target" WHERE id = "targetId" AND "workspaceId" = app.current_workspace_id())
    AND EXISTS (SELECT 1 FROM "TargetDomainVerification" WHERE id = "domainVerificationId" AND "workspaceId" = app.current_workspace_id())
  );
CREATE POLICY liveaisafetyrun_rls_strict ON "LiveAiSafetyRun"
  FOR ALL USING (
    "workspaceId" = app.current_workspace_id()
    AND EXISTS (SELECT 1 FROM "LiveAiSafetyPlan" WHERE id = "planId" AND "workspaceId" = app.current_workspace_id() AND "targetId" = "LiveAiSafetyRun"."targetId")
  )
  WITH CHECK (
    "workspaceId" = app.current_workspace_id()
    AND EXISTS (SELECT 1 FROM "LiveAiSafetyPlan" WHERE id = "planId" AND "workspaceId" = app.current_workspace_id() AND "targetId" = "LiveAiSafetyRun"."targetId")
  );
