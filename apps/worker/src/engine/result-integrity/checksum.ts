import { createHash } from "crypto"

export function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
