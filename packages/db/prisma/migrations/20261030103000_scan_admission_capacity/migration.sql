ALTER TABLE "Scan" ADD COLUMN "accountingVersion" INTEGER;
CREATE TABLE "UserScanSlot" (
 "userId" TEXT PRIMARY KEY, "scanId" TEXT NOT NULL UNIQUE,
 "workspaceId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "ScanCapacityReservation" (
 "scanId" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL,
 "userId" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'WAITING',
 "accountingVersion" INTEGER NOT NULL DEFAULT 2, "multiplier" INTEGER NOT NULL,
 "cycleStart" TIMESTAMP(3), "billingAccountId" TEXT,
 "poolMinutes" INTEGER NOT NULL DEFAULT 0, "packMinutes" INTEGER NOT NULL DEFAULT 0,
 "packAllocations" JSONB NOT NULL DEFAULT '[]', "graceMinutes" INTEGER NOT NULL DEFAULT 0,
 "overageMinutes" INTEGER NOT NULL DEFAULT 0, "fundedMinutes" INTEGER NOT NULL DEFAULT 0,
 "runtimeLimitMs" INTEGER NOT NULL DEFAULT 0, "observedMs" INTEGER NOT NULL DEFAULT 0,
 "chargedMinutes" INTEGER NOT NULL DEFAULT 0, "absorbedMinutes" INTEGER NOT NULL DEFAULT 0,
 "stoppedAt" TIMESTAMP(3), "settledAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ScanCapacityReservation_state_check" CHECK ("state" IN ('WAITING','RESERVED','RUNNING','SETTLED','RELEASED','REVIEW_REQUIRED')),
 CONSTRAINT "ScanCapacityReservation_funding_check" CHECK (
   "multiplier" IN (1,3) AND "accountingVersion" = 2 AND "poolMinutes" >= 0 AND "packMinutes" >= 0
   AND "graceMinutes" >= 0 AND "overageMinutes" >= 0 AND "runtimeLimitMs" >= 0
   AND "observedMs" >= 0 AND "chargedMinutes" >= 0 AND "absorbedMinutes" >= 0
   AND "fundedMinutes" = "poolMinutes" + "packMinutes" + "graceMinutes" + "overageMinutes"
   AND ("graceMinutes" = 0 OR "overageMinutes" = 0) AND "chargedMinutes" <= "fundedMinutes")
);
CREATE INDEX "ScanCapacityReservation_accountId_state_createdAt_scanId_idx" ON "ScanCapacityReservation"("accountId","state","createdAt","scanId");
-- Only live admission is seeded; historical financial/evidence rows are untouched.
-- Multiple legacy active scans conservatively retain the first slot until an operator
-- reconciles the legacy drain. No timer may release this slot.
INSERT INTO "UserScanSlot"("userId","scanId","workspaceId")
 SELECT DISTINCT ON ("createdById") "createdById", "id", "workspaceId" FROM "Scan"
 WHERE "status" IN ('QUEUED','PREFLIGHT','RUNNING','VERIFYING','REQUIRES_APPROVAL')
 ORDER BY "createdById", "createdAt", "id";
ALTER TABLE "UserScanSlot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserScanSlot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_scan_slot_owner" ON "UserScanSlot" USING
 ("userId" = NULLIF(current_setting('app.current_scan_user_id', true), '')) WITH CHECK
 ("userId" = NULLIF(current_setting('app.current_scan_user_id', true), ''));
ALTER TABLE "ScanCapacityReservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanCapacityReservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "scan_capacity_account_owner" ON "ScanCapacityReservation" USING
 ("accountId" = NULLIF(current_setting('app.current_account_id', true), '')) WITH CHECK
 ("accountId" = NULLIF(current_setting('app.current_account_id', true), ''));
