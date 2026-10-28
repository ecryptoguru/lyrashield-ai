-- Better Auth 1.7.3+ resolves accounts by providerId/accountId again.
-- Fail on ambiguous existing identities rather than merging or deleting accounts.
-- Retain the issuer column and index for compatibility with the prior runtime.
CREATE UNIQUE INDEX "accounts_providerId_accountId_key" ON "accounts"("providerId", "accountId");
