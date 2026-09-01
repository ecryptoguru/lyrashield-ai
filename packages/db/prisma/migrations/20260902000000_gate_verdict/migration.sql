-- WP2 Launch Gate: append-only verdict storage. One immutable row per
-- (target, standardVersion, evaluation). Re-evaluation inserts a new row; the
-- latest non-stale row is the current verdict, and history is the audit trail.
-- Additive only: a new table + indexes + FKs, no changes to existing tables.
CREATE TABLE "GateVerdict" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "scanId" TEXT,
  "standardVersion" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "coverageStatement" JSONB NOT NULL,
  "nonCoverage" JSONB NOT NULL,
  "blockingReasons" JSONB NOT NULL,
  "evidenceSummary" JSONB NOT NULL,
  "staleness" JSONB NOT NULL,
  "inputChecksum" TEXT NOT NULL,
  "verdictChecksum" TEXT NOT NULL,
  "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GateVerdict_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GateVerdict_workspaceId_idx" ON "GateVerdict"("workspaceId");
CREATE INDEX "GateVerdict_targetId_evaluatedAt_idx" ON "GateVerdict"("targetId", "evaluatedAt");
CREATE INDEX "GateVerdict_workspaceId_targetId_evaluatedAt_idx" ON "GateVerdict"("workspaceId", "targetId", "evaluatedAt");
ALTER TABLE "GateVerdict" ADD CONSTRAINT "GateVerdict_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GateVerdict" ADD CONSTRAINT "GateVerdict_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GateVerdict" ADD CONSTRAINT "GateVerdict_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
