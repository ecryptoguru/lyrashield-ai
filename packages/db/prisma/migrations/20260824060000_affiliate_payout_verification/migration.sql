ALTER TABLE "Affiliate"
  ADD COLUMN "payoutMethodVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "payoutMethodVerifiedBy" TEXT,
  ADD COLUMN "taxFormType" TEXT,
  ADD COLUMN "taxFormStatus" TEXT NOT NULL DEFAULT 'NOT_SUBMITTED',
  ADD COLUMN "taxReviewedAt" TIMESTAMP(3),
  ADD COLUMN "taxReviewedBy" TEXT;

CREATE INDEX "Affiliate_taxFormStatus_idx" ON "Affiliate"("taxFormStatus");
