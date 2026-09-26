-- Persist the user's optional analytics choice across browsers and workspaces.
-- The row is account-owned and follows the same forced-RLS boundary as other
-- account data. Missing rows retain the application default of enabled.

CREATE TABLE "account_preferences" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "analyticsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_preferences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "account_preferences_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "account_preferences_accountId_key"
  ON "account_preferences"("accountId");

ALTER TABLE "account_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_preferences" FORCE ROW LEVEL SECURITY;

CREATE POLICY accountpreference_rls_account ON "account_preferences"
  FOR ALL USING ("accountId" = app.current_account_id())
  WITH CHECK ("accountId" = app.current_account_id());

CREATE POLICY accountpreference_owner_boundary ON "account_preferences" AS RESTRICTIVE
  FOR ALL USING ("accountId" = app.current_account_id())
  WITH CHECK ("accountId" = app.current_account_id());
