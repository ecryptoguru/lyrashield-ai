/// <reference types="webmcp-types" />

import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

export function sha256Sync(input: string): string {
  return bytesToHex(nobleSha256(new TextEncoder().encode(input)))
}

export async function sha256(input: string): Promise<string> {
  return sha256Sync(input)
}
