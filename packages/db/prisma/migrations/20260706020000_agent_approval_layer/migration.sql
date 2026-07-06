-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED');

-- CreateTable
CREATE TABLE "AgentApproval" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actionName" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "deniedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentApproval_workspaceId_idx" ON "AgentApproval"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentApproval_status_idx" ON "AgentApproval"("status");

-- CreateIndex
CREATE INDEX "AgentApproval_requestedById_idx" ON "AgentApproval"("requestedById");

-- AddForeignKey
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable RLS on AgentApproval (defense-in-depth with Prisma client extension)
ALTER TABLE "AgentApproval" ENABLE ROW LEVEL SECURITY;

CREATE POLICY agentapproval_rls_permissive ON "AgentApproval"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY agentapproval_rls_strict ON "AgentApproval"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
