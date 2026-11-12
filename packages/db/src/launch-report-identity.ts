import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

type Binding = {
  workspaceId: string
  targetId: string
  verdictId: string
  verdictChecksum: string
  assessmentVersion: number | null
  identity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null
}

/** Private, per-report key prevents public commitment guessing or correlation. */
export function newLaunchReportBindingKey(): string {
  return randomBytes(32).toString("hex")
}

export function launchReportBindingKey(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const key = (value as Record<string, unknown>).identityBindingKey
  return typeof key === "string" && /^[a-f0-9]{64}$/.test(key) ? key : null
}

export function launchReportIdentityCommitment(key: string, binding: Binding): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(
      JSON.stringify([
        "lyrashield-launch-report-identity/1",
        binding.workspaceId,
        binding.targetId,
        binding.verdictId,
        binding.verdictChecksum,
        binding.assessmentVersion,
        binding.identity ? [binding.identity.kind, binding.identity.value] : null,
      ])
    )
    .digest("hex")
}

export function matchesLaunchReportIdentityCommitment(
  actual: unknown,
  key: string | null,
  binding: Binding
): boolean {
  if (!key || typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual)) return false
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(launchReportIdentityCommitment(key, binding), "hex")
  )
}
