-- Alternate e-mail verification is bound to the authenticated account that
-- requested it. Public verification remains bound to publicSessionId.
ALTER TABLE "myra_identity_verifications" ADD COLUMN "accountId" TEXT;

CREATE INDEX "myra_identity_verifications_accountId_email_purpose_expires_idx"
  ON "myra_identity_verifications"("accountId", "email", "purpose", "expiresAt");
