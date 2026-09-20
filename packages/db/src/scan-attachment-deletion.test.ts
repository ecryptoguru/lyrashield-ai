import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { createId } from "@paralleldrive/cuid2"
import { prisma } from "./client"
import { withWorkspaceRLS } from "./rls"
import {
  claimArtifactDeletionTask,
  completeArtifactDeletionTask,
  failArtifactDeletionTask,
} from "./artifact-deletion"
import { softDeleteScanAttachment } from "./scan-attachment-service"

/**
 * Durable deletion outbox for scan attachments (v20 2.1).
 *
 * softDeleteScanAttachment commits the soft delete AND the outbox task in one
 * transaction, so a storage failure after commit — exactly what the delete
 * route tolerates — still leaves a retryable task. The enqueue function
 * authorizes only a ScanAttachment URI inside the bound workspace; Evidence
 * URIs and foreign attachments are rejected, keeping kinds narrow.
 */

const suffix = randomUUID().replace(/-/g, "")
const workspaceId = `att-outbox-ws-${suffix}`
const otherWorkspaceId = `att-outbox-other-${suffix}`
const attachmentStorageUri = `s3://evidence-test/evidence/${workspaceId}/scan-attachments/user/${createId()}-${suffix.slice(0, 16)}`
const evidenceStorageUri = `s3://evidence-test/evidence/${workspaceId}/finding/${createId()}-${suffix.slice(0, 16)}`
const foreignStorageUri = `s3://evidence-test/evidence/${otherWorkspaceId}/scan-attachments/user/${createId()}-${suffix.slice(0, 16)}`

beforeAll(async () => {
  await prisma.workspace.create({
    data: { id: workspaceId, name: "Attachment outbox owner", slug: workspaceId },
  })
  await prisma.workspace.create({
    data: { id: otherWorkspaceId, name: "Attachment outbox other", slug: otherWorkspaceId },
  })
  await prisma.scanAttachment.create({
    data: {
      workspaceId,
      filename: "notes.txt",
      mediaType: "text/plain",
      byteLength: 32,
      checksum: suffix.padEnd(64, "0").slice(0, 64),
      storageUri: attachmentStorageUri,
      encryptionKeyRef: "envkeystore/lyrashield-evidence-kek/v1",
      createdById: `att-user-${suffix}`,
    },
  })
  await prisma.scanAttachment.create({
    data: {
      workspaceId: otherWorkspaceId,
      filename: "foreign.txt",
      mediaType: "text/plain",
      byteLength: 16,
      checksum: suffix.padEnd(64, "f").slice(0, 64),
      storageUri: foreignStorageUri,
      encryptionKeyRef: "envkeystore/lyrashield-evidence-kek/v1",
      createdById: `att-user-${suffix}`,
    },
  })
  const target = await prisma.target.create({
    data: { workspaceId, type: "WEB_APP", name: "Attachment outbox target" },
  })
  const scan = await prisma.scan.create({
    data: {
      workspaceId,
      targetId: target.id,
      goal: "LAUNCH_REVIEW",
      status: "COMPLETED",
      createdById: `att-user-${suffix}`,
    },
  })
  const finding = await prisma.finding.create({
    data: {
      workspaceId,
      targetId: target.id,
      scanId: scan.id,
      title: "Attachment outbox evidence parent",
      summary: "Fixture so an Evidence URI exists in the same workspace.",
      severity: "LOW",
      dedupeKey: `att-outbox-${suffix}`,
    },
  })
  await prisma.evidence.create({
    data: { findingId: finding.id, type: "receipt", storageUri: evidenceStorageUri },
  })
})

