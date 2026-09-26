import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

export type StoredManifestChecksumStatus = "MATCH" | "MISMATCH" | "UNAVAILABLE"

type StoredManifestChecksum = {
  checksum: string
  checksumInput: string | null
  manifest: unknown
}

export function verifyStoredManifestChecksum(
  stored: StoredManifestChecksum | null | undefined
): StoredManifestChecksumStatus {
  if (!stored || stored.checksumInput == null) return "UNAVAILABLE"
  if (!/^[0-9a-f]{64}$/.test(stored.checksum)) return "MISMATCH"

  const checksum = createHash("sha256").update(stored.checksumInput).digest("hex")
  if (checksum !== stored.checksum) return "MISMATCH"

  try {
    return isDeepStrictEqual(JSON.parse(stored.checksumInput), stored.manifest)
      ? "MATCH"
      : "MISMATCH"
  } catch {
    return "MISMATCH"
  }
}
