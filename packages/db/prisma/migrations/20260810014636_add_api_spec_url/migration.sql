-- AlterTable
ALTER TABLE "Target" ADD COLUMN     "apiSpecUrl" TEXT;

-- Disable legacy scheduled URL Standard/Deep scans until the new execution contract is reviewed.
UPDATE "Schedule" AS schedule
SET "enabled" = FALSE,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE schedule."enabled" = TRUE
  AND schedule."mode" IN ('STANDARD', 'DEEP')
  AND EXISTS (
    SELECT 1
    FROM "Target" AS target
    WHERE target."id" = schedule."targetId"
      AND target."type" IN ('WEB_APP', 'API')
  );
