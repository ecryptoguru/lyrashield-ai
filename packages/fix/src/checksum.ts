/**
 * Content addressing for fix patches. The diff checksum is what the approval
 * binds to — change one byte of the diff and the approval can no longer
 * authorize it. This is what makes a replayed or tampered patch unclaimable.
 */

import { createHash } from "node:crypto"

/** SHA-256 over the exact diff text that will be applied. */
export function diffChecksum(diff: string): string {
  return createHash("sha256").update(diff, "utf8").digest("hex")
}
