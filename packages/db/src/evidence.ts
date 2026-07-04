/**
 * Evidence encryption enforcement utilities.
 *
 * The Evidence model stores an `encryptionKeyRef` — a reference to the key
 * used to encrypt the evidence artifact at rest. This module provides helpers
 * to validate that evidence is properly encrypted before it is persisted
 * and before it is accessed.
 */

/**
 * Validate that an evidence record has a non-empty encryption key reference.
 * Throws if the key ref is missing or empty.
 */
export function assertEvidenceEncrypted(encryptionKeyRef: string | null | undefined): void {
  if (!encryptionKeyRef || encryptionKeyRef.trim().length === 0) {
    throw new EvidenceEncryptionError(
      "Evidence artifact must have an encryption key reference before storage",
    )
  }
}

/**
 * Check whether an evidence record is encrypted without throwing.
 */
export function isEvidenceEncrypted(encryptionKeyRef: string | null | undefined): boolean {
  return !!encryptionKeyRef && encryptionKeyRef.trim().length > 0
}

/**
 * Validate the format of an encryption key reference.
 * Key refs should follow the format: provider/key-name or provider/key-name/version
 * e.g. "kms/evidence-key", "vault/transit/audit-evidence/v2"
 */
export function isValidKeyRefFormat(keyRef: string): boolean {
  const parts = keyRef.split("/")
  if (parts.length < 2) return false
  // Each segment must be non-empty and contain only safe characters
  const safePattern = /^[a-zA-Z0-9_-]+$/
  return parts.every((part) => part.length > 0 && safePattern.test(part))
}

export class EvidenceEncryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EvidenceEncryptionError"
  }
}
