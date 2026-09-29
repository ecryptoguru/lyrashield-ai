-- Additive retry ownership. Historical rows deliberately retain NULL due dates;
-- operators must inspect domain receipts before authorizing their recovery.
ALTER TABLE "WebhookEventTrack"
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
CREATE INDEX "WebhookEventTrack_status_nextAttemptAt_idx"
  ON "WebhookEventTrack" ("status", "nextAttemptAt");
ALTER TABLE "WebhookEventTrack" ADD CONSTRAINT "WebhookEventTrack_generation_nonnegative"
  CHECK ("generation" >= 0);
