import { createHmac, timingSafeEqual } from "crypto"
import { env } from "@lyrashield/config"

/**
 * Signed, expiring `state` token for the GitHub App install flow. (S2)
 *
 * Previously the callback trusted a raw `state=<workspaceId>` query param and
 * validated `installation_id` only against the app's global installation list,
 * so a user could attach an installation to a workspace by tampering with state
 * / replaying an enumerable installation id. This binds `state` to the workspace
 * that initiated the flow (a caller who held `integration:manage`), makes it
 * tamper-evident (HMAC over the app secret), and time-limits it.
 *
 * Format: base64url(`${workspaceId}.${nonce}.${expMs}`) + "." + base64url(hmac)
 */

const TTL_MS = 10 * 60 * 1000 // 10 minutes

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

function sign(payload: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(payload).digest("base64url")
}

export function createInstallState(workspaceId: string, now: number = Date.now()): string {
  const nonce = b64url(createHmac("sha256", env.BETTER_AUTH_SECRET).update(`${workspaceId}:${now}:${Math.random()}`).digest().subarray(0, 12))
  const payload = `${b64url(workspaceId)}.${nonce}.${now + TTL_MS}`
  return `${payload}.${sign(payload)}`
}

export type InstallStateResult =
  | { valid: true; workspaceId: string }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" }

export function verifyInstallState(state: string, now: number = Date.now()): InstallStateResult {
  const parts = state.split(".")
  if (parts.length !== 4) return { valid: false, reason: "malformed" }
  const [wsB64, nonce, expStr, sig] = parts as [string, string, string, string]
  const payload = `${wsB64}.${nonce}.${expStr}`

  const expected = sign(payload)
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: "bad_signature" }
  }

  const expMs = Number(expStr)
  if (!Number.isFinite(expMs) || now > expMs) {
    return { valid: false, reason: "expired" }
  }

  let workspaceId: string
  try {
    workspaceId = Buffer.from(wsB64, "base64url").toString("utf-8")
  } catch {
    return { valid: false, reason: "malformed" }
  }
  if (!workspaceId) return { valid: false, reason: "malformed" }

  return { valid: true, workspaceId }
}
