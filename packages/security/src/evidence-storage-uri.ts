import { relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Mirrors the ownership checks used by evidence reads and deletion. The S3
 * bucket and local root are supplied by the caller so this pure check can be
 * shared by the database erasure service and storage adapter without a
 * package dependency cycle.
 */
export function isEvidenceStorageUriForWorkspace(input: {
  storageUri: string
  workspaceId: string
  s3Bucket: string
  localEvidenceRoot: string
}): boolean {
  const { storageUri, workspaceId, s3Bucket, localEvidenceRoot } = input
  if (!workspaceId || workspaceId.includes("/") || workspaceId.includes("\\")) return false

  try {
    const parsed = new URL(storageUri)
    if (parsed.protocol === "s3:") {
      const key = parsed.pathname.slice(1)
      return parsed.hostname === s3Bucket && key.startsWith(`evidence/${workspaceId}/`)
    }

    if (parsed.protocol !== "file:") return false
    const path = resolve(fileURLToPath(parsed))
    const root = resolve(localEvidenceRoot)
    const pathFromRoot = relative(root, path)
    return (
      pathFromRoot !== "" &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      path.endsWith(".enc") &&
      pathFromRoot.startsWith(`evidence${sep}${workspaceId}${sep}`)
    )
  } catch {
    return false
  }
}
