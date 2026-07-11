import { describe, it, expect } from "vitest"
import { computeAuditHash, verifyAuditChain, type AuditLogChainFields } from "./audit-hash"
import {
  assertEvidenceEncrypted,
  isEvidenceEncrypted,
  isValidKeyRefFormat,
  EvidenceEncryptionError,
} from "./evidence"

describe("audit-hash", () => {
  const baseEntry: AuditLogChainFields = {
    id: "test-id-1",
    workspaceId: "ws-1",
    actorUserId: "user-1",
    action: "project.created",
    resourceType: "project",
    resourceId: "proj-1",
    ipAddress: "127.0.0.1",
    userAgent: "test-agent",
    metadata: { key: "value" },
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
  }

  describe("computeAuditHash", () => {
    it("produces a 64-char hex string", () => {
      const hash = computeAuditHash(baseEntry, null)
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it("produces different hashes for different prevHash values", () => {
      const h1 = computeAuditHash(baseEntry, null)
      const h2 = computeAuditHash(baseEntry, "previous-hash")
      expect(h1).not.toBe(h2)
    })

    it("produces different hashes for different entries", () => {
      const h1 = computeAuditHash(baseEntry, null)
      const h2 = computeAuditHash({ ...baseEntry, id: "test-id-2" }, null)
      expect(h1).not.toBe(h2)
    })

    it("is deterministic — same input produces same hash", () => {
      const h1 = computeAuditHash(baseEntry, "abc")
      const h2 = computeAuditHash(baseEntry, "abc")
      expect(h1).toBe(h2)
    })
  })

  describe("verifyAuditChain", () => {
    it("returns true for a valid chain", () => {
      const e1 = { ...baseEntry, hash: "", prevHash: null as string | null }
      e1.hash = computeAuditHash(e1, null)

      const e2 = { ...baseEntry, id: "test-id-2", hash: "", prevHash: e1.hash }
      e2.hash = computeAuditHash(e2, e2.prevHash)

      expect(verifyAuditChain([e1, e2])).toBe(true)
    })

    it("returns false when a hash is tampered", () => {
      const e1 = { ...baseEntry, hash: "tampered", prevHash: null as string | null }
      expect(verifyAuditChain([e1])).toBe(false)
    })

    it("returns false when prevHash chain is broken", () => {
      const e1 = { ...baseEntry, hash: "", prevHash: null as string | null }
      e1.hash = computeAuditHash(e1, null)

      const e2 = { ...baseEntry, id: "test-id-2", hash: "", prevHash: "wrong-prev" }
      e2.hash = computeAuditHash(e2, e2.prevHash)

      expect(verifyAuditChain([e1, e2])).toBe(false)
    })

    it("returns true for empty chain", () => {
      expect(verifyAuditChain([])).toBe(true)
    })
  })
})

describe("evidence", () => {
  describe("assertEvidenceEncrypted", () => {
    it("does not throw when key ref is provided", () => {
      expect(() => assertEvidenceEncrypted("kms/evidence-key")).not.toThrow()
    })

    it("throws when key ref is null", () => {
      expect(() => assertEvidenceEncrypted(null)).toThrow(EvidenceEncryptionError)
    })

    it("throws when key ref is undefined", () => {
      expect(() => assertEvidenceEncrypted(undefined)).toThrow(EvidenceEncryptionError)
    })

    it("throws when key ref is empty string", () => {
      expect(() => assertEvidenceEncrypted("")).toThrow(EvidenceEncryptionError)
    })

    it("throws when key ref is whitespace only", () => {
      expect(() => assertEvidenceEncrypted("   ")).toThrow(EvidenceEncryptionError)
    })
  })

  describe("isEvidenceEncrypted", () => {
    it("returns true for valid key ref", () => {
      expect(isEvidenceEncrypted("kms/key1")).toBe(true)
    })

    it("returns false for null", () => {
      expect(isEvidenceEncrypted(null)).toBe(false)
    })

    it("returns false for empty string", () => {
      expect(isEvidenceEncrypted("")).toBe(false)
    })
  })

  describe("isValidKeyRefFormat", () => {
    it("accepts provider/key format", () => {
      expect(isValidKeyRefFormat("kms/evidence-key")).toBe(true)
    })

    it("accepts provider/key/version format", () => {
      expect(isValidKeyRefFormat("vault/transit/audit-v2")).toBe(true)
    })

    it("rejects single segment", () => {
      expect(isValidKeyRefFormat("key")).toBe(false)
    })

    it("rejects empty segments", () => {
      expect(isValidKeyRefFormat("kms/")).toBe(false)
    })

    it("rejects unsafe characters", () => {
      expect(isValidKeyRefFormat("kms/key with spaces")).toBe(false)
    })
  })
})
