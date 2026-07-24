import { createHash, randomBytes, timingSafeEqual } from "crypto"
import { prisma } from "./client"
import type { ApiKey } from "./generated/prisma"

/**
 * Workspace API keys for non-browser clients (MCP server, CLI, CI, scripts).
 *
 * Security design:
 * - The raw key is shown exactly once at creation and never stored. Only a
 *   SHA-256 hash is persisted (`hashedKey`), plus a display `prefix` so users
 *   can recognize keys in the UI.
 * - Format: `lsk_<43 chars base64url>` (256 bits of entropy). The `lsk_`
 *   prefix makes keys greppable by secret scanners (including our own).
 * - Verification is O(1) via the unique hash index — no table scan, and the
 *   hash comparison uses timingSafeEqual as defense-in-depth.
 * - Keys are workspace-bound. The auth layer must enforce that a key can only
 *   authorize requests for its own workspace.
 * - `scopes` is a coarse v1 contract: "read" and/or "write". Read-only keys
 *   must be rejected for mutating permissions by the auth layer.
 */

export const API_KEY_PREFIX = "lsk_"
export const API_KEY_SCOPES = ["read", "write"] as const
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

/** Display prefix length: "lsk_" + 8 identifying chars. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8

const MAX_ACTIVE_KEYS_PER_WORKSPACE = 20

export interface CreatedApiKey {
  /** Full raw key — returned exactly once, never persisted. */
  rawKey: string
  apiKey: PublicApiKey
}

/** The shape safe to return to the dashboard — never includes hashedKey. */
export interface PublicApiKey {
  id: string
  name: string
  prefix: string
  scopes: string[]
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

export interface VerifiedApiKey {
  keyId: string
  workspaceId: string
  scopes: string[]
  createdById: string
  prefix: string
}

function toPublic(key: ApiKey): PublicApiKey {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
  }
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex")
}

export function isApiKeyFormat(candidate: string): boolean {
  return (
    candidate.startsWith(API_KEY_PREFIX) &&
    candidate.length >= DISPLAY_PREFIX_LENGTH &&
    candidate.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(candidate.slice(API_KEY_PREFIX.length))
  )
}

function normalizeScopes(scopes: string[]): ApiKeyScope[] {
  const valid = scopes.filter((s): s is ApiKeyScope =>
    (API_KEY_SCOPES as readonly string[]).includes(s)
  )
  const unique = [...new Set(valid)]
  if (unique.length === 0) {
    throw new Error("INVALID_SCOPES")
  }
  return unique
}

export async function createApiKey(params: {
  workspaceId: string
  name: string
  scopes: string[]
  createdById: string
  expiresAt?: Date | null
}): Promise<CreatedApiKey> {
  const name = params.name.trim()
  if (name.length < 1 || name.length > 100) {
    throw new Error("INVALID_NAME")
  }
  const scopes = normalizeScopes(params.scopes)
  if (params.expiresAt && params.expiresAt.getTime() <= Date.now()) {
    throw new Error("INVALID_EXPIRY")
  }

  const activeCount = await prisma.apiKey.count({
    where: {
      workspaceId: params.workspaceId,
      revokedAt: null,
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  })
  if (activeCount >= MAX_ACTIVE_KEYS_PER_WORKSPACE) {
    throw new Error("KEY_LIMIT_REACHED")
  }

  const rawKey = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`
  const created = await prisma.apiKey.create({
    data: {
      workspaceId: params.workspaceId,
      name,
      hashedKey: hashApiKey(rawKey),
      prefix: rawKey.slice(0, DISPLAY_PREFIX_LENGTH),
      scopes,
      createdById: params.createdById,
      expiresAt: params.expiresAt ?? null,
    },
  })

  return { rawKey, apiKey: toPublic(created) }
}

export async function listApiKeys(workspaceId: string): Promise<PublicApiKey[]> {
  const keys = await prisma.apiKey.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  })
  return keys.map(toPublic)
}

/**
 * Revoke a key. Returns false when the key does not exist in this workspace or
 * is already revoked (idempotent CAS — no revive, no cross-workspace reach).
 */
export async function revokeApiKey(keyId: string, workspaceId: string): Promise<boolean> {
  const result = await prisma.apiKey.updateMany({
    where: { id: keyId, workspaceId, revokedAt: null, deletedAt: null },
    data: { revokedAt: new Date() },
  })
  return result.count === 1
}

/**
 * Verify a raw bearer key. Returns null for unknown, revoked, expired,
 * soft-deleted, or malformed keys — the caller treats null as UNAUTHORIZED.
 * Updates lastUsedAt best-effort (never blocks or fails the request).
 */
interface VerifyApiKeyRow {
  id: string
  workspaceId: string
  scopes: string[]
  createdById: string
  prefix: string
  hashedKey: string
  revokedAt: Date | null
  expiresAt: Date | null
  deletedAt: Date | null
  lastUsedAt: Date | null
}

export async function verifyApiKey(rawKey: string): Promise<VerifiedApiKey | null> {
  if (!isApiKeyFormat(rawKey)) return null

  const hashed = hashApiKey(rawKey)

  // Pre-auth, cross-tenant lookup: the workspace is unknown until the key is
  // resolved, so no workspace RLS context can be set here. "ApiKey" is under
  // FORCE row-level security with a strict workspace policy, which would filter
  // this by-hash lookup to zero rows for the restricted (NOBYPASSRLS) app role.
  // app.verify_api_key is a SECURITY DEFINER function that performs exactly this
  // one narrow lookup with the owner's privileges — see migration
  // 20260724170000_api_key_verify_definer.
  const rows = await prisma.$queryRaw<VerifyApiKeyRow[]>`
    SELECT * FROM app.verify_api_key(${hashed})
  `
  const key = rows[0]
  if (!key) return null

  // Defense-in-depth: constant-time re-comparison of the stored hash. The
  // lookup above is already exact; this guards against any future change that
  // loosens the lookup.
  const stored = Buffer.from(key.hashedKey, "utf8")
  const candidate = Buffer.from(hashed, "utf8")
  if (stored.length !== candidate.length || !timingSafeEqual(stored, candidate)) {
    return null
  }

  if (key.deletedAt) return null
  if (key.revokedAt) return null
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null

  // Best-effort usage tracking; throttled to once per minute per key to avoid
  // a write per request. Uses the SECURITY DEFINER touch function for the same
  // pre-auth RLS reason as the lookup above.
  const now = Date.now()
  if (!key.lastUsedAt || now - key.lastUsedAt.getTime() > 60_000) {
    void prisma.$executeRaw`SELECT app.touch_api_key_last_used(${key.id})`.catch(() => {
      /* usage tracking must never fail a request */
    })
  }

  return {
    keyId: key.id,
    workspaceId: key.workspaceId,
    scopes: key.scopes,
    createdById: key.createdById,
    prefix: key.prefix,
  }
}
