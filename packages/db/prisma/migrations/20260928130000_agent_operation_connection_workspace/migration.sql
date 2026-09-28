-- Bind every connection-backed operation to a connection in its workspace.
-- Connectionless principals keep their nullable connectionId and existing behavior.
BEGIN;

LOCK TABLE "agent_operations", "agent_connections" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_operations" operation
    LEFT JOIN "agent_connections" connection ON connection."id" = operation."connectionId"
    WHERE operation."connectionId" IS NOT NULL
      AND (connection."id" IS NULL OR operation."workspaceId" <> connection."workspaceId")
  ) THEN
    RAISE EXCEPTION 'AgentOperation/AgentConnection workspace mismatches exist; repair after review before applying this migration';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "agent_connections_id_workspaceId_key"
  ON "agent_connections"("id", "workspaceId");

ALTER TABLE "agent_operations"
  DROP CONSTRAINT "agent_operations_connectionId_fkey",
  ADD CONSTRAINT "agent_operations_connectionId_workspaceId_fkey"
    FOREIGN KEY ("connectionId", "workspaceId")
    REFERENCES "agent_connections"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
