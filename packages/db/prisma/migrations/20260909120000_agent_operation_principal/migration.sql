-- W3-01: principal-bound durable operation identity.
--
-- AgentOperation previously required an OAuth connectionId, so API-key and
-- browser-session principals had no durable operation ledger. This migration
-- is strictly additive and backward-compatible:
--   * connectionId becomes nullable (existing rows keep their connection);
--   * principalType/principalId identify the caller bound to the operation;
--   * existing rows backfill as OAUTH_CONNECTION/connectionId;
--   * a new unique index covers null-connection principals (a PostgreSQL
--     unique index treats NULLs as distinct, so the old composite unique
--     alone would never dedupe connectionless retries). The original index
--     is retained.

ALTER TABLE "agent_operations" ALTER COLUMN "connectionId" DROP NOT NULL;

CREATE TYPE "AgentPrincipalType" AS ENUM ('OAUTH_CONNECTION', 'API_KEY', 'BROWSER_SESSION');

ALTER TABLE "agent_operations" ADD COLUMN "principalType" "AgentPrincipalType";
ALTER TABLE "agent_operations" ADD COLUMN "principalId" TEXT;

UPDATE "agent_operations"
SET "principalType" = 'OAUTH_CONNECTION',
    "principalId" = "connectionId"
WHERE "connectionId" IS NOT NULL;

ALTER TABLE "agent_operations" ALTER COLUMN "principalType" SET DEFAULT 'OAUTH_CONNECTION';
ALTER TABLE "agent_operations" ALTER COLUMN "principalType" SET NOT NULL;
ALTER TABLE "agent_operations" ALTER COLUMN "principalId" SET NOT NULL;

CREATE UNIQUE INDEX "agent_operations_workspaceId_principalType_principalId_oper_key" ON "agent_operations"("workspaceId", "principalType", "principalId", "operationName", "idempotencyKey");
