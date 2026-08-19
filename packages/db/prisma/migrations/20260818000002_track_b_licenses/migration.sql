-- Track B: Local/self-hosted licensing models (License, LicenseActivation,
-- LicenseKey, SyncCursor, LicenseRevocation).

CREATE TABLE "License" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT,
  "ownerEmail" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "seatCount" INTEGER NOT NULL,
  "machineIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "updateEligibleUntil" TIMESTAMP(3) NOT NULL,
  "perpetualFallbackBuild" TEXT,
  "signingKeyId" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "revoked" BOOLEAN NOT NULL DEFAULT false,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LicenseActivation" (
  "id" TEXT NOT NULL,
  "licenseId" TEXT NOT NULL,
  "workspaceId" TEXT,
  "machineId" TEXT NOT NULL,
  "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "deactivatedAt" TIMESTAMP(3),
  CONSTRAINT "LicenseActivation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LicenseKey" (
  "id" TEXT NOT NULL,
  "licenseId" TEXT NOT NULL,
  "workspaceId" TEXT,
  "keyHash" TEXT NOT NULL,
  "issuedByProvider" TEXT NOT NULL,
  "providerProductId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LicenseKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncCursor" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "licenseId" TEXT NOT NULL,
  "lastSyncedAt" TIMESTAMP(3) NOT NULL,
  "lastSyncedFindingId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SyncCursor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LicenseRevocation" (
  "id" TEXT NOT NULL,
  "licenseId" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "revokedByKeyId" TEXT NOT NULL,
  CONSTRAINT "LicenseRevocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "License_ownerEmail_idx" ON "License"("ownerEmail");
CREATE INDEX "License_workspaceId_idx" ON "License"("workspaceId");
CREATE UNIQUE INDEX "LicenseActivation_licenseId_machineId_key" ON "LicenseActivation"("licenseId", "machineId");
CREATE INDEX "LicenseActivation_workspaceId_idx" ON "LicenseActivation"("workspaceId");
CREATE UNIQUE INDEX "LicenseKey_licenseId_key" ON "LicenseKey"("licenseId");
CREATE UNIQUE INDEX "LicenseKey_keyHash_key" ON "LicenseKey"("keyHash");
CREATE INDEX "LicenseKey_workspaceId_idx" ON "LicenseKey"("workspaceId");
CREATE UNIQUE INDEX "SyncCursor_workspaceId_licenseId_key" ON "SyncCursor"("workspaceId", "licenseId");
CREATE UNIQUE INDEX "LicenseRevocation_licenseId_key" ON "LicenseRevocation"("licenseId");

ALTER TABLE "License" ADD CONSTRAINT "License_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LicenseActivation" ADD CONSTRAINT "LicenseActivation_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseActivation" ADD CONSTRAINT "LicenseActivation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LicenseKey" ADD CONSTRAINT "LicenseKey_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseKey" ADD CONSTRAINT "LicenseKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SyncCursor" ADD CONSTRAINT "SyncCursor_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncCursor" ADD CONSTRAINT "SyncCursor_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseRevocation" ADD CONSTRAINT "LicenseRevocation_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: License and LicenseActivation/LicenseKey have nullable workspaceId
-- (may be issued outside a workspace). SyncCursor is workspace-scoped.
-- LicenseRevocation is scoped via its License parent FK.
ALTER TABLE "License" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "License" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LicenseActivation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LicenseActivation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LicenseKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LicenseKey" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SyncCursor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncCursor" FORCE ROW LEVEL SECURITY;

CREATE POLICY license_rls_strict ON "License"
  FOR ALL USING ("workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id());

CREATE POLICY licenseactivation_rls_strict ON "LicenseActivation"
  FOR ALL USING ("workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id());

CREATE POLICY licensekey_rls_strict ON "LicenseKey"
  FOR ALL USING ("workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id());

CREATE POLICY synccursor_rls_strict ON "SyncCursor"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
