export type ReleasePacketIdentity =
  { kind: "COMMIT"; value: string } | { kind: "ARTIFACT_DIGEST"; value: string }

export type ReleasePacketQuery =
  | { status: "ready"; targetId: string; identity: ReleasePacketIdentity }
  | { status: "invalid"; reason: string }

export function parseReleasePacketSearchParams(
  params: Record<string, string | string[] | undefined>
): ReleasePacketQuery {
  const targetId = typeof params.targetId === "string" ? params.targetId.trim() : ""
  const commit = typeof params.commit === "string" ? params.commit.trim() : ""
  const artifactDigest =
    typeof params.artifactDigest === "string" ? params.artifactDigest.trim() : ""
  if (!targetId) return { status: "invalid", reason: "A target is required." }
  if (Boolean(commit) === Boolean(artifactDigest)) {
    return { status: "invalid", reason: "Supply exactly one full commit or artifact digest." }
  }
  if (commit) {
    if (!/^[a-f0-9]{40}$/i.test(commit)) {
      return { status: "invalid", reason: "The commit must be a full 40-character SHA." }
    }
    return { status: "ready", targetId, identity: { kind: "COMMIT", value: commit.toLowerCase() } }
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(artifactDigest)) {
    return {
      status: "invalid",
      reason: "The artifact digest must use sha256: followed by 64 hex characters.",
    }
  }
  return {
    status: "ready",
    targetId,
    identity: { kind: "ARTIFACT_DIGEST", value: artifactDigest.toLowerCase() },
  }
}
