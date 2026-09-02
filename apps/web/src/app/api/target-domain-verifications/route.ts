import { withCookieMutation } from "../../../lib/api-auth"
import {
  issueDnsDomainVerification,
  LiveAiSafetyError,
  prisma,
  verifyDnsDomainVerification,
} from "@lyrashield/db"
import { PERMISSIONS } from "@lyrashield/auth"
import { requirePermission } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"

const RequestProofSchema = z.object({ workspaceId: z.string().min(1), domain: z.string().min(1) })
const VerifyProofSchema = z.object({
  workspaceId: z.string().min(1),
  verificationId: z.string().min(1),
})

function privateResponse(data: unknown, status = 200) {
  const response = apiSuccess(data, status)
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    if (!workspaceId) return apiError("MISSING_PARAM", "workspaceId is required", 400)
    await requirePermission(workspaceId, PERMISSIONS.target.validate)
    const records = await prisma.targetDomainVerification.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        domain: true,
        method: true,
        status: true,
        expiresAt: true,
        verifiedAt: true,
        lastCheckedAt: true,
        createdAt: true,
      },
    })
    return privateResponse(records)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list domain verifications", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list domain verifications", 500)
  }
}

async function post(request: Request) {
  try {
    const parsed = RequestProofSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success)
      return apiError("INVALID_PARAM", "A workspace and valid domain are required", 400)
    const { session } = await requirePermission(
      parsed.data.workspaceId,
      PERMISSIONS.target.validate
    )
    const { verification, token, expiresAt } = await issueDnsDomainVerification({
      workspaceId: parsed.data.workspaceId,
      domain: parsed.data.domain,
      createdById: session.userId,
    })
    return privateResponse(
      {
        verification: {
          id: verification.id,
          domain: verification.domain,
          status: verification.status,
          expiresAt,
        },
        dns: { host: `_lyrashield.${verification.domain}`, value: token },
      },
      201
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof LiveAiSafetyError)
      return apiError(error.code, "The domain cannot be verified", 400)
    logger.error("Failed to issue domain verification", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to issue domain verification", 500)
  }
}

async function put(request: Request) {
  try {
    const parsed = VerifyProofSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success)
      return apiError("INVALID_PARAM", "A workspace and verification are required", 400)
    const { session } = await requirePermission(
      parsed.data.workspaceId,
      PERMISSIONS.target.validate
    )
    const verification = await verifyDnsDomainVerification({
      workspaceId: parsed.data.workspaceId,
      verificationId: parsed.data.verificationId,
      actorUserId: session.userId,
    })
    return privateResponse({
      id: verification.id,
      domain: verification.domain,
      method: verification.method,
      status: verification.status,
      expiresAt: verification.expiresAt,
      verifiedAt: verification.verifiedAt,
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof LiveAiSafetyError) {
      return apiError(error.code, "The required DNS record was not found or has expired", 409)
    }
    logger.error("Failed to verify domain", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to verify domain", 500)
  }
}

export const POST = withCookieMutation(post)

export const PUT = withCookieMutation(put)
