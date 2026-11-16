import { createHash } from "node:crypto"
import { z } from "zod"
import {
  SCAN_ATTACHMENT_MAX_BYTES,
  SCAN_ATTACHMENT_MAX_TOTAL_BYTES,
  SCAN_ATTACHMENT_MAX_COUNT,
} from "@lyrashield/types"

const sourceSchema = z.object({
  workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/),
  target: z.object({
    installationId: z.string().regex(/^[1-9][0-9]*$/),
    repoFullName: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  }),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        workspaceId: z.string(),
        storageUri: z.string(),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
        encryptionKeyRef: z.string().min(1),
        byteLength: z.number().int().nonnegative().max(SCAN_ATTACHMENT_MAX_BYTES),
      })
    )
    .max(SCAN_ATTACHMENT_MAX_COUNT),
})

/** Only root's authenticated persisted metadata enters this SDK acquisition path. */
export async function acquirePreparationArtifacts(input: unknown) {
  const source = sourceSchema.parse(input)
  if (
    !Number.isSafeInteger(Number(source.target.installationId)) ||
    source.target.repoFullName.split("/").some((part) => part === "." || part === "..") ||
    source.attachments.some((item) => item.workspaceId !== source.workspaceId) ||
    new Set(source.attachments.map((item) => item.id)).size !== source.attachments.length ||
    source.attachments.reduce((sum, item) => sum + item.byteLength, 0) >
      SCAN_ATTACHMENT_MAX_TOTAL_BYTES
  )
    throw new Error("Attachment source authority unavailable")
  const { getRepositoryReadToken } = await import("@lyrashield/integrations")
  const token = await getRepositoryReadToken(
    Number(source.target.installationId),
    source.target.repoFullName
  )
  const attachmentBytes = []
  if (source.attachments.length) {
    const { readEncryptedArtifact } = await import("@lyrashield/evidence-storage")
    for (const item of source.attachments) {
      const artifact = await readEncryptedArtifact(item.storageUri, source.workspaceId)
      if (
        artifact.legacy ||
        artifact.checksum !== item.checksum ||
        artifact.encryptionKeyRef !== item.encryptionKeyRef ||
        artifact.content.byteLength !== item.byteLength ||
        createHash("sha256").update(artifact.content).digest("hex") !== item.checksum
      )
        throw new Error("Attachment source integrity unavailable")
      attachmentBytes.push({ id: item.id, content: artifact.content.toString("base64") })
    }
  }
  return { token, attachmentBytes }
}
