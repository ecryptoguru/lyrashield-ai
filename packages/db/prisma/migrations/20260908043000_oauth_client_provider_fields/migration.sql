-- Better Auth OAuth Provider 1.7 persists these fields during dynamic client
-- registration. Keep legacy columns for compatibility with the previous app.
ALTER TABLE "oauth_clients"
  ADD COLUMN "clientDiscoveryId" TEXT,
  ADD COLUMN "clientCredentialsScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "applicationType" TEXT;
