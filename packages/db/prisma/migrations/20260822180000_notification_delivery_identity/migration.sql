-- Notification delivery identity: fail-closed dedupe for worker notification fan-out.
-- Adds dedupeKey derived from event identity and enforces at most one row per (channel, dedupeKey).
-- Existing rows have no dedupeKey and remain distinct; new rows populate dedupeKey for new events.

ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "Notification_channel_dedupeKey_key" ON "Notification"("channel", "dedupeKey");
