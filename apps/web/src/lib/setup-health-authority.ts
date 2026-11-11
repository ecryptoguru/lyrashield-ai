import { createHmac } from "node:crypto"
import { canonicalJson, type SetupHealthScope } from "@lyrashield/types"

/** Internal inputs only. The projection returns keyed digests, never these values. */
export interface SetupAuthorityEvidence {
  intent: {
    workspaceId: string
    targetId: string
    goal: string
    mode: string
    workflow: string
    policyId: string | null
    engineBudgetCeilingUsd: number | null
    baseRef: string | null
    headRef: string | null
    attachmentIds: string[]
    authorizationRef: string | null
  } | null
  actor: unknown
  target: unknown
  connection?: unknown
  source?: unknown
  policy: unknown
  budget: unknown
  entitlement: unknown
  attachments: unknown
  authorization: unknown
  relay: unknown
  network?: unknown
  outcome?: unknown
}

function normalizedRef(ref: string | null): string | null {
  return ref && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref) ? ref.toLowerCase() : ref
}

function canonical(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value)))
}

export function buildSetupAuthorityProjection(
  evidence: SetupAuthorityEvidence,
  key: string
): { scope: SetupHealthScope; scopeFingerprint: string; complete: boolean } {
  if (!evidence.intent || !key) throw new Error("Setup authority inputs are unavailable")
  const intent = {
    ...evidence.intent,
    baseRef: normalizedRef(evidence.intent.baseRef),
    headRef: normalizedRef(evidence.intent.headRef),
    attachmentIds: [...new Set(evidence.intent.attachmentIds)].sort(),
  }
  const attachments = Array.isArray(evidence.attachments)
    ? [...evidence.attachments].sort((a, b) => {
        const left = canonical(a)
        const right = canonical(b)
        return left < right ? -1 : left > right ? 1 : 0
      })
    : evidence.attachments
  const digest = (label: string, value: unknown) =>
    createHmac("sha256", key)
      .update(canonical(["lyrashield-setup-authority/1.1.0", label, value]))
      .digest("hex")
  const observed = (value: unknown) => value !== "UNAVAILABLE" && value !== undefined
  const connectionReady =
    evidence.connection === null ||
    (typeof evidence.connection === "object" &&
      evidence.connection !== null &&
      "status" in evidence.connection &&
      evidence.connection.status === "active")
  const scope: SetupHealthScope = {
    workspaceId: intent.workspaceId,
    targetId: intent.targetId,
    goal: intent.goal,
    mode: intent.mode,
    workflow: intent.workflow,
    policyFingerprint:
      observed(evidence.policy) && evidence.policy !== null
        ? digest("policy", evidence.policy)
        : null,
    attachmentFingerprint:
      Array.isArray(attachments) && attachments.length > 0
        ? digest("attachments", attachments)
        : null,
    authorizationFingerprint:
      observed(evidence.authorization) && evidence.authorization !== null
        ? digest("authorization", evidence.authorization)
        : null,
    // Repository identities participate only in the keyed fingerprint.
    sourceRevision: null,
  }
  const complete =
    [
      evidence.actor,
      evidence.target,
      evidence.budget,
      evidence.entitlement,
      attachments,
      evidence.relay,
    ].every((value) => observed(value) && value !== null) &&
    [evidence.policy, evidence.authorization, evidence.network, evidence.source].every(observed) &&
    connectionReady
  return {
    scope,
    scopeFingerprint: digest("scope", { ...evidence, intent, attachments }),
    complete,
  }
}
