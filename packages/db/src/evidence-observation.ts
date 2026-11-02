import { createHash } from "node:crypto"

// Evidence already indexes (findingId, createdAt, id). Scope new claim rows
// independently of their private URI so deleted or unreadable rows stay selectable.
export const CLAIM_OBSERVATION_PREFIX = "ctx-"
export function claimObservationPrefix(findingId: string, scanId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([findingId, scanId]))
    .digest("hex")
  return `${CLAIM_OBSERVATION_PREFIX}${digest}-`
}
