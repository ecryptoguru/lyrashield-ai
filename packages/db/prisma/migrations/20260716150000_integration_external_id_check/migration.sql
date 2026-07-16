ALTER TABLE "Integration"
ADD CONSTRAINT "Integration_github_externalId_format_check"
CHECK (
  "type" <> 'GITHUB'
  OR "externalId" IS NULL
  OR "externalId" ~ '^[1-9][0-9]*$'
) NOT VALID;

ALTER TABLE "Integration"
VALIDATE CONSTRAINT "Integration_github_externalId_format_check";
