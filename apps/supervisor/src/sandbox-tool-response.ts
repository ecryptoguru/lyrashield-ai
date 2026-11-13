import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto"
import { z } from "zod"
import { canonicalJson, type BoundedConditionalObjectStore } from "@lyrashield/runtime-control"

const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
export const sandboxToolResponseBindingSchema = z
  .object({ attemptId: id, operationId: id, authorityEpochId: id, sandboxHandle: id })
  .strict()
const responseSchema = z
  .object({
    binding: sandboxToolResponseBindingSchema,
    requestId: z.string().uuid(),
    status: z.literal("COMPLETED"),
  })
  .passthrough()
const envelopeSchema = z
  .object({
    schema: z.literal("lyrashield-sandbox-tool-response/1"),
    nonce: z.string().regex(/^[a-f0-9]{24}$/),
    tag: z.string().regex(/^[a-f0-9]{32}$/),
    responseChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    ciphertext: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .max(34 * 1024 * 1024),
  })
  .strict()
const checksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024
const MAX_OBJECT_BYTES = 34 * 1024 * 1024
export type SandboxToolResponseBinding = z.infer<typeof sandboxToolResponseBindingSchema>
export type SandboxToolRetainedResponse = { responseChecksum: string; objectDigest: string }

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Encrypted, create-once terminal bytes; a retained value is not an authority grant. */
export class SandboxToolResponses {
  private readonly key: Buffer

  constructor(
    private readonly store: BoundedConditionalObjectStore,
    secret: string
  ) {
    if (Buffer.byteLength(secret, "utf8") < 32)
      throw new Error("sandbox response encryption key is unavailable")
    this.key = Buffer.from(
      hkdfSync("sha256", secret, "lyrashield-sandbox-tool-response/1", "aes-256-gcm", 32)
    )
  }

  private position(binding: SandboxToolResponseBinding, requestId: string) {
    const checked = sandboxToolResponseBindingSchema.parse(binding)
    const idValue = z.string().uuid().parse(requestId)
    return {
      binding: checked,
      requestId: idValue,
      key: `epochs/${checked.authorityEpochId}/sandbox-tool-responses/${checked.attemptId}/${idValue}`,
    }
  }

  private async read(
    position: ReturnType<SandboxToolResponses["position"]>,
    responseChecksum: string,
    objectDigest?: string
  ) {
    checksumSchema.parse(responseChecksum)
    if (objectDigest !== undefined) digestSchema.parse(objectDigest)
    const stored = await this.store.readBounded(position.key, MAX_OBJECT_BYTES)
    if (!stored || stored.bytes.byteLength > MAX_OBJECT_BYTES)
      throw new Error("retained sandbox response unavailable")
    const objectBytes = Buffer.from(stored.bytes)
    const actualObjectDigest = sha(objectBytes)
    if (objectDigest && actualObjectDigest !== objectDigest)
      throw new Error("retained sandbox response identity changed")
    try {
      const envelope = envelopeSchema.parse(JSON.parse(objectBytes.toString("utf8")))
      if (envelope.responseChecksum !== responseChecksum) throw new Error("invalid checksum")
      if (canonicalJson(envelope) !== objectBytes.toString("utf8"))
        throw new Error("invalid object")
      const cipherBytes = Buffer.from(envelope.ciphertext, "base64")
      if (cipherBytes.toString("base64") !== envelope.ciphertext) throw new Error("invalid base64")
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.nonce, "hex"))
      decipher.setAAD(
        Buffer.from(
          canonicalJson({
            binding: position.binding,
            requestId: position.requestId,
            responseChecksum,
          })
        )
      )
      decipher.setAuthTag(Buffer.from(envelope.tag, "hex"))
      const plaintext = Buffer.concat([decipher.update(cipherBytes), decipher.final()])
      if (
        plaintext.byteLength > MAX_RESPONSE_BYTES ||
        `sha256:${sha(plaintext)}` !== responseChecksum
      )
        throw new Error("invalid response")
      const parsed: unknown = JSON.parse(plaintext.toString("utf8"))
      const response = responseSchema.parse(parsed)
      if (
        canonicalJson(response) !== plaintext.toString("utf8") ||
        canonicalJson(response.binding) !== canonicalJson(position.binding) ||
        response.requestId !== position.requestId
      )
        throw new Error("invalid response binding")
      return { response, proof: { responseChecksum, objectDigest: actualObjectDigest } }
    } catch {
      throw new Error("retained sandbox response failed authentication")
    }
  }

  async retain(
    binding: SandboxToolResponseBinding,
    requestId: string,
    input: unknown
  ): Promise<SandboxToolRetainedResponse> {
    const position = this.position(binding, requestId)
    const response = responseSchema.parse(input)
    if (
      response.requestId !== position.requestId ||
      canonicalJson(response.binding) !== canonicalJson(position.binding)
    )
      throw new Error("sandbox response binding differs")
    const plaintext = Buffer.from(canonicalJson(response))
    if (plaintext.byteLength > MAX_RESPONSE_BYTES) throw new Error("sandbox response is too large")
    const responseChecksum = `sha256:${sha(plaintext)}`
    const existing = await this.store.readBounded(position.key, MAX_OBJECT_BYTES)
    if (existing) return (await this.read(position, responseChecksum)).proof
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce)
    cipher.setAAD(
      Buffer.from(
        canonicalJson({
          binding: position.binding,
          requestId: position.requestId,
          responseChecksum,
        })
      )
    )
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const encoded = Buffer.from(
      canonicalJson({
        schema: "lyrashield-sandbox-tool-response/1",
        nonce: nonce.toString("hex"),
        tag: cipher.getAuthTag().toString("hex"),
        responseChecksum,
        ciphertext: ciphertext.toString("base64"),
      })
    )
    const result = await this.store.put(position.key, encoded, { ifNoneMatch: true })
    if (result !== "written" && result !== "conflict")
      throw new Error("retained sandbox response write is uncertain")
    // Even a conflict is useful only when the exact bound response verifies.
    return (await this.read(position, responseChecksum)).proof
  }

  async load(
    binding: SandboxToolResponseBinding,
    requestId: string,
    proof: SandboxToolRetainedResponse
  ) {
    return (
      await this.read(this.position(binding, requestId), proof.responseChecksum, proof.objectDigest)
    ).response
  }

  async recover(binding: SandboxToolResponseBinding, requestId: string) {
    const position = this.position(binding, requestId)
    const stored = await this.store.readBounded(position.key, MAX_OBJECT_BYTES)
    if (!stored) throw new Error("retained sandbox response unavailable")
    let checksum: string
    try {
      checksum = envelopeSchema.parse(
        JSON.parse(Buffer.from(stored.bytes).toString("utf8"))
      ).responseChecksum
    } catch {
      throw new Error("retained sandbox response failed authentication")
    }
    return this.read(position, checksum, sha(stored.bytes))
  }
}
