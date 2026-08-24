import type { AuthSession } from "@lyrashield/auth/server"
import { findLicenseForSyncById, findLicenseForSyncByKeyHash, prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import type { LocalSkuId } from "@lyrashield/pricing"
import { hashLicenseKey } from "./licenses/license-service"
import { verifySyncSessionToken } from "./sync-session"

type SyncLicense = {
  id: string
  workspaceId: string | null
  sku: string
  revoked: boolean
}

const LEGACY_SYNC_FALLBACK_SUNSET = Date.parse("2026-10-01T00:00:00.000Z")

export async function checkSyncEntitlement(
  sku: LocalSkuId,
  targetWorkspaceId: string
): Promise<boolean> {
  if (sku === "sync_addon" || sku === "team_subscription") return true
  const workspace = await prisma.workspace.findUnique({
    where: { id: targetWorkspaceId },
    select: { plan: true },
  })
  return Boolean(workspace && workspace.plan !== "FREE")
}

export type SyncCredentialResult =
  | { ok: true; license: SyncLicense; legacyLicenseKey: boolean }
  | {
      ok: false
      code:
        | "SYNC_CREDENTIAL_REQUIRED"
        | "SYNC_SESSION_INVALID"
        | "LICENSE_KEY_NOT_FOUND"
        | "LICENSE_REVOKED"
        | "LICENSE_WORKSPACE_MISMATCH"
        | "SYNC_NOT_ENTITLED"
      message: string
      status: number
    }

async function validateSyncLicense(
  license: SyncLicense | null,
  workspaceId: string,
  notFoundMessage: string,
  mismatchMessage: string
): Promise<SyncCredentialResult> {
  if (!license) {
    return { ok: false, code: "LICENSE_KEY_NOT_FOUND", message: notFoundMessage, status: 404 }
  }
  if (license.revoked) {
    return {
      ok: false,
      code: "LICENSE_REVOKED",
      message: "This license has been revoked",
      status: 403,
    }
  }
  if (license.workspaceId !== workspaceId) {
    return {
      ok: false,
      code: "LICENSE_WORKSPACE_MISMATCH",
      message: mismatchMessage,
      status: 403,
    }
  }
  if (!(await checkSyncEntitlement(license.sku as LocalSkuId, workspaceId))) {
    return {
      ok: false,
      code: "SYNC_NOT_ENTITLED",
      message: "Cloud sync requires an active Cloud subscription or Cloud Sync Add-on",
      status: 402,
    }
  }
  return { ok: true, license, legacyLicenseKey: false }
}

export async function resolveSyncCredential(input: {
  workspaceId: string
  session: Pick<AuthSession, "userId" | "sessionId">
  syncSessionToken?: string
  licenseKey?: string
  now?: number
}): Promise<SyncCredentialResult> {
  if (input.syncSessionToken) {
    const verified = verifySyncSessionToken(input.syncSessionToken, {
      workspaceId: input.workspaceId,
      session: input.session,
    })
    if (!verified.valid) {
      return {
        ok: false,
        code: "SYNC_SESSION_INVALID",
        message:
          verified.reason === "expired"
            ? "Sync session expired; reconnect to renew it"
            : "Sync session is invalid",
        status: 401,
      }
    }
    return validateSyncLicense(
      await findLicenseForSyncById(verified.licenseId),
      input.workspaceId,
      "The sync license is no longer available",
      "This license is no longer linked to this workspace"
    )
  }

  if (!input.licenseKey) {
    return {
      ok: false,
      code: "SYNC_CREDENTIAL_REQUIRED",
      message: "syncSessionToken is required",
      status: 401,
    }
  }
  if ((input.now ?? Date.now()) >= LEGACY_SYNC_FALLBACK_SUNSET) {
    return {
      ok: false,
      code: "SYNC_CREDENTIAL_REQUIRED",
      message: "Raw license sync compatibility has ended; reconnect to create a sync session",
      status: 401,
    }
  }

  logger.warn("Deprecated raw license key used for sync request", {
    workspaceId: input.workspaceId,
    userId: input.session.userId,
  })
  const result = await validateSyncLicense(
    (await findLicenseForSyncByKeyHash(hashLicenseKey(input.licenseKey)))?.license ?? null,
    input.workspaceId,
    "The provided license key is not recognized",
    "This license is not linked to this workspace"
  )
  return result.ok ? { ...result, legacyLicenseKey: true } : result
}

export function markLegacySyncResponse(response: Response, legacyLicenseKey: boolean): Response {
  if (legacyLicenseKey) {
    response.headers.set("Deprecation", "true")
    response.headers.set("Sunset", "Thu, 01 Oct 2026 00:00:00 GMT")
    response.headers.set(
      "Warning",
      '299 LyraShield AI "Raw license keys for sync are deprecated; reconnect for a short-lived sync session"'
    )
  }
  return response
}
