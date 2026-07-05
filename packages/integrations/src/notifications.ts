import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"

export interface NotificationPayload {
  type: string
  title: string
  body: string
  workspaceName?: string
  metadata?: Record<string, unknown>
}

export type NotificationChannel = "email" | "slack" | "discord" | "in_app"

export interface NotificationChannelSender {
  channel: NotificationChannel
  send(payload: NotificationPayload, recipients?: string[]): Promise<boolean>
  isConfigured(): boolean
}

class EmailChannel implements NotificationChannelSender {
  channel = "email" as const

  isConfigured(): boolean {
    return Boolean(env.BREVO_API_KEY && env.EMAIL_FROM)
  }

  async send(payload: NotificationPayload, recipients?: string[]): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.warn("Email channel not configured — skipping send", { type: payload.type })
      return false
    }

    if (!recipients || recipients.length === 0) {
      logger.warn("No email recipients provided — skipping send", { type: payload.type })
      return false
    }

    try {
      const fromEmail = env.NOTIFICATION_FROM_EMAIL || env.EMAIL_FROM

      const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "api-key": env.BREVO_API_KEY!,
        },
        body: JSON.stringify({
          sender: { email: fromEmail, name: "LyraSec AI" },
          to: recipients.map((email) => ({ email })),
          subject: payload.title,
          htmlContent: `<html><body style="font-family:sans-serif;color:#111827;">
<h2 style="color:#111827;">${escapeHtml(payload.title)}</h2>
<p style="color:#4b5563;line-height:1.6;">${escapeHtml(payload.body)}</p>
${payload.workspaceName ? `<p style="font-size:12px;color:#6b7280;margin-top:24px;">Workspace: ${escapeHtml(payload.workspaceName)}</p>` : ""}
<hr style="border:none;border-top:1px solid #e5e7eb;margin-top:24px;" />
<p style="font-size:11px;color:#9ca3af;">Sent by LyraSec AI</p>
</body></html>`,
        }),
      })

      if (!response.ok) {
        const text = await response.text()
        logger.error("Brevo email send failed", { status: response.status, error: text })
        return false
      }

      logger.info("Email notification sent", { type: payload.type, recipients: recipients.length })
      return true
    } catch (error) {
      logger.error("Email notification error", { error: String(error) })
      return false
    }
  }
}

class SlackChannel implements NotificationChannelSender {
  channel = "slack" as const

  isConfigured(): boolean {
    return Boolean(env.SLACK_WEBHOOK_URL)
  }

  async send(payload: NotificationPayload): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.warn("Slack channel not configured — skipping send", { type: payload.type })
      return false
    }

    try {
      const color = getSeverityColor(payload.type)
      const response = await fetch(env.SLACK_WEBHOOK_URL!, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attachments: [
            {
              color,
              title: payload.title,
              text: payload.body,
              footer: payload.workspaceName ? `LyraSec AI · ${payload.workspaceName}` : "LyraSec AI",
              ts: Math.floor(Date.now() / 1000),
            },
          ],
        }),
      })

      if (!response.ok) {
        const text = await response.text()
        logger.error("Slack webhook send failed", { status: response.status, error: text })
        return false
      }

      logger.info("Slack notification sent", { type: payload.type })
      return true
    } catch (error) {
      logger.error("Slack notification error", { error: String(error) })
      return false
    }
  }
}

class DiscordChannel implements NotificationChannelSender {
  channel = "discord" as const

  isConfigured(): boolean {
    return Boolean(env.DISCORD_WEBHOOK_URL)
  }

  async send(payload: NotificationPayload): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.warn("Discord channel not configured — skipping send", { type: payload.type })
      return false
    }

    try {
      const color = getSeverityColorDecimal(payload.type)
      const response = await fetch(env.DISCORD_WEBHOOK_URL!, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [
            {
              title: payload.title,
              description: payload.body,
              color,
              footer: { text: payload.workspaceName ? `LyraSec AI · ${payload.workspaceName}` : "LyraSec AI" },
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      })

      if (!response.ok) {
        const text = await response.text()
        logger.error("Discord webhook send failed", { status: response.status, error: text })
        return false
      }

      logger.info("Discord notification sent", { type: payload.type })
      return true
    } catch (error) {
      logger.error("Discord notification error", { error: String(error) })
      return false
    }
  }
}

class InAppChannel implements NotificationChannelSender {
  channel = "in_app" as const

  isConfigured(): boolean {
    return true
  }

  async send(): Promise<boolean> {
    return true
  }
}

export const channels: Record<NotificationChannel, NotificationChannelSender> = {
  email: new EmailChannel(),
  slack: new SlackChannel(),
  discord: new DiscordChannel(),
  in_app: new InAppChannel(),
}

export async function sendNotification(
  channel: NotificationChannel,
  payload: NotificationPayload,
  recipients?: string[]
): Promise<boolean> {
  const sender = channels[channel]
  if (!sender) {
    logger.error("Unknown notification channel", { channel })
    return false
  }

  if (!sender.isConfigured()) {
    logger.warn("Notification channel not configured", { channel, type: payload.type })
    return false
  }

  return sender.send(payload, recipients)
}

function getSeverityColor(type: string): string {
  if (type.includes("critical")) return "#dc2626"
  if (type.includes("error") || type.includes("failed")) return "#ea580c"
  if (type.includes("warning")) return "#ca8a04"
  if (type.includes("success") || type.includes("completed")) return "#16a34a"
  return "#2563eb"
}

function getSeverityColorDecimal(type: string): number {
  if (type.includes("critical")) return 0xdc2626
  if (type.includes("error") || type.includes("failed")) return 0xea580c
  if (type.includes("warning")) return 0xca8a04
  if (type.includes("success") || type.includes("completed")) return 0x16a34a
  return 0x2563eb
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}
