/**
 * Envelope encryption for evidence artifacts.
 *
 * Every artifact is sealed with a fresh 256-bit data key (AES-256-GCM). The
 * data key itself is encrypted under a key-encryption key (KEK) resolved from
 * the operator-configured `LYRASHIELD_EVIDENCE_KEK` secret, and the wrapped
 * data key travels WITH the object in a self-describing binary header:
 *
 *   "LSEV1" <u16 header length BE> <UTF-8 JSON header> <ciphertext>
 *
 * The header carries both GCM nonces and tags, the algorithm ids, and the key
 * reference that identifies which KEK version unwraps the data key — so a
 * future KEK rotation or a move to an external KMS/Vault only changes
 * `resolveEnvelopeKek` and the emitted key ref, never the object format.
 *
 * Provider-managed server-side encryption (SSE) remains enabled where the
 * store supports it as defense in depth, but it is no longer the only
 * encryption layer: a storage-operator compromise no longer exposes evidence
 * plaintexts (PoC exploit code, request/response captures, live secrets).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"

const ENVELOPE_MAGIC = "LSEV1"
const ENVELOPE_KEY_INFO = "lyrashield-evidence-kek-v1"
const ENVELOPE_KEK_BYTES = 32
const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16

/** Key reference recorded with new envelope-encrypted artifacts. */
export const ENVELOPE_KEY_REF = "envkeystore/lyrashield-evidence-kek/v1"

interface EnvelopeHeader {
  v: 1
  alg: "A256GCM"
  wrap: "A256GCM"
  keyRef: string
  /** base64(wrapped data key ciphertext || GCM tag) */
  dek: string
  /** base64 wrap nonce */
  wn: string
  /** base64 body nonce */
  n: string
  /** base64 body GCM tag */
  t: string
}

export class EvidenceEnvelopeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "EvidenceEnvelopeError"
  }
}

/** True when the buffer starts with the envelope magic prefix. */
export function isEnvelope(buffer: Buffer): boolean {
  return buffer.subarray(0, ENVELOPE_MAGIC.length).toString("latin1") === ENVELOPE_MAGIC
}

/**
 * Resolve the key-encryption key from the configured secret. The env value is
 * a base64-encoded 32-byte random key; HKDF derives the purpose-specific KEK
 * so the same operator secret reused elsewhere cannot be crossed with
 * evidence keys.
 */
export function resolveEnvelopeKek(baseKeySecret: string | undefined): Buffer {
  if (!baseKeySecret) {
    throw new EvidenceEnvelopeError("LYRASHIELD_EVIDENCE_KEK is not configured")
  }
  let raw: Buffer
  try {
    raw = Buffer.from(baseKeySecret, "base64")
  } catch {
    throw new EvidenceEnvelopeError("LYRASHIELD_EVIDENCE_KEK is not valid base64")
  }
  if (raw.length !== ENVELOPE_KEK_BYTES) {
    throw new EvidenceEnvelopeError(
      `LYRASHIELD_EVIDENCE_KEK must decode to ${ENVELOPE_KEK_BYTES} bytes (got ${raw.length})`
    )
  }
  return Buffer.from(hkdfSync("sha256", raw, "", ENVELOPE_KEY_INFO, ENVELOPE_KEK_BYTES))
}

function aesGcmSeal(key: Buffer, nonce: Buffer, plaintext: Buffer): { ciphertext: Buffer; tag: Buffer } {
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { ciphertext, tag: cipher.getAuthTag() }
}

