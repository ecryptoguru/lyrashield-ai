CREATE TABLE "AdvisoryCacheEntry" (
    "id" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvisoryCacheEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdvisoryCacheEntry_ecosystem_normalizedName_version_source_schemaVersion_key"
ON "AdvisoryCacheEntry"("ecosystem", "normalizedName", "version", "source", "schemaVersion");

CREATE INDEX "AdvisoryCacheEntry_expiresAt_idx" ON "AdvisoryCacheEntry"("expiresAt");
