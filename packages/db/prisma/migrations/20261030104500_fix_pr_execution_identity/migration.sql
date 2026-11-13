-- Nullable additive metadata preserves existing PR/merge history.
ALTER TABLE "PullRequest"
  ADD COLUMN "executionKey" TEXT,
  ADD COLUMN "baseCommit" TEXT,
  ADD COLUMN "diffChecksum" TEXT,
  ADD COLUMN "approvalId" TEXT,
  ADD COLUMN "requestedById" TEXT,
  ADD COLUMN "credentialActor" JSONB;
CREATE UNIQUE INDEX "PullRequest_executionKey_key" ON "PullRequest"("executionKey");
