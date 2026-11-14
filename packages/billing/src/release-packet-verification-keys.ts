import { env } from "@lyrashield/config"
import { releasePacketSigningKeyId, type ReleasePacketVerificationKey } from "@lyrashield/db"
import { z } from "zod"
import { resolveLaunchReportSigningPublicKey } from "./launch-report-keys"

const KeyringSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(128),
        publicKey: z.string().min(1).max(4096),
        revoked: z.boolean(),
      })
      .strict()
  )
  .max(32)

/** Explicit keyrings are authoritative; a revoked or missing key never falls back to the current key. */
export async function resolveReleasePacketVerificationKeys(): Promise<
  ReleasePacketVerificationKey[]
> {
  const configured = env.RELEASE_PACKET_VERIFICATION_KEYS_JSON
  if (configured) {
    const keys = KeyringSchema.parse(JSON.parse(configured))
    if (
      new Set(keys.map((key) => key.id)).size !== keys.length ||
      keys.some((key) => releasePacketSigningKeyId(key.publicKey) !== key.id)
    ) {
      throw new Error("Release packet verification keyring contains invalid or duplicate keys")
    }
    return keys
  }
  const current = await resolveLaunchReportSigningPublicKey()
  return current
    ? [{ id: releasePacketSigningKeyId(current), publicKey: current, revoked: false }]
    : []
}
