-- New tracks receive their initial due time from PostgreSQL. Existing NULL
-- values remain NULL so historical claims still require receipt review.
ALTER TABLE "WebhookEventTrack"
  ALTER COLUMN "nextAttemptAt" SET DEFAULT CURRENT_TIMESTAMP;
