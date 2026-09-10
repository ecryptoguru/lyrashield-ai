-- Target-scoped hot-path indexes. Additive only — no index is dropped.
--
-- Deep Review v16 2.1: three frequently-executed query shapes ran without a
-- covering composite index and degraded as workspaces accumulated history:
--
--   * Finding (workspaceId, targetId, severity, createdAt) — the
--     target-scoped findings list ordered by severity then recency
--     (finding-service listFindings).
--   * Scan (workspaceId, targetId, createdAt) — the target-scoped scan
--     history on the target detail page and the gate's
--     newer-assessment-attempt existence check.
--   * UsageRecord (workspaceId, kind) — trial minute grants and consumption
--     are summed per kind on every billing-surface read (getTrialState and
--     the balance reads).
--
-- All three match the @@index entries added to schema.prisma in the same
-- change. Rollback is a code revert: CREATE INDEX is additive and nothing
-- references these indexes by name.

-- CreateIndex
CREATE INDEX "Finding_workspaceId_targetId_severity_createdAt_idx" ON "Finding"("workspaceId", "targetId", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "Scan_workspaceId_targetId_createdAt_idx" ON "Scan"("workspaceId", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageRecord_workspaceId_kind_idx" ON "UsageRecord"("workspaceId", "kind");
