import { z } from "zod"
import { canonicalJson } from "./json"

export const LEGACY_RELEASE_PACKET_VERSION = "release_packet/1.0.0" as const
export const RELEASE_PACKET_VERSION = "release_packet/1.1.0" as const

export const ReleasePacketIdentitySchema = z.object({
  kind: z.enum(["COMMIT", "ARTIFACT_DIGEST"]),
  value: z.string(),
})

export const SignedAssessmentSchema = z.object({
  state: z.enum(["SIGNED", "UNSIGNED", "UNAVAILABLE", "INVALID", "HISTORICAL"]),
  reportId: z.string().optional(),
  reportChecksum: z.string().optional(),
  signature: z.string().optional(),
  signingKeyId: z.string().optional(),
  verifiedAt: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  reason: z.string().max(500).optional(),
})

export const ReleasePacketFindingSchema = z.object({
  category: z.enum(["new", "recurring", "resolved", "uncertain"]),
  findingId: z.string(),
  dedupeKey: z.string(),
  title: z.string(),
  severity: z.string(),
  status: z.string(),
  verificationStatus: z.string(),
  sourceRevision: z.string().nullable(),
  evidenceHref: z.string(),
  retestState: z.enum(["trusted", "pending", "failed", "unsupported", "none"]),
  proposalState: z.enum(["current", "stale", "unknown", "none"]),
})

export const ReleasePacketPayloadSchema = z
  .object({
    version: z.enum([LEGACY_RELEASE_PACKET_VERSION, RELEASE_PACKET_VERSION]),
    packetChecksum: z.string().regex(/^[a-f0-9]{64}$/i),
    expiresAt: z.string().datetime().optional(),
    signingKeyId: z.string().min(1).nullable().optional(),
    packetSignature: z.string().min(1).nullable().optional(),
    generatedAt: z.string(),
    target: z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      environment: z.string().nullable(),
    }),
    assessment: z.object({
      verdictId: z.string(),
      standardVersion: z.string(),
      state: z.enum(["READY", "NOT_READY", "INSUFFICIENT_EVIDENCE"]),
      historicalState: z.enum(["READY", "NOT_READY", "INSUFFICIENT_EVIDENCE"]),
      applicable: z.boolean(),
      reasons: z.array(z.object({ code: z.string(), message: z.string() })),
      evaluatedAt: z.string(),
      assessedIdentity: ReleasePacketIdentitySchema.nullable(),
      coverageStatement: z.array(z.string()),
      nonCoverage: z.array(
        z.object({ controlId: z.string(), scanner: z.string(), reason: z.string().nullable() })
      ),
    }),
    signedAssessment: SignedAssessmentSchema,
    remediation: z.object({
      baselineScanId: z.string().nullable(),
      currentScanId: z.string(),
      counts: z.object({
        newFindings: z.number().int().nonnegative(),
        recurringFindings: z.number().int().nonnegative(),
        resolvedFindings: z.number().int().nonnegative(),
        uncertainMatches: z.number().int().nonnegative(),
      }),
      findings: z.array(ReleasePacketFindingSchema),
      truncated: z.boolean(),
    }),
    coverage: z.object({
      completed: z.array(z.string()),
      notApplicable: z.array(z.string()),
      incomplete: z.array(z.string()),
      manifestChecksum: z.string().nullable(),
    }),
  })
  .superRefine((packet, ctx) => {
    if (packet.version === RELEASE_PACKET_VERSION) {
      if (
        !packet.expiresAt ||
        packet.signingKeyId === undefined ||
        packet.packetSignature === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Version 1.1 requires packet expiry and signing metadata",
        })
      }
      if (packet.packetSignature && !packet.signingKeyId) {
        ctx.addIssue({ code: "custom", message: "A signed packet requires a signing key ID" })
      }
      const generatedAt = Date.parse(packet.generatedAt)
      if (
        !Number.isFinite(generatedAt) ||
        (packet.expiresAt && Date.parse(packet.expiresAt) > generatedAt + 24 * 60 * 60 * 1000)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Packet validity cannot exceed 24 hours from generation",
        })
      }
      if (
        packet.expiresAt &&
        packet.signedAssessment.expiresAt &&
        Date.parse(packet.expiresAt) > Date.parse(packet.signedAssessment.expiresAt)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Packet expiry cannot exceed the bound assessment expiry",
        })
      }
    } else if (
      packet.expiresAt !== undefined ||
      packet.signingKeyId !== undefined ||
      packet.packetSignature !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Historical packets cannot contain version 1.1 signing fields",
      })
    }
  })

export type ReleasePacketPayload = z.infer<typeof ReleasePacketPayloadSchema>
export type ReleasePacketFinding = z.infer<typeof ReleasePacketFindingSchema>
export type SignedAssessment = z.infer<typeof SignedAssessmentSchema>

export async function computeReleasePacketChecksum(
  payload: Omit<ReleasePacketPayload, "packetChecksum" | "packetSignature"> & {
    packetChecksum?: string
    packetSignature?: string | null
  }
): Promise<string> {
  const signedPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== "packetChecksum" && key !== "packetSignature")
  )
  const bytes = new TextEncoder().encode(canonicalJson(JSON.parse(JSON.stringify(signedPayload))))
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export const releasePacketPayloadSchema = ReleasePacketPayloadSchema
