-- One bounded latest denial; historical scan/evidence rows are untouched.
ALTER TABLE "Schedule"
  ADD COLUMN "lastScanId" TEXT,
  ADD COLUMN "lastBlockedAt" TIMESTAMP(3),
  ADD COLUMN "lastBlockedReason" VARCHAR(64);
