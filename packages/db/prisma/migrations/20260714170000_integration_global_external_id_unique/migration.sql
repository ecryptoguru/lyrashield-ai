-- A provider installation must be owned by exactly one workspace.
-- GitHub installation IDs are numeric provider identities. Refuse deployment
-- rather than silently retaining aliases (for example, 0123 and 123) that
-- would compare differently in PostgreSQL but resolve to the same provider ID.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Integration"
    WHERE "type" = 'GITHUB'
      AND "externalId" IS NOT NULL
      AND "externalId" !~ '^[1-9][0-9]*$'
  ) THEN
    RAISE EXCEPTION 'GitHub integration externalId values must be canonical positive integers before applying this migration';
  END IF;
END $$;

CREATE UNIQUE INDEX "Integration_type_externalId_key" ON "Integration"("type", "externalId");
