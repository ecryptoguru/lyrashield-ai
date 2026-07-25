-- Covers the active-scan poll, the most frequent automated query in the app:
--   WHERE "workspaceId" = $1 AND status IN (...) AND "deletedAt" IS NULL
--   ORDER BY "createdAt" DESC
-- The existing single-column indexes force the planner to filter status from a
-- workspace scan (or vice versa); this compound index serves the whole predicate
-- and its ordering.
--
-- CONCURRENTLY is intentionally NOT used: Prisma Migrate runs each migration in
-- a transaction, and CREATE INDEX CONCURRENTLY cannot run inside one. If this is
-- applied to a large production Scan table where the brief write lock matters,
-- create it out-of-band with CONCURRENTLY first and then mark this migration as
-- applied (`prisma migrate resolve --applied`).

CREATE INDEX "Scan_workspaceId_status_createdAt_idx"
ON "Scan"("workspaceId", "status", "createdAt");
