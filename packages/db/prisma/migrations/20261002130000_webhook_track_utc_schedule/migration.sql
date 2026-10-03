-- Add explicit UTC scheduling columns while retaining the prior local-wall-time
-- columns for rollback compatibility during the worker cutover.
ALTER TABLE "WebhookEventTrack"
  ADD COLUMN "nextAttemptAtUtc" TIMESTAMPTZ(3),
  ADD COLUMN "leaseExpiresAtUtc" TIMESTAMPTZ(3);

-- Legacy TIMESTAMP values are interpreted as UTC wall times, as required by
-- the webhook-track receipt contract. NULL historical due times remain NULL
-- and therefore continue to require explicit operator review.
UPDATE "WebhookEventTrack"
SET "nextAttemptAtUtc" = "nextAttemptAt" AT TIME ZONE 'UTC',
    "leaseExpiresAtUtc" = "leaseExpiresAt" AT TIME ZONE 'UTC';

ALTER TABLE "WebhookEventTrack"
  ALTER COLUMN "nextAttemptAtUtc" SET DEFAULT CURRENT_TIMESTAMP;
