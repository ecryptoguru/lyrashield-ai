import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { z } from "zod"

const PreferencesSchema = z.object({
  emailDigest: z.boolean().optional(),
  emailInstant: z.boolean().optional(),
  inAppInstant: z.boolean().optional(),
  inAppDigest: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  quietHoursStart: z.number().int().min(0).max(23).nullable().optional(),
  quietHoursEnd: z.number().int().min(0).max(23).nullable().optional(),
})

export async function GET() {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 }
      )
    }

    const prefs = await prisma.notificationPreference.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId },
      update: {},
    })

    return NextResponse.json({ success: true, data: prefs })
  } catch (error) {
    logger.error("Failed to get notification preferences", { error: String(error) })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Could not load preferences" } },
      { status: 500 }
    )
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 }
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { success: false, error: { code: "INVALID_JSON", message: "Invalid JSON" } },
        { status: 400 }
      )
    }

    const parsed = PreferencesSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        { status: 400 }
      )
    }

    const data = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined))

    const prefs = await prisma.notificationPreference.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, ...data },
      update: data,
    })

    return NextResponse.json({ success: true, data: prefs })
  } catch (error) {
    logger.error("Failed to update notification preferences", { error: String(error) })
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Could not update preferences" },
      },
      { status: 500 }
    )
  }
}