function aesGcmOpen(key: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** Seal a plaintext into the self-describing envelope format. */
export function sealEnvelope(plaintext: Buffer, kek: Buffer, keyRef: string): Buffer {
  const dataKey = randomBytes(ENVELOPE_KEK_BYTES)
  const wrapNonce = randomBytes(GCM_NONCE_BYTES)
  const bodyNonce = randomBytes(GCM_NONCE_BYTES)

  const wrapped = aesGcmSeal(kek, wrapNonce, dataKey)
  const body = aesGcmSeal(dataKey, bodyNonce, plaintext)

  const header: EnvelopeHeader = {
    v: 1,
    alg: "A256GCM",
    wrap: "A256GCM",
    keyRef,
    dek: Buffer.concat([wrapped.ciphertext, wrapped.tag]).toString("base64"),
    wn: wrapNonce.toString("base64"),
    n: bodyNonce.toString("base64"),
    t: body.tag.toString("base64"),
  }
  const headerJson = Buffer.from(JSON.stringify(header), "utf8")
  if (headerJson.length > 0xffff) {
    throw new EvidenceEnvelopeError("Envelope header exceeds size limit")
  }

  const prefix = Buffer.alloc(ENVELOPE_MAGIC.length + 2)
  prefix.write(ENVELOPE_MAGIC, 0, "latin1")
  prefix.writeUInt16BE(headerJson.length, ENVELOPE_MAGIC.length)
  return Buffer.concat([prefix, headerJson, body.ciphertext])
}

function parseEnvelope(buffer: Buffer): { header: EnvelopeHeader; ciphertext: Buffer } {
  if (!isEnvelope(buffer)) {
    throw new EvidenceEnvelopeError("Buffer is not an evidence envelope")
  }
  const headerLength = buffer.readUInt16BE(ENVELOPE_MAGIC.length)
  const headerStart = ENVELOPE_MAGIC.length + 2
  const headerEnd = headerStart + headerLength
  if (headerEnd > buffer.length) {
    throw new EvidenceEnvelopeError("Envelope header is truncated")
  }
  let header: EnvelopeHeader
  try {
    header = JSON.parse(buffer.subarray(headerStart, headerEnd).toString("utf8")) as EnvelopeHeader
  } catch (err) {
    throw new EvidenceEnvelopeError("Envelope header is not valid JSON", { cause: err })
  }
  if (
    header.v !== 1 ||
    header.alg !== "A256GCM" ||
    header.wrap !== "A256GCM" ||
    !header.keyRef ||
    !header.dek ||
    !header.wn ||
    !header.n ||
    !header.t
  ) {
    throw new EvidenceEnvelopeError("Envelope header is missing required fields")
  }
  return { header, ciphertext: buffer.subarray(headerEnd) }
}

/**
 * Structural verification that a buffer is a parseable envelope. Used at write
 * time so an unencrypted (or corrupted) body can never be persisted under an
 * envelope key reference.
 */
export function verifyEnvelopeShape(buffer: Buffer): boolean {
  try {
    const { header, ciphertext } = parseEnvelope(buffer)
    const dek = Buffer.from(header.dek, "base64")
    const wn = Buffer.from(header.wn, "base64")
    const n = Buffer.from(header.n, "base64")
    const t = Buffer.from(header.t, "base64")
    return (
      dek.length === ENVELOPE_KEK_BYTES + GCM_TAG_BYTES &&
      wn.length === GCM_NONCE_BYTES &&
      n.length === GCM_NONCE_BYTES &&
      t.length === GCM_TAG_BYTES &&
      ciphertext.length > 0
    )
  } catch {
    return false
  }
}

/**
 * Open an envelope produced by `sealEnvelope`. Throws `EvidenceEnvelopeError`
 * on any tampering — the wrapped-data-key and body GCM tags both fail closed.
 */
export function openEnvelope(buffer: Buffer, kek: Buffer): { plaintext: Buffer; keyRef: string } {
  const { header, ciphertext } = parseEnvelope(buffer)
  const wrapped = Buffer.from(header.dek, "base64")
  const wrapNonce = Buffer.from(header.wn, "base64")
  const bodyNonce = Buffer.from(header.n, "base64")
  const bodyTag = Buffer.from(header.t, "base64")

  let dataKey: Buffer
  let plaintext: Buffer
  try {
    dataKey = aesGcmOpen(
      kek,
      wrapNonce,
      wrapped.subarray(0, wrapped.length - GCM_TAG_BYTES),
      wrapped.subarray(wrapped.length - GCM_TAG_BYTES)
    )
    plaintext = aesGcmOpen(dataKey, bodyNonce, ciphertext, bodyTag)
  } catch (err) {
    throw new EvidenceEnvelopeError("Evidence envelope failed authentication (tampered or wrong key)", {
      cause: err,
    })
  }
  return { plaintext, keyRef: header.keyRef }
}
