import {
  prisma,
  createAndSendNotification,
  getWorkspaceNotificationChannels,
  withActiveWorkspaceNotificationDestination,
} from "@lyrashield/db"
import { sendNotification, sendWorkspaceNotification } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"

async function workspaceDelivery(workspaceId: string) {
  let destinations: Awaited<ReturnType<typeof getWorkspaceNotificationChannels>> = []
  try {
    destinations = await getWorkspaceNotificationChannels(workspaceId)
  } catch {
    logger.warn("Workspace notification destinations unavailable; retaining in-app delivery", {
      workspaceId,
    })
  }
  return {
    channels: ["in_app", ...destinations.map(({ channel }) => channel)],
    sendFn: async (
      channel: string,
      payload: { type: string; title: string; body: string; workspaceName?: string }
    ): Promise<boolean | "skipped"> => {
      if (channel === "in_app") return sendNotification("in_app", payload)
      const destination = destinations.find((item) => item.channel === channel)
      if (!destination) return false
      // Re-resolve under the same purpose lock used by reconnect and disable. The initial
      // snapshot chooses channels only; it never authorizes sending to a stale credential.
      const sent = await withActiveWorkspaceNotificationDestination(
        workspaceId,
        destination.channel,
        (configRef) =>
          sendWorkspaceNotification(destination.channel, payload, { workspaceId, configRef })
      )
      return sent ?? "skipped"
    },
  }
}

export async function notifyScanCompleted(
  workspaceId: string,
  scanId: string,
  summary: string,
  findingCount: number,
  workspaceName?: string
): Promise<void> {
  try {
    const title = `Scan Completed — ${findingCount} finding${findingCount !== 1 ? "s" : ""}`
    const body = `Scan ${scanId} completed successfully.\n\nSummary: ${summary}\nFindings: ${findingCount}`

    // W3-06: routine completions coalesce into one digest per hour so a batch
    // of finishing scans (queue drain, schedule fan-out, webhook retries)
    // cannot storm the channels. Failures and critical findings are never
    // grouped and keep delivering individually.
    const windowKey = new Date().toISOString().slice(0, 13) // hourly bucket
    await createAndSendNotification({
      workspaceId,
      type: "scan.completed",
      title,
      body,
      workspaceName,
      routineGroup: {
        groupType: "scan completions",
        windowKey,
        windowLabel: "Recent scan completions",
        detail: `${summary} · ${findingCount} finding${findingCount === 1 ? "" : "s"}`,
      },
      ...(await workspaceDelivery(workspaceId)),
    })
  } catch (error) {
    logger.error("Failed to send scan completed notification", { error: String(error), scanId })
    throw error
  }
}

export async function notifyScanFailed(
  workspaceId: string,
  scanId: string,
  errorMessage: string
): Promise<void> {
  try {
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { name: true },
    })

    const title = "Scan Failed"
    const body = `Scan ${scanId} failed.\n\nError: ${errorMessage}`

    await createAndSendNotification({
      workspaceId,
      type: "scan.failed",
      title,
      body,
      workspaceName: workspace?.name,
      ...(await workspaceDelivery(workspaceId)),
    })
  } catch (error) {
    logger.error("Failed to send scan failed notification", { error: String(error), scanId })
    throw error
  }
}

export async function notifyCriticalFinding(
  workspaceId: string,
  findingId: string,
  findingTitle: string,
  targetName: string,
  workspaceName?: string
): Promise<void> {
  try {
    const title = `Critical Finding — ${findingTitle}`
    const body = `A critical vulnerability was found on target: ${targetName}.\n\nFinding ID: ${findingId}`

    await createAndSendNotification({
      workspaceId,
      type: "finding.critical",
      title,
      body,
      workspaceName,
      ...(await workspaceDelivery(workspaceId)),
    })
  } catch (error) {
    logger.error("Failed to send critical finding notification", {
      error: String(error),
      findingId,
    })
    throw error
  }
}
