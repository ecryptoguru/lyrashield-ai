-- AlterTable: Add cost/determinism/SARIF fields to Scan
ALTER TABLE "Scan" ADD COLUMN "estimatedCostCents" INTEGER;
ALTER TABLE "Scan" ADD COLUMN "actualCostCents" INTEGER;
ALTER TABLE "Scan" ADD COLUMN "determinismMode" TEXT DEFAULT 'default';
ALTER TABLE "Scan" ADD COLUMN "sarifUri" TEXT;

-- AlterTable: Add dual CVSS + SARIF rule ID fields to Finding
ALTER TABLE "Finding" ADD COLUMN "cvssScore" DOUBLE PRECISION;
ALTER TABLE "Finding" ADD COLUMN "cvssVector" TEXT;
ALTER TABLE "Finding" ADD COLUMN "cvss3Score" DOUBLE PRECISION;
ALTER TABLE "Finding" ADD COLUMN "cvss3Vector" TEXT;
ALTER TABLE "Finding" ADD COLUMN "sarifRuleId" TEXT;

-- AlterTable: Add hash field to AuditLog for hash-chain integrity
ALTER TABLE "AuditLog" ADD COLUMN "hash" TEXT;
