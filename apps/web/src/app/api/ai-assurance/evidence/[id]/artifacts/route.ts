import { withCookieMutation } from "../../../../../../lib/api-auth"
import { randomUUID } from "node:crypto"
import {
  addControlEvidenceArtifacts,
  prisma,
  type ArtifactManifestItem,
  type ControlEvidenceVersionSummary,
} from "@lyrashield/db"
import { deleteEncryptedArtifact, uploadEncryptedArtifact } from "@lyrashield/evidence-storage"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { toPublicControlEvidenceItem } from "@/lib/ai-assurance"

const ALLOWED_FILES = new Map([
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".txt", "text/plain"],
])
const MAX_FILE_BYTES = 20 * 1024 * 1024

function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

function filenameFromRequest(request: Request): string {
  const value = request.headers.get("x-lyrashield-artifact-filename")
  if (!value) throw new Error("EVIDENCE_ARTIFACT_FILENAME_INVALID")
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error("EVIDENCE_ARTIFACT_FILENAME_INVALID")
  }
}

function validateUpload(filename: string, mediaType: string, byteLength: number): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(filename)) {
    throw new Error("EVIDENCE_ARTIFACT_FILENAME_INVALID")
  }
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase()
  if (ALLOWED_FILES.get(extension) !== mediaType) {
    throw new Error("EVIDENCE_ARTIFACT_MEDIA_TYPE_INVALID")
  }
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > MAX_FILE_BYTES) {
    throw new Error("EVIDENCE_ARTIFACT_SIZE_EXCEEDED")
  }
}

async function readBodyWithinLimit(request: Request): Promise<Buffer> {
  const declaredLength = request.headers.get("content-length")
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_FILE_BYTES)) {
    throw new Error("EVIDENCE_ARTIFACT_SIZE_EXCEEDED")
  }
  if (!request.body) throw new Error("EVIDENCE_ARTIFACT_REQUIRED")

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_FILE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error("EVIDENCE_ARTIFACT_SIZE_EXCEEDED")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, byteLength)
}

async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: evidenceId } = await params
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId")
    if (!workspaceId) {
      return privateResponse(apiError("MISSING_PARAM", "workspaceId is required", 400))
    }

    // Authenticate before reading the potentially large artifact stream.
    const { session } = await requirePermission(workspaceId, PERMISSIONS.aiAssurance.manage)
    const evidence = await prisma.controlEvidence.findFirst({
      where: { id: evidenceId, workspaceId },
      select: { id: true, workspaceId: true, targetId: true, controlId: true },
    })
    if (!evidence) {
      return privateResponse(apiError("EVIDENCE_NOT_FOUND", "Evidence not found in this workspace", 404))
    }

    const filename = filenameFromRequest(request)
    const mediaType = request.headers.get("content-type") ?? ""
    const content = await readBodyWithinLimit(request)
    validateUpload(filename, mediaType, content.byteLength)

    const artifactId = randomUUID()
    let stored: Awaited<ReturnType<typeof uploadEncryptedArtifact>> | null = null
    try {
      stored = await uploadEncryptedArtifact({
        workspaceId,
        ownerId: session.userId,
        type: "control-evidence",
        namespace: `evidence-${evidenceId}`,
        artifactId,
        content,
        contentType: mediaType,
      })
      const manifestItems: ArtifactManifestItem[] = [{ id: artifactId, filename, mediaType, ...stored }]
      const version: ControlEvidenceVersionSummary = await addControlEvidenceArtifacts({
        workspaceId,
        evidenceId,
        manifestItems,
        createdById: session.userId,
      })
      return privateResponse(
        apiSuccess(toPublicControlEvidenceItem({ ...evidence, currentVersion: version }), 201)
      )
    } catch (error) {
      if (stored) {
        await Promise.resolve(deleteEncryptedArtifact(stored.storageUri, workspaceId)).catch(() => {
          logger.error("Failed to compensate evidence artifact upload", { artifactId })
        })
      }
      throw error
    }
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return privateResponse(authErr)
    const code = error instanceof Error ? error.message : ""
    if (code.startsWith("EVIDENCE_ARTIFACT_")) {
      return privateResponse(
        apiError(code, "Evidence artifacts must be allowed types with safe names within the upload limits", 400)
      )
    }
    logger.error("Failed to add evidence artifacts", { error: String(error) })
    return privateResponse(apiError("INTERNAL_ERROR", "Failed to add evidence artifacts", 500))
  }
}

export const POST = withCookieMutation(post)
