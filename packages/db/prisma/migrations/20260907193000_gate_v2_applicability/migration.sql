-- Gate v2 applicability and finding disposition metadata. Additive only: v1
-- verdict bytes and checksums remain untouched and readable as history.
ALTER TABLE "Finding"
  ADD COLUMN "disposition" TEXT,
  ADD COLUMN "dispositionActorUserId" TEXT,
  ADD COLUMN "dispositionReason" TEXT,
  ADD COLUMN "dispositionAssessmentId" TEXT,
  ADD COLUMN "dispositionAt" TIMESTAMP(3),
  ADD COLUMN "canonicalFindingId" TEXT;

ALTER TABLE "Finding"
  ADD CONSTRAINT "Finding_canonicalFindingId_fkey"
  FOREIGN KEY ("canonicalFindingId") REFERENCES "Finding"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Finding_workspaceId_targetId_canonicalFindingId_idx"
  ON "Finding"("workspaceId", "targetId", "canonicalFindingId");

ALTER TABLE "GateVerdict"
  ADD COLUMN "assessmentVersion" INTEGER,
  ADD COLUMN "assessmentSnapshot" JSONB;
