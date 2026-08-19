-- Track C: Affiliate / referral-revenue domain.
-- All monetary amounts use DECIMAL(19,4) — never FLOAT.
-- All ids use TEXT with application-level cuid() defaults.
-- ReferralCode/ReferralAttribution (waitlist ladder) remain separate.

CREATE TYPE "AffiliateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'AVAILABLE', 'RESERVED', 'PAID', 'REVERSED', 'EXPIRED');
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELED');

CREATE TABLE "Affiliate" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "AffiliateStatus" NOT NULL DEFAULT 'PENDING',
  "promoCode" TEXT,
  "baseRateBps" INTEGER NOT NULL DEFAULT 2500,
  "tierRateBps" INTEGER NOT NULL DEFAULT 3000,
  "tierThreshold" INTEGER NOT NULL DEFAULT 10,
  "activeReferrals" INTEGER NOT NULL DEFAULT 0,
  "reservePct" INTEGER NOT NULL DEFAULT 25,
  "reserveUntil" TIMESTAMP(3),
  "payoutMethod" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt" TIMESTAMP(3),
  CONSTRAINT "Affiliate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AffiliateProgram" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL DEFAULT 'default',
  "attributionWindowDays" INTEGER NOT NULL DEFAULT 60,
  "holdDays" INTEGER NOT NULL DEFAULT 30,
  "capMonths" INTEGER NOT NULL DEFAULT 12,
  "baseRateBps" INTEGER NOT NULL DEFAULT 2500,
  "tierRateBps" INTEGER NOT NULL DEFAULT 3000,
  "tierThreshold" INTEGER NOT NULL DEFAULT 10,
  "reservePct" INTEGER NOT NULL DEFAULT 25,
  "reserveDays" INTEGER NOT NULL DEFAULT 90,
  "minPayout" DECIMAL(19,4) NOT NULL DEFAULT 100,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AffiliateProgram_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AffiliateLink" (
  "id" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "campaign" TEXT,
  "subid" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AffiliateLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Click" (
  "id" TEXT NOT NULL,
  "linkId" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "visitorId" TEXT,
  "landingUrl" TEXT,
  "referrer" TEXT,
  "ipHash" TEXT,
  "userAgent" TEXT,
  "subid" TEXT,
  "utm" JSONB,
  "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Click_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttributionToken" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "clickId" TEXT NOT NULL,
  "linkId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AttributionToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AffiliateSubscription" (
  "id" TEXT NOT NULL,
  "providerSubscriptionId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "firstPaidAt" TIMESTAMP(3) NOT NULL,
  "capEndsAt" TIMESTAMP(3) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "AffiliateSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Conversion" (
  "id" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "affiliateId" TEXT NOT NULL,
  "grossAmount" DECIMAL(19,4) NOT NULL,
  "commissionableAmount" DECIMAL(19,4) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "method" TEXT NOT NULL,
  "promoCode" TEXT,
  "subid" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Commission" (
  "id" TEXT NOT NULL,
  "conversionId" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "rateBps" INTEGER NOT NULL,
  "amount" DECIMAL(19,4) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
  "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "availableAt" TIMESTAMP(3),
  "reversalOfId" TEXT,
  CONSTRAINT "Commission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Payout" (
  "id" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "amount" DECIMAL(19,4) NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "provider" TEXT,
  "providerPayoutId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  "failureCode" TEXT,
  CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayoutItem" (
  "id" TEXT NOT NULL,
  "payoutId" TEXT NOT NULL,
  "commissionId" TEXT NOT NULL,
  "amount" DECIMAL(19,4) NOT NULL,
  CONSTRAINT "PayoutItem_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "Affiliate_userId_key" ON "Affiliate"("userId");
CREATE UNIQUE INDEX "Affiliate_promoCode_key" ON "Affiliate"("promoCode");
CREATE UNIQUE INDEX "AffiliateProgram_slug_key" ON "AffiliateProgram"("slug");
CREATE UNIQUE INDEX "AffiliateLink_code_key" ON "AffiliateLink"("code");
CREATE UNIQUE INDEX "AttributionToken_tokenHash_key" ON "AttributionToken"("tokenHash");
CREATE INDEX "AttributionToken_linkId_idx" ON "AttributionToken"("linkId");
CREATE UNIQUE INDEX "AffiliateSubscription_providerSubscriptionId_key" ON "AffiliateSubscription"("providerSubscriptionId");
CREATE UNIQUE INDEX "Conversion_idempotencyKey_key" ON "Conversion"("idempotencyKey");
CREATE UNIQUE INDEX "Conversion_externalId_affiliateId_key" ON "Conversion"("externalId", "affiliateId");
CREATE UNIQUE INDEX "Commission_conversionId_affiliateId_key" ON "Commission"("conversionId", "affiliateId");
CREATE UNIQUE INDEX "Payout_providerPayoutId_key" ON "Payout"("providerPayoutId");
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");
CREATE UNIQUE INDEX "PayoutItem_commissionId_key" ON "PayoutItem"("commissionId");

-- Indexes
CREATE INDEX "AffiliateLink_affiliateId_idx" ON "AffiliateLink"("affiliateId");
CREATE INDEX "Click_affiliateId_clickedAt_idx" ON "Click"("affiliateId", "clickedAt");
CREATE INDEX "Click_visitorId_clickedAt_idx" ON "Click"("visitorId", "clickedAt");
CREATE INDEX "Conversion_affiliateId_occurredAt_idx" ON "Conversion"("affiliateId", "occurredAt");
CREATE INDEX "Commission_affiliateId_status_availableAt_idx" ON "Commission"("affiliateId", "status", "availableAt");

-- Foreign keys
ALTER TABLE "Affiliate" ADD CONSTRAINT "Affiliate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AffiliateLink" ADD CONSTRAINT "AffiliateLink_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Click" ADD CONSTRAINT "Click_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "AffiliateLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Click" ADD CONSTRAINT "Click_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttributionToken" ADD CONSTRAINT "AttributionToken_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttributionToken" ADD CONSTRAINT "AttributionToken_clickId_fkey" FOREIGN KEY ("clickId") REFERENCES "Click"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttributionToken" ADD CONSTRAINT "AttributionToken_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "AffiliateLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AffiliateSubscription" ADD CONSTRAINT "AffiliateSubscription_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "AffiliateSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "Conversion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayoutItem" ADD CONSTRAINT "PayoutItem_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayoutItem" ADD CONSTRAINT "PayoutItem_commissionId_fkey" FOREIGN KEY ("commissionId") REFERENCES "Commission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: Affiliate-domain tables are user/affiliate-scoped, NOT workspace-scoped.
-- They do not carry workspaceId and are not gated by app.current_workspace_id().
-- Access control is enforced at the application layer via userId on Affiliate.
