-- UX V2 Phase 3/4/8 schema additions.
-- These are the only database changes permitted by the v2 build spec:
--   * Scan.durationMs for run timing and progress estimates
--   * Project.trustPlan for per-product policy/customisation storage
--   * notification_preferences table for in-app and email notification settings

-- Add Scan.durationMs to record actual run duration in milliseconds.
ALTER TABLE "Scan" ADD COLUMN IF NOT EXISTS "durationMs" INTEGER;

-- Add Project.trustPlan as a nullable JSONB object for product-specific policy.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "trustPlan" JSONB;

-- Notification preferences per user (Phase 8). Push columns are deferred.
CREATE TABLE IF NOT EXISTS "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailDigest" BOOLEAN NOT NULL DEFAULT true,
    "emailInstant" BOOLEAN NOT NULL DEFAULT true,
    "inAppInstant" BOOLEAN NOT NULL DEFAULT true,
    "inAppDigest" BOOLEAN NOT NULL DEFAULT true,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursStart" INTEGER,
    "quietHoursEnd" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_userId_key" ON "notification_preferences"("userId");
CREATE INDEX IF NOT EXISTS "notification_preferences_userId_idx" ON "notification_preferences"("userId");
