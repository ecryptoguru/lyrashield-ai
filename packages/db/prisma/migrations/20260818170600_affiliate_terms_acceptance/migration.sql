-- Affiliate terms acceptance: record when an affiliate accepted the program
-- terms and which version they accepted. Approval is gated on acceptedTermsAt
-- being set, so an affiliate cannot be approved without having accepted the
-- binding program terms (FTC/ASA disclosure, no-FUD, no "only-we"/benchmark
-- claims, no brand bidding).
ALTER TABLE "Affiliate" ADD COLUMN "acceptedTermsAt" TIMESTAMP(3);
ALTER TABLE "Affiliate" ADD COLUMN "termsVersion" TEXT;
