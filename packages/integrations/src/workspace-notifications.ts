import { readEncryptedArtifact } from "@lyrashield/evidence-storage"
import { z } from "zod"
import type { NotificationPayload } from "./notifications"

export type WorkspaceNotificationChannel = "slack" | "discord"

const WEBHOOK_PATTERNS = {
  slack: /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9_-]+$/,
  discord: /^https:\/\/discord\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/,
} satisfies Record<WorkspaceNotificationChannel, RegExp>

const credentialSchema = z.object({ webhookUrl: z.string().max(2048) }).strict()

/** Canonical provider URLs only: no URL normalization, credentials, ports or redirect parameters. */
export function validateNotificationWebhookUrl(
  channel: WorkspaceNotificationChannel,
  url: string
): boolean {
  return WEBHOOK_PATTERNS[channel].test(url)
}

function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Reads a workspace-bound encrypted credential; never falls back to process-wide webhooks. */
export async function sendWorkspaceNotification(
  channel: WorkspaceNotificationChannel,
  payload: NotificationPayload,
  context: { workspaceId: string; configRef: string }
): Promise<boolean> {
  let webhookUrl: string
  let credentialTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const artifact = await Promise.race([
      readEncryptedArtifact(context.configRef, context.workspaceId),
      new Promise<never>((_, reject) => {
        credentialTimer = setTimeout(() => reject(new Error("Credential read timed out")), 15_000)
      }),
    ])
    if (artifact.content.byteLength > 4096) throw new Error("Credential exceeds size limit")
    const credential = credentialSchema.parse(JSON.parse(artifact.content.toString("utf8")))
    if (!validateNotificationWebhookUrl(channel, credential.webhookUrl)) {
      throw new Error("Invalid provider webhook")
    }
    webhookUrl = credential.webhookUrl
  } catch {
    // Artifact errors and validation diagnostics may contain the secret URL or storage reference.
    throw new Error("Workspace notification credential is unavailable or invalid")
  } finally {
    if (credentialTimer) clearTimeout(credentialTimer)
  }

  const text = [payload.workspaceName, payload.title, payload.body].filter(Boolean).join("\n\n")
  const body =
    channel === "slack"
      ? {
          text: escapeSlackText(text).slice(0, 3000),
          mrkdwn: false,
          unfurl_links: false,
          unfurl_media: false,
        }
      : { content: text.slice(0, 2000), allowed_mentions: { parse: [] } }

  let response: Response
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error("Workspace notification delivery failed")
  }
  // Do not consume provider bodies; cancel them to release the connection without retaining secrets.
  void response.body?.cancel().catch(() => {})
  if (!response.ok) {
    throw new Error(`Workspace notification delivery failed (HTTP ${response.status})`)
  }
  return true
}
