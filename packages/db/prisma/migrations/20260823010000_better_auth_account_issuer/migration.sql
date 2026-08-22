-- Better Auth 1.7 keys an external account by (issuer, accountId), rather than
-- by (providerId, accountId). Backfill each configured provider to the issuer
-- the upgraded runtime resolves, then replace the old identity constraint.
--
-- Microsoft issuer values are tenant-specific, so derive them from the stored
-- OpenID Connect ID token. If an existing row cannot be mapped, abort instead
-- of assigning a synthetic issuer that would orphan its next sign-in.

ALTER TABLE "accounts" ADD COLUMN "issuer" TEXT;

UPDATE "accounts"
SET "issuer" = CASE
  WHEN "providerId" = 'credential' THEN 'local:credential'
  WHEN "providerId" = 'github' THEN 'local:oauth:github'
  WHEN "providerId" = 'google' THEN 'https://accounts.google.com'
  WHEN "providerId" = 'microsoft' AND "idToken" IS NOT NULL THEN
    NULLIF(
      convert_from(
        decode(
          rpad(
            translate(split_part("idToken", '.', 2), '-_', '+/'),
            ((length(split_part("idToken", '.', 2)) + 3) / 4) * 4,
            '='
          ),
          'base64'
        ),
        'UTF8'
      )::jsonb ->> 'iss',
      ''
    )
END
WHERE "issuer" IS NULL;

DO $$
DECLARE
  unmapped_providers TEXT;
BEGIN
  SELECT string_agg(DISTINCT "providerId", ', ' ORDER BY "providerId")
  INTO unmapped_providers
  FROM "accounts"
  WHERE "issuer" IS NULL;

  IF unmapped_providers IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot upgrade Better Auth account identity: issuer is missing for provider(s): %. Map these records before retrying.',
      unmapped_providers;
  END IF;
END $$;

ALTER TABLE "accounts" ALTER COLUMN "issuer" SET NOT NULL;

DROP INDEX "accounts_providerId_accountId_key";
CREATE UNIQUE INDEX "accounts_issuer_accountId_key" ON "accounts"("issuer", "accountId");
