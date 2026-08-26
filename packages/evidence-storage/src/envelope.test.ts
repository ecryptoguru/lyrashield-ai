import { describe, it, expect } from "vitest"
import {
  ENVELOPE_KEY_REF,
  EvidenceEnvelopeError,
  isEnvelope,
  openEnvelope,
  readEnvelopeKeyRef,
  resolveEnvelopeKek,
  sealEnvelope,
  verifyEnvelopeShape,
} from "./envelope"

const TEST_KEK = resolveEnvelopeKek(Buffer.from(new Array(32).fill(7)).toString("base64"))
const OTHER_KEK = resolveEnvelopeKek(Buffer.from(new Array(32).fill(9)).toString("base64"))

describe("evidence envelope", () => {
  it("round-trips a plaintext through seal and open", () => {
    const plaintext = Buffer.from("proof-of-concept exploit output with secrets", "utf8")
    const envelope = sealEnvelope(plaintext, TEST_KEK, ENVELOPE_KEY_REF)

    expect(isEnvelope(envelope)).toBe(true)
    expect(verifyEnvelopeShape(envelope)).toBe(true)
    expect(readEnvelopeKeyRef(envelope)).toBe(ENVELOPE_KEY_REF)
    // The uploaded body must never contain the plaintext.
    expect(envelope.indexOf(plaintext)).toBe(-1)

    const opened = openEnvelope(envelope, TEST_KEK)
    expect(opened.plaintext.equals(plaintext)).toBe(true)
    expect(opened.keyRef).toBe(ENVELOPE_KEY_REF)
  })

  it("uses a fresh data key and nonces per object", () => {
    const plaintext = Buffer.from("same content")
    const a = sealEnvelope(plaintext, TEST_KEK, ENVELOPE_KEY_REF)
    const b = sealEnvelope(plaintext, TEST_KEK, ENVELOPE_KEY_REF)
    expect(a.equals(b)).toBe(false)
  })

  it("fails closed when the ciphertext is tampered with", () => {
    const envelope = sealEnvelope(Buffer.from("payload"), TEST_KEK, ENVELOPE_KEY_REF)
    envelope[envelope.length - 1] ^= 0xff
    expect(() => openEnvelope(envelope, TEST_KEK)).toThrow(EvidenceEnvelopeError)
  })

  it("fails closed when the header is tampered with", () => {
    const envelope = sealEnvelope(Buffer.from("payload"), TEST_KEK, ENVELOPE_KEY_REF)
    envelope[9] ^= 0xff // inside the JSON header
    expect(() => openEnvelope(envelope, TEST_KEK)).toThrow(EvidenceEnvelopeError)
  })

  it("fails closed when opened with the wrong KEK", () => {
    const envelope = sealEnvelope(Buffer.from("payload"), TEST_KEK, ENVELOPE_KEY_REF)
    expect(() => openEnvelope(envelope, OTHER_KEK)).toThrow(EvidenceEnvelopeError)
  })

  it("rejects non-envelope buffers in shape verification", () => {
    expect(isEnvelope(Buffer.from("plain text"))).toBe(false)
    expect(verifyEnvelopeShape(Buffer.from("plain text"))).toBe(false)
    expect(verifyEnvelopeShape(Buffer.from("LSEV1"))).toBe(false)
  })

  it("validates the KEK secret format", () => {
    expect(() => resolveEnvelopeKek(undefined)).toThrow(EvidenceEnvelopeError)
    expect(() => resolveEnvelopeKek("not-base64!!!")).toThrow(EvidenceEnvelopeError)
    expect(() => resolveEnvelopeKek(Buffer.from("short").toString("base64"))).toThrow(
      EvidenceEnvelopeError
    )
    expect(TEST_KEK.length).toBe(32)
  })
})
