-- Durable loop-closure state for merged fix PRs (item 1.2). Additive only.
--
-- GitHub documents that it never redelivers a failed delivery automatically,
-- so the previous "clear the marker and rethrow" strategy silently lost the
-- retest whenever the closure hit the scan concurrency cap, an unavailable
-- worker, or an entitlement failure. This table persists the deferred closure
-- so a worker sweep can retry it with backoff into a terminal, visible state.

-- CreateTable
CREATE TABLE "loop_closures" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "prNumber" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastReason" TEXT,
    "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loop_closures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loop_closures_workspaceId_branchName_key" ON "loop_closures"("workspaceId", "branchName");
CREATE INDEX "loop_closures_status_nextRetryAt_idx" ON "loop_closures"("status", "nextRetryAt");

-- AddForeignKey
ALTER TABLE "loop_closures" ADD CONSTRAINT "loop_closures_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: fail closed like every other workspace-scoped table.
ALTER TABLE "loop_closures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "loop_closures" FORCE ROW LEVEL SECURITY;

CREATE POLICY loop_closures_rls_strict ON "loop_closures"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
