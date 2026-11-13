import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto"
import { z } from "zod"
import { canonicalJson } from "@lyrashield/runtime-control"
import { ProviderGatewayError } from "./errors"

export const retainedResponseSchema = z
  .object({
    version: z.literal(1),
    nonce: z.string().regex(/^[a-f0-9]{24}$/),
    tag: z.string().regex(/^[a-f0-9]{32}$/),
    ciphertext: z.string().max(8 * 1024 * 1024),
  })
  .strict()
export type RetainedResponse = z.infer<typeof retainedResponseSchema>

const payloadSchema = z
  .object({
    statusCode: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string().max(1_024)),
    body: z.string().max(6 * 1024 * 1024),
  })
  .strict()

function key(secret: string): Buffer {
  if (Buffer.byteLength(secret) < 32)
    throw new Error("response encryption key must be at least 32 bytes")
  return Buffer.from(
    hkdfSync("sha256", secret, "lyrashield-provider-response-v1", "aes-256-gcm", 32)
  )
}

export function retainResponse(
  secret: string,
  binding: unknown,
  response: { statusCode: number; headers: Record<string, string>; body: Buffer }
): RetainedResponse {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(secret), nonce)
  cipher.setAAD(Buffer.from(canonicalJson(binding)))
  const payload = payloadSchema.parse({ ...response, body: response.body.toString("base64") })
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()])
  return {
    version: 1,
    nonce: nonce.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("base64"),
  }
}

export function replayResponse(
  secret: string,
  binding: unknown,
  retained: RetainedResponse,
  expected: { responseHash?: string; responseBytes?: number; statusCode?: number }
) {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(secret),
      Buffer.from(retained.nonce, "hex")
    )
    decipher.setAAD(Buffer.from(canonicalJson(binding)))
    decipher.setAuthTag(Buffer.from(retained.tag, "hex"))
    const raw = Buffer.concat([
      decipher.update(Buffer.from(retained.ciphertext, "base64")),
      decipher.final(),
    ])
    const response = payloadSchema.parse(JSON.parse(raw.toString("utf8")))
    const body = Buffer.from(response.body, "base64")
    if (
      createHash("sha256").update(body).digest("hex") !== expected.responseHash ||
      body.byteLength !== expected.responseBytes ||
      response.statusCode !== expected.statusCode
    )
      throw new Error("response identity mismatch")
    return { ...response, body }
  } catch {
    throw new ProviderGatewayError(
      "REQUEST_UNKNOWN",
      "retained provider response cannot be authenticated",
      409
    )
  }
}
