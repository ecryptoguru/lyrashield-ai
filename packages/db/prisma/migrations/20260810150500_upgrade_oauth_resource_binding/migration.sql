-- Better Auth OAuth provider resource binding and token replay metadata.
ALTER TABLE "jwks"
  ADD COLUMN "alg" TEXT,
  ADD COLUMN "crv" TEXT;

ALTER TABLE "oauth_clients"
  ADD COLUMN "backchannelLogoutUri" TEXT,
  ADD COLUMN "backchannelLogoutSessionRequired" BOOLEAN,
  ADD COLUMN "jwks" TEXT,
  ADD COLUMN "jwksUri" TEXT,
  ADD COLUMN "dpopBoundAccessTokens" BOOLEAN DEFAULT FALSE;

ALTER TABLE "oauth_refresh_tokens"
  ADD COLUMN "authorizationCodeId" TEXT,
  ADD COLUMN "resources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "requestedUserInfoClaims" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "rotatedAt" TIMESTAMP(3),
  ADD COLUMN "rotationReplayResponse" TEXT,
  ADD COLUMN "rotationReplayExpiresAt" TIMESTAMP(3),
  ADD COLUMN "confirmation" JSONB;

ALTER TABLE "oauth_access_tokens"
  ADD COLUMN "authorizationCodeId" TEXT,
  ADD COLUMN "resources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "requestedUserInfoClaims" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "revoked" TIMESTAMP(3),
  ADD COLUMN "confirmation" JSONB;

ALTER TABLE "oauth_consents"
  ADD COLUMN "resources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "requestedUserInfoClaims" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "oauth_resources" (
  "id" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "accessTokenTtl" INTEGER,
  "refreshTokenTtl" INTEGER,
  "signingAlgorithm" TEXT,
  "signingKeyId" TEXT,
  "allowedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "customClaims" JSONB,
  "dpopBoundAccessTokensRequired" BOOLEAN DEFAULT FALSE,
  "disabled" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3),
  "policyVersion" INTEGER DEFAULT 1,
  "metadata" JSONB,
  CONSTRAINT "oauth_resources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "oauth_client_resources" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3),
  CONSTRAINT "oauth_client_resources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "oauth_client_assertions" (
  "id" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "oauth_client_assertions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_resources_identifier_key" ON "oauth_resources"("identifier");
CREATE UNIQUE INDEX "oauth_client_resources_clientId_resourceId_key" ON "oauth_client_resources"("clientId", "resourceId");
CREATE INDEX "oauth_client_resources_clientId_idx" ON "oauth_client_resources"("clientId");
CREATE INDEX "oauth_client_resources_resourceId_idx" ON "oauth_client_resources"("resourceId");
CREATE INDEX "oauth_refresh_tokens_authorizationCodeId_idx" ON "oauth_refresh_tokens"("authorizationCodeId");
CREATE INDEX "oauth_access_tokens_authorizationCodeId_idx" ON "oauth_access_tokens"("authorizationCodeId");

ALTER TABLE "oauth_client_resources"
  ADD CONSTRAINT "oauth_client_resources_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "oauth_clients"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "oauth_client_resources"
  ADD CONSTRAINT "oauth_client_resources_resourceId_fkey"
  FOREIGN KEY ("resourceId") REFERENCES "oauth_resources"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;