afterAll(async () => {
  await prisma.artifactDeletionTask
    .deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
    .catch(() => {})
  for (const id of [workspaceId, otherWorkspaceId]) {
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${id}`.catch(() => {})
  }
})

describe("scan attachment deletion outbox", () => {
  it("commits a durable SCAN_ATTACHMENT task with the soft delete so a storage failure stays retryable", async () => {
    const attachment = await prisma.scanAttachment.create({
      data: {
        workspaceId,
        filename: "durable.txt",
        mediaType: "text/plain",
        byteLength: 64,
        checksum: suffix.padEnd(64, "a").slice(0, 64),
        storageUri: `s3://evidence-test/evidence/${workspaceId}/scan-attachments/user/${createId()}-durable`,
        encryptionKeyRef: "envkeystore/lyrashield-evidence-kek/v1",
        createdById: `att-user-${suffix}`,
      },
    })

    const removed = await softDeleteScanAttachment(workspaceId, attachment.id)
    expect(removed).not.toBeNull()

    // The soft delete committed and the row can never be attached to a new
    // scan — and the object deletion is already durable regardless of what
    // the route's best-effort storage call does next.
    const task = await prisma.artifactDeletionTask.findUnique({
      where: { kind_storageUri: { kind: "SCAN_ATTACHMENT", storageUri: removed!.storageUri } },
    })
    expect(task).toMatchObject({ workspaceId, status: "PENDING", kind: "SCAN_ATTACHMENT" })

    // The drain path: claim, fail with a storage error, then prove the task
    // remains retryable instead of being lost.
    const claimed = await claimArtifactDeletionTask([task!.id])
    expect(claimed).toMatchObject({
      id: task!.id,
      status: "PROCESSING",
      kind: "SCAN_ATTACHMENT",
      storageUri: removed!.storageUri,
    })
    expect(await failArtifactDeletionTask(claimed!, new Error("object store unavailable"))).toBe(
      "retry"
    )
    const after = await prisma.artifactDeletionTask.findUnique({ where: { id: task!.id } })
    expect(after).toMatchObject({ status: "PENDING", lastError: "object store unavailable" })

    const reclaimed = await claimArtifactDeletionTask(
      [task!.id],
      new Date(Date.now() + 60 * 60_000)
    )
    expect(reclaimed?.id).toBe(task!.id)
    expect(await completeArtifactDeletionTask(task!.id, reclaimed!.leaseToken!)).toBe(true)
    expect(await prisma.artifactDeletionTask.findUnique({ where: { id: task!.id } })).toBeNull()
  })

  it("authorizes only an attachment URI in the bound workspace", async () => {
    const ownUri = `s3://evidence-test/evidence/${workspaceId}/scan-attachments/user/${createId()}-own`
    await prisma.scanAttachment.create({
      data: {
        workspaceId,
        filename: "own.txt",
        mediaType: "text/plain",
        byteLength: 8,
        checksum: suffix.padEnd(64, "b").slice(0, 64),
        storageUri: ownUri,
        encryptionKeyRef: "envkeystore/lyrashield-evidence-kek/v1",
        createdById: `att-user-${suffix}`,
      },
    })

    const enqueuedId = await withWorkspaceRLS(workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT app.enqueue_scan_attachment_deletion_task(
          ${createId()}, ${workspaceId}, ${ownUri}
        ) AS id`
      return rows[0]?.id
    })
    expect(enqueuedId).toBeTruthy()
    const task = await prisma.artifactDeletionTask.findUnique({ where: { id: enqueuedId } })
    expect(task).toMatchObject({ workspaceId, kind: "SCAN_ATTACHMENT", storageUri: ownUri })

    // A foreign attachment URI inside the caller's bound workspace fails.
    await expect(
      withWorkspaceRLS(
        workspaceId,
        (tx) =>
          tx.$queryRaw`
          SELECT app.enqueue_scan_attachment_deletion_task(
            ${createId()}, ${workspaceId}, ${foreignStorageUri}
          ) AS id`
      )
    ).rejects.toThrow(/not a scan attachment/i)

    // An Evidence URI in the same workspace is not an attachment URI.
    await expect(
      withWorkspaceRLS(
        workspaceId,
        (tx) =>
          tx.$queryRaw`
          SELECT app.enqueue_scan_attachment_deletion_task(
            ${createId()}, ${workspaceId}, ${evidenceStorageUri}
          ) AS id`
      )
    ).rejects.toThrow(/not a scan attachment/i)

    // Binding a different workspace cannot authorize the attachment.
    await expect(
      withWorkspaceRLS(
        otherWorkspaceId,
        (tx) =>
          tx.$queryRaw`
          SELECT app.enqueue_scan_attachment_deletion_task(
            ${createId()}, ${workspaceId}, ${attachmentStorageUri}
          ) AS id`
      )
    ).rejects.toThrow(/workspace context mismatch/i)

    // No workspace context at all is a mismatch too.
    await expect(
      prisma.$queryRaw`
        SELECT app.enqueue_scan_attachment_deletion_task(
          ${createId()}, ${workspaceId}, ${attachmentStorageUri}
        ) AS id`
    ).rejects.toThrow(/workspace context mismatch/i)

    // The Evidence enqueue keeps its own narrow contract: attachment URIs are
    // not retained evidence.
    await expect(
      withWorkspaceRLS(
        workspaceId,
        (tx) =>
          tx.$queryRaw`
          SELECT app.enqueue_artifact_deletion_task(
            ${createId()}, ${workspaceId}, ${attachmentStorageUri}
          ) AS id`
      )
    ).rejects.toThrow(/not retained evidence/i)
  })
})
