-- One notification row already represents a deterministic delivery identity.
-- A short lease makes claiming that identity atomic across concurrent workers.
ALTER TABLE "Notification" ADD COLUMN "deliveryLeaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Notification_status_deliveryLeaseExpiresAt_idx"
  ON "Notification"("status", "deliveryLeaseExpiresAt");
