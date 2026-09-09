import { prisma, createAndSendNotification } from "@lyrashield/db"
import { sendNotification, type NotificationChannel } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"

export async function notifyScanCompleted(
  workspaceId: string,
  scanId: string,
  summary: string,
  findingCount: number
): Promise<void> {
  try {
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { name: true },
    })

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
      workspaceName: workspace?.name,
      routineGroup: {
        groupType: "scan completions",
        windowKey,
        windowLabel: "Recent scan completions",
        detail: `${summary} · ${findingCount} finding${findingCount === 1 ? "" : "s"}`,
      },
      sendFn: (channel, payload) => sendNotification(channel as NotificationChannel, payload),
    })
  } catch (error) {
    logger.error("Failed to send scan completed notification", { error: String(error), scanId })
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
      sendFn: (channel, payload) => sendNotification(channel as NotificationChannel, payload),
    })
  } catch (error) {
    logger.error("Failed to send scan failed notification", { error: String(error), scanId })
  }
}

export async function notifyCriticalFinding(
  workspaceId: string,
  findingId: string,
  findingTitle: string,
  targetName: string
): Promise<void> {
  try {
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { name: true },
    })

    const title = `Critical Finding — ${findingTitle}`
    const body = `A critical vulnerability was found on target: ${targetName}.\n\nFinding ID: ${findingId}`

    await createAndSendNotification({
      workspaceId,
      type: "finding.critical",
      title,
      body,
      workspaceName: workspace?.name,
      sendFn: (channel, payload) => sendNotification(channel as NotificationChannel, payload),
    })
  } catch (error) {
    logger.error("Failed to send critical finding notification", {
      error: String(error),
      findingId,
    })
  }
}
