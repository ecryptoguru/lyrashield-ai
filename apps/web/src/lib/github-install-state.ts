import { createHmac, randomBytes, timingSafeEqual } from "crypto"
import { GitHubContextSchema, type GitHubContext } from "./github-oauth-context"
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
 * Format: base64url(workspaceId) + "." + return destination + "." + nonce +
 * "." + expiry + "." + base64url(hmac). The nonce can encode an optional
 * return context and GitHub purpose/session context. Chooser state identifies
 * candidates only; a fresh provider code and authority check still authorize binding.
 */

const TTL_MS = 10 * 60 * 1000 // 10 minutes
const INSTALL_RETURN_DESTINATIONS = ["onboarding", "integrations", "scan"] as const
export type InstallReturnDestination = (typeof INSTALL_RETURN_DESTINATIONS)[number]

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

function sign(payload: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(payload).digest("base64url")
}

export function createInstallState(
  workspaceId: string,
  returnTo: InstallReturnDestination = "integrations",
  now: number = Date.now(),
  oauthReturnState?: string,
  github?: GitHubContext
): string {
  const nonce =
    oauthReturnState || github
      ? b64url(
          JSON.stringify({
            nonce: b64url(randomBytes(12)),
            oauthReturnState,
            ...(github ? { github: GitHubContextSchema.parse(github) } : {}),
          })
        )
      : b64url(randomBytes(12))
  const payload = `${b64url(workspaceId)}.${returnTo}.${nonce}.${now + TTL_MS}`
  return `${payload}.${sign(payload)}`
}

export type InstallStateResult =
  | {
      valid: true
      workspaceId: string
      returnTo: InstallReturnDestination
      oauthReturnState?: string
      github?: GitHubContext
    }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" }

export function verifyInstallState(state: string, now: number = Date.now()): InstallStateResult {
  if (state.length > 24000) return { valid: false, reason: "malformed" }
  const parts = state.split(".")
  if (parts.length !== 4 && parts.length !== 5) return { valid: false, reason: "malformed" }
  const legacy = parts.length === 4
  const [wsB64, returnTo, nonce, expStr, sig] = legacy
    ? ([parts[0], "integrations", parts[1], parts[2], parts[3]] as [
        string,
        string,
        string,
        string,
        string,
      ])
    : (parts as [string, string, string, string, string])
  if (!INSTALL_RETURN_DESTINATIONS.includes(returnTo as InstallReturnDestination)) {
    return { valid: false, reason: "malformed" }
  }
  const payload = legacy ? `${wsB64}.${nonce}.${expStr}` : `${wsB64}.${returnTo}.${nonce}.${expStr}`

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

  let oauthReturnState: string | undefined
  let github: GitHubContext | undefined
  try {
    const context = JSON.parse(Buffer.from(nonce, "base64url").toString("utf8"))
    if (context?.github !== undefined) {
      const parsed = GitHubContextSchema.safeParse(context.github)
      if (!parsed.success) return { valid: false, reason: "malformed" }
      github = parsed.data
    }
    if (typeof context?.oauthReturnState === "string" && context.oauthReturnState.length <= 8192)
      oauthReturnState = context.oauthReturnState
  } catch {
    /* Older states contain only a random nonce. */
  }
  return {
    valid: true,
    workspaceId,
    returnTo: returnTo as InstallReturnDestination,
    ...(oauthReturnState ? { oauthReturnState } : {}),
    ...(github ? { github } : {}),
  }
}
