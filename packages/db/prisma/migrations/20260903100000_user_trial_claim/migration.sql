ALTER TABLE "users" ADD COLUMN "trialStartedAt" TIMESTAMP(3);

-- Conservatively retain existing trial use for all historical memberships.
UPDATE "users" AS u
SET "trialStartedAt" = existing."startedAt"
FROM (
  SELECT m."userId", MIN(w."trialStartedAt") AS "startedAt"
  FROM "WorkspaceMember" m
  JOIN "Workspace" w ON w.id = m."workspaceId"
  WHERE w."trialStartedAt" IS NOT NULL
  GROUP BY m."userId"
) existing
WHERE u.id = existing."userId";
