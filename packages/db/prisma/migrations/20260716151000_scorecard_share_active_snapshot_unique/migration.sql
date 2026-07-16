WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "snapshotId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS row_number
  FROM "ScorecardShare"
  WHERE "revokedAt" IS NULL
)
UPDATE "ScorecardShare" AS share
SET "revokedAt" = CURRENT_TIMESTAMP
FROM ranked
WHERE share."id" = ranked."id"
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX "ScorecardShare_snapshotId_active_key"
ON "ScorecardShare"("snapshotId")
WHERE "revokedAt" IS NULL;
