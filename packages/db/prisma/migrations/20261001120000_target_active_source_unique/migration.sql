-- Refine source identity uniqueness to active targets only. The previous
-- non-partial indexes already guaranteed that active rows were unique, so this
-- changes no target rows and does not rewrite historical target data.
-- Keep the replacement atomic so active uniqueness is never unenforced.
BEGIN;

DROP INDEX "Target_workspaceId_repoFullName_key";
DROP INDEX "Target_workspaceId_url_key";

CREATE UNIQUE INDEX "Target_workspaceId_repoFullName_key"
  ON "Target"("workspaceId", "repoFullName")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "Target_workspaceId_url_key"
  ON "Target"("workspaceId", "url")
  WHERE "deletedAt" IS NULL;

COMMIT;
