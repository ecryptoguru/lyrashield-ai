import { z } from "zod"
import { logger } from "@lyrashield/logger"
import {
  INJECTABLE_SESSION_HEADERS,
  MAX_SESSION_HEADER_VALUE_BYTES,
  normalizeRelayHost,
  type RelaySessionBinding,
} from "@lyrashield/security"
import type { AuthenticatedAssessmentAuthorization } from "@lyrashield/db"

/**
 * Authenticated-assessment session material resolution.
 *
 * A CredentialSet row stores only a *reference*: `vaultRef` names the secret
 * holding the pre-created test session, and `scope` describes how the relay
 * may apply it. This module resolves the reference into the bounded
 * RelaySessionBinding handed to the relay over its admin channel — the
 * material never enters the execution plan, the engine sandbox environment,
 * the model context, audit metadata, or logs.
 *
 * Supported vault references (fail closed on anything else):
 *   `env:LYRASHIELD_TEST_SESSION_<suffix>` — a worker environment variable
 *   provisioned by the deployment's secret-injection pipeline. Values are
 *   short-lived test-session material only; production credentials must never
 *   be reachable through this contract.
 */

export class AuthSessionError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "AuthSessionError"
  }
}

const ENV_VAULT_REF = /^env:(LYRASHIELD_TEST_SESSION_[A-Z0-9_]{1,64})$/

const CredentialSessionScopeSchema = z
  .object({
    /**
     * Hosts the session may be injected for, narrowed further from the grant
     * scope. Defaults to the authorization's approved host.
     */
    hosts: z.array(z.string().min(1).max(253)).max(8).optional(),
    /** For kind HEADER: the injectable header name (allowlisted at the relay). */
    headerName: z.string().min(1).max(64).optional(),
    /** Optional value prefix, e.g. "Bearer " — applied before the material. */
    valuePrefix: z.string().max(32).optional(),
    /** Free-form role label recorded on the authorization (evidence only). */
    role: z.string().min(1).max(64).optional(),
  })
  .strict()

/**
 * Map a credential kind to the injectable header it materializes:
 *   SESSION_COOKIE → `cookie: <material>`
 *   BEARER_TOKEN   → `authorization: Bearer <material>`
 *   HEADER         → `<scope.headerName>: <scope.valuePrefix?><material>`
 */
function sessionHeadersForKind(
  credential: Pick<AuthenticatedAssessmentAuthorization, "credentialKind" | "credentialScope">,
  material: string
): Record<string, string> {
  const scope = CredentialSessionScopeSchema.safeParse(credential.credentialScope ?? {})
  if (!scope.success) throw new AuthSessionError("AUTH_SESSION_SCOPE_INVALID")
  const prefix = scope.data.valuePrefix ?? ""

  switch (credential.credentialKind) {
    case "SESSION_COOKIE":
      return { cookie: material }
    case "BEARER_TOKEN":
      return { authorization: `Bearer ${material}` }
    case "HEADER": {
      const headerName = scope.data.headerName?.trim().toLowerCase()
      if (
        !headerName ||
        !INJECTABLE_SESSION_HEADERS.includes(
          headerName as (typeof INJECTABLE_SESSION_HEADERS)[number]
        )
      ) {
        throw new AuthSessionError("AUTH_SESSION_HEADER_UNSUPPORTED")
      }
      return { [headerName]: `${prefix}${material}` }
    }
    default:
      // Only explicitly modeled test-session kinds may inject — no generic
      // credential upload path exists beyond this bounded contract.
      throw new AuthSessionError("AUTH_SESSION_KIND_UNSUPPORTED")
  }
}

/**
 * Resolve the recorded test-session reference into a relay session binding.
 * Fails closed: unknown vault refs, missing material, oversize or malformed
 * values, and out-of-scope hosts all deny rather than degrade.
 */
export function resolveRelaySessionBinding(
  authorization: Pick<
    AuthenticatedAssessmentAuthorization,
    | "approvedHost"
    | "credentialId"
    | "credentialKind"
    | "credentialVaultRef"
    | "credentialScope"
    | "credentialExpiresAt"
  >,
  options: {
    /** Grant expiry, epoch ms — the session can never outlive the grant. */
    grantExpiresAtMs: number
    runtimeEnv?: NodeJS.ProcessEnv
  }
): RelaySessionBinding {
  const env = options.runtimeEnv ?? process.env
  const ref = authorization.credentialVaultRef.trim()
  const match = ENV_VAULT_REF.exec(ref)
  if (!match) throw new AuthSessionError("AUTH_SESSION_VAULT_REF_UNSUPPORTED")

  const material = env[match[1]!]?.trim()
  if (!material) throw new AuthSessionError("AUTH_SESSION_UNAVAILABLE")
  if (
    Buffer.byteLength(material, "utf8") > MAX_SESSION_HEADER_VALUE_BYTES ||
    /[\r\n]/.test(material)
  ) {
    throw new AuthSessionError("AUTH_SESSION_MATERIAL_INVALID")
  }

  const scope = CredentialSessionScopeSchema.safeParse(authorization.credentialScope ?? {})
  if (!scope.success) throw new AuthSessionError("AUTH_SESSION_SCOPE_INVALID")

  const hosts = (scope.data.hosts ?? [authorization.approvedHost])
    .map((host) => normalizeRelayHost(host))
    .filter((host): host is string => host !== null)
  if (hosts.length === 0) throw new AuthSessionError("AUTH_SESSION_SCOPE_INVALID")

  const headers = sessionHeadersForKind(authorization, material)
  for (const value of Object.values(headers)) {
    if (Buffer.byteLength(value, "utf8") > MAX_SESSION_HEADER_VALUE_BYTES) {
      throw new AuthSessionError("AUTH_SESSION_MATERIAL_INVALID")
    }
  }

  // The session expires with the credential OR the grant, whichever is first —
  // the relay enforces this per request, so an expiring session is a bounded
  // stop, never a silent downgrade to unauthenticated traffic.
  const exp = Math.min(authorization.credentialExpiresAt.getTime(), options.grantExpiresAtMs)

  logger.info("Resolved authenticated-assessment session binding", {
    credentialId: authorization.credentialId,
    kind: authorization.credentialKind,
    hostCount: hosts.length,
    expiresAt: new Date(exp).toISOString(),
  })

  return { headers, hosts, exp }
}
