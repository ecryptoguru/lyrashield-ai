-- Support workspace-scoped score history queries that do not require targetId.
-- The compound index on (workspaceId, targetId, computedAt) covers filtered
-- time-range lookups that join both dimensions (e.g. score trend per target).

CREATE INDEX "ScoreSnapshot_workspaceId_computedAt_idx"
ON "ScoreSnapshot"("workspaceId", "computedAt");

CREATE INDEX "ScoreSnapshot_workspaceId_targetId_computedAt_idx"
ON "ScoreSnapshot"("workspaceId", "targetId", "computedAt");
