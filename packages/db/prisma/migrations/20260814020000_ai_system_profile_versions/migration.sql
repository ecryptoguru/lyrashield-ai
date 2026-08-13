ALTER TABLE "AiSystemProfile" ADD COLUMN "currentVersionId" TEXT;

CREATE TABLE "AiSystemProfileVersion" (
    "id" TEXT NOT NULL,
    "aiSystemProfileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "profile" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiSystemProfileVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiSystemProfile_currentVersionId_key" ON "AiSystemProfile"("currentVersionId");
CREATE UNIQUE INDEX "AiSystemProfileVersion_aiSystemProfileId_version_key" ON "AiSystemProfileVersion"("aiSystemProfileId", "version");

-- Preserve any existing mutable profile as an immutable legacy version before
-- attaching the new current-version pointer. JSONB has a deterministic key
-- order, so this preserves a stable SHA-256 checksum for legacy rows as well.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO "AiSystemProfileVersion" ("id", "aiSystemProfileId", "version", "profile", "checksum", "createdById", "createdAt")
SELECT md5("id" || ':' || "version"::text || ':' || "createdAt"::text), "id", "version", "profile", encode(digest("profile"::text, 'sha256'), 'hex'), "updatedById", "updatedAt"
FROM "AiSystemProfile";

UPDATE "AiSystemProfile" profile
SET "currentVersionId" = version_row."id"
FROM "AiSystemProfileVersion" version_row
WHERE version_row."aiSystemProfileId" = profile."id";

ALTER TABLE "AiSystemProfileVersion"
  ADD CONSTRAINT "AiSystemProfileVersion_aiSystemProfileId_fkey"
  FOREIGN KEY ("aiSystemProfileId") REFERENCES "AiSystemProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiSystemProfile"
  ADD CONSTRAINT "AiSystemProfile_currentVersionId_fkey"
  FOREIGN KEY ("currentVersionId") REFERENCES "AiSystemProfileVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiSystemProfileVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiSystemProfileVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY aisystemprofileversion_rls_strict ON "AiSystemProfileVersion"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM "AiSystemProfile"
      WHERE "id" = "aiSystemProfileId"
        AND "workspaceId" = app.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "AiSystemProfile"
      WHERE "id" = "aiSystemProfileId"
        AND "workspaceId" = app.current_workspace_id()
    )
  );
