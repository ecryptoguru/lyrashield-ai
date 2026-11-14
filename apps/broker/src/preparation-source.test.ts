import { createHash } from "node:crypto"
import type { Pool } from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildScanExecutionPlan } from "@lyrashield/types"
import { canonicalJson } from "@lyrashield/runtime-control"

const providers = vi.hoisted(() => ({ token: vi.fn(), artifact: vi.fn() }))
vi.mock("@lyrashield/integrations", () => ({ getRepositoryReadToken: providers.token }))
vi.mock("@lyrashield/evidence-storage", () => ({ readEncryptedArtifact: providers.artifact }))
import { readPreparationSource } from "./preparation-source"
import { acquirePreparationArtifacts } from "./preparation-acquisition"

function fixture() {
  const executionPlan = buildScanExecutionPlan({
    targetType: "REPO",
    mode: "STANDARD",
    source: { revision: "a".repeat(40) },
  })
  const row = {
    operationId: "operation-one",
    scanId: "scan-one",
    workspaceId: "workspace-one",
    executionPlan,
    executionPlanHash: createHash("sha256").update(canonicalJson(executionPlan)).digest("hex"),
    targetSnapshotDigest: "a".repeat(64),
    scopeDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    target: {
      id: "target-one",
      type: "REPO",
      repoProvider: "github",
      repoFullName: "owner/repo",
      installationId: "123",
    },
  }
  let inTransaction = false,
    reads = 0
  const events: string[] = []
  const assigned = { valid: true }
  const attachments: Array<Record<string, unknown>> = []
  const client = {
    release: vi.fn(),
    async query(sql: string) {
      events.push(sql)
      if (sql === "BEGIN") inTransaction = true
      if (sql === "COMMIT" || sql === "ROLLBACK") inTransaction = false
      if (sql.includes("app.scan_preparation_context"))
        return {
          rowCount: 1,
          rows: [{ workspaceId: row.workspaceId, accountId: "account-one", userId: "user-one" }],
        }
      if (sql.includes("pg_try_advisory_xact_lock_shared"))
        return { rowCount: 1, rows: [{ held: true }] }
      if (sql.includes("require_scan_dispatch_worker_stage"))
        return {
          rowCount: assigned.valid ? 1 : 0,
          rows: assigned.valid
            ? [
                {
                  workerGrantId: "grant-one",
                  workerInstanceId: "worker-one",
                  authorityEpochId: "epoch-one",
                  attemptId: null,
                },
              ]
            : [],
        }
      if (sql.includes('SELECT o."operationId"')) {
        reads++
        return { rowCount: 1, rows: [structuredClone(row)] }
      }
      if (sql.includes('FROM "ScanAttachment"'))
        return { rowCount: attachments.length, rows: attachments }
      if (sql.includes('SELECT id FROM "Integration"'))
        return { rowCount: 1, rows: [{ id: "integration-one" }] }
      return { rowCount: 1, rows: [] }
    },
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool
  return {
    pool,
    row,
    assigned,
    attachments,
    events,
    client,
    reads: () => reads,
    inTransaction: () => inTransaction,
  }
}
const request = { operationId: "operation-one", credentialHash: "d".repeat(64) }

describe("root preparation source acquisition", () => {
  beforeEach(() => {
    providers.token.mockReset()
    providers.artifact.mockReset()
  })
  it("releases the shared source gate before the separately installed SDK acquisition", async () => {
    const f = fixture()
    providers.token.mockImplementation(async () => {
      expect(f.inTransaction()).toBe(false)
      return "fixture-token"
    })
    const result = await readPreparationSource(f.pool, request)
    expect(providers.token).not.toHaveBeenCalled()
    await acquirePreparationArtifacts(result)
    expect(providers.token).toHaveBeenCalledWith(123, "owner/repo")
    expect(f.reads()).toBe(1)
    expect(f.client.release).toHaveBeenCalledTimes(1)
    expect(result.executionPlan.source?.revision).toBe("a".repeat(40))
    expect(result).not.toHaveProperty("attemptId")
    expect(f.events.filter((event) => event === "COMMIT")).toHaveLength(1)
  })
  it("fails before reading a token for an unassigned worker or unpinned plan", async () => {
    const f = fixture()
    f.assigned.valid = false
    await expect(readPreparationSource(f.pool, request)).rejects.toThrow(
      "worker assignment unavailable"
    )
    expect(providers.token).not.toHaveBeenCalled()
    f.assigned.valid = true
    delete f.row.executionPlan.source
    f.row.executionPlanHash = createHash("sha256")
      .update(canonicalJson(f.row.executionPlan))
      .digest("hex")
    await expect(readPreparationSource(f.pool, request)).rejects.toThrow(
      "Pinned GitHub source unavailable"
    )
    expect(providers.token).not.toHaveBeenCalled()
  })
  it("rejects cross-workspace attachment metadata before the contents-read token", async () => {
    const f = fixture()
    await expect(
      acquirePreparationArtifacts({
        ...f.row,
        attachments: [
          {
            id: "attachment-one",
            workspaceId: "other-workspace",
            byteLength: 7,
            checksum: "a".repeat(64),
            storageUri: "s3://fixture/other-workspace/file",
            encryptionKeyRef: "kms://fixture/1",
          },
        ],
      })
    ).rejects.toThrow("authority unavailable")
    expect(providers.token).not.toHaveBeenCalled()
  })
  it("accepts no caller-selected worker, repository, path, SQL or revision", async () => {
    const f = fixture()
    for (const field of ["workerGrantId", "repository", "path", "sql", "revision"])
      await expect(
        readPreparationSource(f.pool, { ...request, [field]: "untrusted" })
      ).rejects.toThrow()
    expect(f.pool.connect).not.toHaveBeenCalled()
  })
  it("retains approved encrypted attachments and rejects changed plaintext or key references", async () => {
    const f = fixture(),
      content = Buffer.from("approved supporting evidence")
    f.row.executionPlan.attachmentIds = ["attachment-one"]
    f.row.executionPlanHash = createHash("sha256")
      .update(canonicalJson(f.row.executionPlan))
      .digest("hex")
    const checksum = createHash("sha256").update(content).digest("hex")
    f.attachments.push({
      id: "attachment-one",
      workspaceId: f.row.workspaceId,
      filename: "notes.txt",
      mediaType: "text/plain",
      byteLength: content.length,
      checksum,
      storageUri: "s3://fixture/workspace-one/attachment-one",
      encryptionKeyRef: "kms://fixture/1",
    })
    providers.token.mockResolvedValue("fixture-token")
    providers.artifact.mockResolvedValue({
      legacy: false,
      content,
      checksum,
      encryptionKeyRef: "kms://fixture/1",
    })
    const result = await acquirePreparationArtifacts(await readPreparationSource(f.pool, request))
    if (!("attachmentBytes" in result))
      throw new Error("Acquisition did not return attachment bytes")
    expect(result.attachmentBytes).toEqual([
      { id: "attachment-one", content: content.toString("base64") },
    ])
    expect(providers.artifact).toHaveBeenCalledWith(
      "s3://fixture/workspace-one/attachment-one",
      f.row.workspaceId
    )
    providers.artifact.mockResolvedValue({
      legacy: false,
      content: Buffer.from("x".repeat(content.length)),
      checksum,
      encryptionKeyRef: "kms://fixture/1",
    })
    await expect(
      acquirePreparationArtifacts(await readPreparationSource(f.pool, request))
    ).rejects.toThrow("integrity unavailable")
    providers.artifact.mockResolvedValue({
      legacy: false,
      content,
      checksum,
      encryptionKeyRef: "kms://other/1",
    })
    await expect(
      acquirePreparationArtifacts(await readPreparationSource(f.pool, request))
    ).rejects.toThrow("integrity unavailable")
  })
})
