import { createHash } from "crypto"

/**
 * Canonical dedupe identity — shared by the worker's generateDedupeKey and
 * the SARIF importer so a finding's key is stable no matter which surface
 * produced it. Version-prefixed; bump the prefix only on a breaking change.
 */
export interface DedupeIdentity {
  findingClass?: string
  /** Engine/OSV finding id — dependency fallback when no CVE exists. */
  id?: string | null
  cve?: string | null
  cwe?: string | null
  endpoint?: string | null
  method?: string | null
  file?: string | null
  startLine?: number | string | null
  endLine?: number | string | null
  title?: string | null
  /** Dependency findings key on package identity instead of location. */
  dependency?: {
    packageEcosystem?: string | null
    packageName?: string | null
  }
}

export function computeDedupeKey(identity: DedupeIdentity, targetId: string): string {
  const isDependency = Boolean(identity.dependency?.packageName)
  const parts = isDependency
    ? [
        "dependency",
        identity.cve ?? identity.id ?? "",
        identity.dependency?.packageEcosystem ?? "",
        identity.dependency?.packageName ?? "",
      ]
    : [
        identity.findingClass ?? "dynamic",
        identity.cve ?? "",
        identity.cwe ?? "",
        identity.endpoint ?? "",
        identity.method ?? "",
        identity.file ?? "",
        identity.startLine ?? "",
        identity.endLine ?? "",
        identity.title ?? "",
      ]
  const raw = ["v2", targetId, ...parts]
    .map((value) => String(value).trim().toLowerCase())
    .join("|")
  return createHash("sha256").update(raw).digest("hex").slice(0, 32)
}
