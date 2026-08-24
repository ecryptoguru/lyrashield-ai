ALTER TABLE "users"
ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "sessions"
ADD COLUMN "twoFactorVerifiedAt" TIMESTAMP(3);

CREATE TABLE "two_factors" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "two_factors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "two_factors_secret_idx" ON "two_factors"("secret");
CREATE INDEX "two_factors_userId_idx" ON "two_factors"("userId");

ALTER TABLE "two_factors"
ADD CONSTRAINT "two_factors_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PlatformAdminElevation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAdminElevation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformAdminAudit" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAdminAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformAdminChallengeLimit" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAdminChallengeLimit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformAdminElevation_nonceHash_key" ON "PlatformAdminElevation"("nonceHash");
CREATE INDEX "PlatformAdminElevation_userId_sessionId_action_expiresAt_idx" ON "PlatformAdminElevation"("userId", "sessionId", "action", "expiresAt");
CREATE INDEX "PlatformAdminElevation_expiresAt_idx" ON "PlatformAdminElevation"("expiresAt");
CREATE INDEX "PlatformAdminAudit_actorUserId_createdAt_idx" ON "PlatformAdminAudit"("actorUserId", "createdAt");
CREATE INDEX "PlatformAdminAudit_action_createdAt_idx" ON "PlatformAdminAudit"("action", "createdAt");
CREATE INDEX "PlatformAdminAudit_resourceType_resourceId_idx" ON "PlatformAdminAudit"("resourceType", "resourceId");
CREATE UNIQUE INDEX "sessions_id_userId_key" ON "sessions"("id", "userId");
CREATE UNIQUE INDEX "PlatformAdminChallengeLimit_scope_keyHash_key" ON "PlatformAdminChallengeLimit"("scope", "keyHash");
CREATE INDEX "PlatformAdminChallengeLimit_windowStartedAt_idx" ON "PlatformAdminChallengeLimit"("windowStartedAt");

ALTER TABLE "PlatformAdminElevation"
ADD CONSTRAINT "PlatformAdminElevation_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlatformAdminElevation"
ADD CONSTRAINT "PlatformAdminElevation_sessionId_userId_fkey"
FOREIGN KEY ("sessionId", "userId") REFERENCES "sessions"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Global authority state has no tenant policy. Ordinary runtime roles must not
-- reach it; the separately configured system connection is the only data path.
ALTER TABLE "PlatformAdminElevation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformAdminChallengeLimit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformAdminAudit" ENABLE ROW LEVEL SECURITY;

DO $platform_admin_lockdown$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime_prod') THEN
    REVOKE ALL PRIVILEGES ON TABLE "PlatformAdminElevation" FROM app_runtime_prod;
    REVOKE ALL PRIVILEGES ON TABLE "PlatformAdminChallengeLimit" FROM app_runtime_prod;
    REVOKE ALL PRIVILEGES ON TABLE "PlatformAdminAudit" FROM app_runtime_prod;
  END IF;
END
$platform_admin_lockdown$;
