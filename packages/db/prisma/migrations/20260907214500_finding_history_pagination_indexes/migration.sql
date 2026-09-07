-- Bounded history pages sort by (createdAt, id) within one finding. The
-- previous single-column indexes required scanning and sorting the full
-- history at 100,000 rows.
CREATE INDEX "Evidence_findingId_createdAt_id_idx"
ON "Evidence"("findingId", "createdAt", "id");

CREATE INDEX "FindingVerification_findingId_createdAt_id_idx"
ON "FindingVerification"("findingId", "createdAt", "id");

CREATE INDEX "FixProposal_findingId_createdAt_id_idx"
ON "FixProposal"("findingId", "createdAt", "id");

CREATE INDEX "Retest_findingId_createdAt_id_idx"
ON "Retest"("findingId", "createdAt", "id");
