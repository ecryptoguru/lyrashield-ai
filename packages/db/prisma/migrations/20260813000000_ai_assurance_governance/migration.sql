-- Release A: AI assurance governance operational evidence vault
--
-- Adds the root and child tables for the AI assurance workflow:
--   - AiSystemProfile (release B concept, schema only in A)
--   - ThreatModel / ThreatModelVersion (release B concept, schema only in A)
--   - ControlEvidence / ControlEvidenceVersion (Release A evidence vault)
--
-- All workspace-scoped root tables carry a direct workspaceId and use the
-- app.current_workspace_id() transaction context. Child version tables are
-- scoped through their parent root table via EXISTS-join RLS policies.

CREATE TABLE "AiSystemProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "profile" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSystemProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ThreatModel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThreatModel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ThreatModelVersion" (
    "id" TEXT NOT NULL,
    "threatModelId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreatModelVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ControlEvidence" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "controlId" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ControlEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ControlEvidenceVersion" (
    "id" TEXT NOT NULL,
    "controlEvidenceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "attestation" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "artifactManifest" JSONB NOT NULL DEFAULT '[]',
    "checksum" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ControlEvidenceVersion_pkey" PRIMARY KEY ("id")
);

-- Unique constraints / indexes
CREATE UNIQUE INDEX "AiSystemProfile_targetId_key" ON "AiSystemProfile"("targetId");
CREATE INDEX "AiSystemProfile_workspaceId_updatedAt_idx" ON "AiSystemProfile"("workspaceId", "updatedAt");

CREATE UNIQUE INDEX "ThreatModel_currentVersionId_key" ON "ThreatModel"("currentVersionId");
CREATE UNIQUE INDEX "ThreatModel_workspaceId_targetId_key" ON "ThreatModel"("workspaceId", "targetId");

CREATE UNIQUE INDEX "ThreatModelVersion_threatModelId_version_key" ON "ThreatModelVersion"("threatModelId", "version");

CREATE UNIQUE INDEX "ControlEvidence_currentVersionId_key" ON "ControlEvidence"("currentVersionId");
CREATE UNIQUE INDEX "ControlEvidence_workspaceId_targetId_controlId_key" ON "ControlEvidence"("workspaceId", "targetId", "controlId");

CREATE UNIQUE INDEX "ControlEvidenceVersion_controlEvidenceId_version_key" ON "ControlEvidenceVersion"("controlEvidenceId", "version");
CREATE INDEX "ControlEvidenceVersion_status_expiresAt_idx" ON "ControlEvidenceVersion"("status", "expiresAt");

-- Foreign keys
ALTER TABLE "AiSystemProfile" ADD CONSTRAINT "AiSystemProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiSystemProfile" ADD CONSTRAINT "AiSystemProfile_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ThreatModel" ADD CONSTRAINT "ThreatModel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThreatModel" ADD CONSTRAINT "ThreatModel_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThreatModel" ADD CONSTRAINT "ThreatModel_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ThreatModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ThreatModelVersion" ADD CONSTRAINT "ThreatModelVersion_threatModelId_fkey" FOREIGN KEY ("threatModelId") REFERENCES "ThreatModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ControlEvidence" ADD CONSTRAINT "ControlEvidence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ControlEvidence" ADD CONSTRAINT "ControlEvidence_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ControlEvidence" ADD CONSTRAINT "ControlEvidence_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ControlEvidenceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ControlEvidenceVersion" ADD CONSTRAINT "ControlEvidenceVersion_controlEvidenceId_fkey" FOREIGN KEY ("controlEvidenceId") REFERENCES "ControlEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security
ALTER TABLE "AiSystemProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiSystemProfile" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ThreatModel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ThreatModel" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ThreatModelVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ThreatModelVersion" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ControlEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlEvidence" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ControlEvidenceVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlEvidenceVersion" FORCE ROW LEVEL SECURITY;

-- Strict workspace-scoped policies. No permissive fallback: the application now
-- sets app.current_workspace_id on every workspace-scoped operation, and the
-- Prisma extension / withWorkspaceRLS transactions rely on these policies.
CREATE POLICY aisystemprofile_rls_strict ON "AiSystemProfile"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY threatmodel_rls_strict ON "ThreatModel"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY threatmodelversion_rls_strict ON "ThreatModelVersion"
  FOR ALL USING (
    EXISTS (
      SELECT 1
      FROM "ThreatModel"
      WHERE "id" = "threatModelId"
        AND "workspaceId" = app.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM "ThreatModel"
      WHERE "id" = "threatModelId"
        AND "workspaceId" = app.current_workspace_id()
    )
  );

CREATE POLICY controlevidence_rls_strict ON "ControlEvidence"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY controlevidenceversion_rls_strict ON "ControlEvidenceVersion"
  FOR ALL USING (
    EXISTS (
      SELECT 1
      FROM "ControlEvidence"
      WHERE "id" = "controlEvidenceId"
        AND "workspaceId" = app.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM "ControlEvidence"
      WHERE "id" = "controlEvidenceId"
        AND "workspaceId" = app.current_workspace_id()
    )
  );
