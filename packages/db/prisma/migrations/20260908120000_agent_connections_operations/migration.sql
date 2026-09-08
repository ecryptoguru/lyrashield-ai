-- CreateEnum
CREATE TYPE "AgentConnectionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AgentOperationStatus" AS ENUM ('PENDING', 'EXECUTING', 'COMPLETED', 'FAILED', 'CONFLICT');

-- CreateTable
CREATE TABLE "agent_connections" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientType" TEXT NOT NULL,
    "clientName" TEXT,
    "oauthClientId" TEXT,
    "status" "AgentConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowedTargetIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allTargets" BOOLEAN NOT NULL DEFAULT false,
    "allowedOperations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowedProfiles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "authorizationVersion" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_operations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "operationName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "authorizationVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "AgentOperationStatus" NOT NULL DEFAULT 'PENDING',
    "resultReference" TEXT,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_connections_workspaceId_idx" ON "agent_connections"("workspaceId");
CREATE INDEX "agent_connections_userId_idx" ON "agent_connections"("userId");
CREATE INDEX "agent_connections_status_idx" ON "agent_connections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_operations_connectionId_operationName_idempotencyKey_key" ON "agent_operations"("connectionId", "operationName", "idempotencyKey");
CREATE INDEX "agent_operations_workspaceId_idx" ON "agent_operations"("workspaceId");
CREATE INDEX "agent_operations_status_idx" ON "agent_operations"("status");

-- AddForeignKey
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "agent_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS Backstop
ALTER TABLE "agent_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_connections" FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_connections_rls_strict ON "agent_connections"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

ALTER TABLE "agent_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_operations" FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_operations_rls_strict ON "agent_operations"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- OAuth consent uses the current browser session as a short-lived handoff to
-- the provider's consentReferenceId callback. Resource verification still
-- validates the immutable client/connection/version binding on every request.
ALTER TABLE "sessions" ADD COLUMN "pendingAgentConnectionId" TEXT;
