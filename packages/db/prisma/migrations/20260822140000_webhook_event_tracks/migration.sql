-- Additive: durable per-track webhook processing state (findings 12 / 18A).
-- One WebhookEventTrack row per applicable track ("billing" | "license" |
-- "affiliate") of a WebhookEvent. The parent `processed` flag becomes a
-- derived compatibility flag: true only when every applicable track row is
-- "succeeded". Legacy rows keep their existing semantics; they simply have no
-- track rows until reprocessed.

-- CreateTable
CREATE TABLE "WebhookEventTrack" (
    "id" TEXT NOT NULL,
    "webhookEventId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "track" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEventTrack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEventTrack_webhookEventId_track_key" ON "WebhookEventTrack"("webhookEventId" ASC, "track" ASC);

-- CreateIndex
CREATE INDEX "WebhookEventTrack_status_idx" ON "WebhookEventTrack"("status" ASC);

-- CreateIndex
CREATE INDEX "WebhookEventTrack_track_status_idx" ON "WebhookEventTrack"("track" ASC, "status" ASC);

-- AddForeignKey
ALTER TABLE "WebhookEventTrack" ADD CONSTRAINT "WebhookEventTrack_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
