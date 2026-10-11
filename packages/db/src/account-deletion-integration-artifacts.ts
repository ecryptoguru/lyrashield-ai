import { createId } from "@paralleldrive/cuid2"
import { join, resolve } from "node:path"
import { env } from "@lyrashield/config"
import { isEvidenceStorageUriForWorkspace } from "@lyrashield/security"
import { prisma } from "./client"
import { lockNotificationDestinationsForDeletion } from "./notification-integration-service"

type DeletionTransaction = Pick<typeof prisma, "$executeRaw" | "$queryRaw">
type DeletionWorkspace = { id: string; name: string }
type IntegrationArtifact = { workspaceId: string; storageUri: string }

export async function stageIntegrations(
  tx: DeletionTransaction,
  workspace: DeletionWorkspace,
  artifacts: IntegrationArtifact[],
  unsupportedWorkspaces: DeletionWorkspace[]
): Promise<void> {
  const { id: workspaceId } = workspace
  await lockNotificationDestinationsForDeletion(tx, workspaceId)
  const rows = await tx.$queryRaw<Array<{ configRef: string }>>`
    SELECT "configRef" FROM "Integration"
    WHERE "workspaceId" = ${workspaceId} AND "configRef" IS NOT NULL
    FOR UPDATE`
  const localEvidenceRoot = resolve(
    env.LYRASHIELD_LOCAL_EVIDENCE_DIR || join(process.cwd(), ".lyrashield", "evidence")
  )
  let unsupported = false

  for (const row of rows) {
    if (
      !isEvidenceStorageUriForWorkspace({
        storageUri: row.configRef,
        workspaceId,
        s3Bucket: env.S3_BUCKET ?? "",
        localEvidenceRoot,
      })
    ) {
      unsupported = true
      continue
    }
    artifacts.push({ workspaceId, storageUri: row.configRef })
  }

  if (unsupported) unsupportedWorkspaces.push(workspace)
}

export async function enqueueIntegrationConfigDeletionTasks(
  tx: DeletionTransaction,
  artifacts: IntegrationArtifact[]
): Promise<string[]> {
  const taskIds: string[] = []
  const uniqueArtifacts = [
    ...new Map(artifacts.map((artifact) => [artifact.storageUri, artifact])).values(),
  ]

  for (const artifact of uniqueArtifacts) {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${artifact.workspaceId}, true)`
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT app.enqueue_integration_config_deletion_task(
        ${createId()}, ${artifact.workspaceId}, ${artifact.storageUri}
      ) AS id`
    const taskId = rows[0]?.id
    if (!taskId) throw new Error("Integration config deletion task was not persisted")
    taskIds.push(taskId)
  }

  return taskIds
}
