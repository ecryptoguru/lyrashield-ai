ALTER TABLE "Scan" ADD COLUMN IF NOT EXISTS "accountingSettledAt" TIMESTAMP(3);
-- Protect capacity during a rolling deploy: legacy work must drain before its
-- sponsor admits new funded work. This writes lifecycle holds, never money,
-- historical manifests, usage receipts or accounting versions on legacy scans.
INSERT INTO "ScanCapacityReservation" (
 "scanId", "accountId", "workspaceId", "userId", "state", "multiplier", "updatedAt"
)
SELECT "id", COALESCE("sponsorAccountId", "createdById"), "workspaceId", "createdById",
 'REVIEW_REQUIRED', CASE WHEN "mode" IN ('DEEP','CUSTOM') THEN 3 ELSE 1 END, CURRENT_TIMESTAMP
FROM "Scan" WHERE "accountingVersion" IS NULL
 AND "status" IN ('QUEUED','PREFLIGHT','RUNNING','VERIFYING','REQUIRES_APPROVAL')
ON CONFLICT ("scanId") DO NOTHING;
