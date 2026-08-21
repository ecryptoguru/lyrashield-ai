-- Commit 7: make paid fulfillment idempotent and recoverable
-- Partial unique index on LicenseKey(issuedByProvider) + fulfillment / retrieval token columns

-- Add fulfillment lifecycle columns
ALTER TABLE "LicenseKey" ADD COLUMN "fulfillmentStatus" TEXT NOT NULL DEFAULT 'DELIVERED';
ALTER TABLE "LicenseKey" ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LicenseKey" ADD COLUMN "lastDeliveryError" TEXT;
-- One-time retrieval token (hashed, single-use, expiring)
ALTER TABLE "LicenseKey" ADD COLUMN "retrievalTokenHash" TEXT;
ALTER TABLE "LicenseKey" ADD COLUMN "retrievalTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "LicenseKey" ADD COLUMN "retrievalTokenUsedAt" TIMESTAMP(3);
ALTER TABLE "LicenseKey" ADD COLUMN "retrievalRawKey" TEXT;

-- Partial unique index: only non-NULL issuedByProvider values are unique (raw SQL per spec)
CREATE UNIQUE INDEX "LicenseKey_issuedByProvider_key" ON "LicenseKey"("issuedByProvider") WHERE "issuedByProvider" IS NOT NULL;

-- Partial unique for retrieval token hash (only non-NULL values unique)
CREATE UNIQUE INDEX "LicenseKey_retrievalTokenHash_key" ON "LicenseKey"("retrievalTokenHash") WHERE "retrievalTokenHash" IS NOT NULL;
