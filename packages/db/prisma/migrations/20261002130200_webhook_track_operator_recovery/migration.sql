ALTER TABLE "WebhookEventTrack"
  ADD COLUMN "historicalAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "operatorRecoveryCount" INTEGER NOT NULL DEFAULT 0;
