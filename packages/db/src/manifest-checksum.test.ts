import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { verifyStoredManifestChecksum } from "./manifest-checksum"

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

describe("verifyStoredManifestChecksum", () => {
  it("matches exact checksum input when PostgreSQL JSONB reorders object keys", () => {
    const checksumInput = '{"zz":{"b":2,"a":1},"a":[{"y":true,"x":false},3]}'
    const jsonbManifest = {
      a: [{ x: false, y: true }, 3],
      zz: { a: 1, b: 2 },
    }

    expect(
      verifyStoredManifestChecksum({
        checksum: sha256(checksumInput),
        checksumInput,
        manifest: jsonbManifest,
      })
    ).toBe("MATCH")
  })

  it("rejects tampered input and structural changes including array reordering", () => {
    const checksumInput = '{"items":[1,2],"object":{"b":2,"a":1}}'
    const checksum = sha256(checksumInput)
    const manifest = { items: [1, 2], object: { a: 1, b: 2 } }

    expect(
      verifyStoredManifestChecksum({
        checksum,
        checksumInput: '{"items":[1,3],"object":{"b":2,"a":1}}',
        manifest,
      })
    ).toBe("MISMATCH")
    expect(
      verifyStoredManifestChecksum({
        checksum,
        checksumInput,
        manifest: { ...manifest, items: [2, 1] },
      })
    ).toBe("MISMATCH")
  })

  it("returns UNAVAILABLE for legacy rows without checksum input", () => {
    expect(
      verifyStoredManifestChecksum({
        checksum: "a".repeat(64),
        checksumInput: null,
        manifest: { version: 1 },
      })
    ).toBe("UNAVAILABLE")
  })
})
