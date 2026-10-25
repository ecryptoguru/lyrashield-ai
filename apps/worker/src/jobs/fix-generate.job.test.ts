import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  proposal: vi.fn(),
  evidence: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  findingUpdate: vi.fn(),
  current: vi.fn(),
  upload: vi.fn(),
  read: vi.fn(),
  prepare: vi.fn(),
  billing: vi.fn(),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("@lyrashield/db", () => ({
  withWorkspaceRLS: async (_ws: string, fn: (tx: unknown) => unknown) =>
    fn({
      fixProposal: {
        findFirst: mocks.proposal,
        findUnique: mocks.current,
        update: mocks.update,
        updateMany: mocks.updateMany,
      },
      evidence: { findMany: mocks.evidence },
      finding: { update: mocks.findingUpdate },
      workspace: { findUnique: async () => ({ plan: "PRO" }) },
    }),
}))
vi.mock("@lyrashield/billing", () => ({ resolveAccountBilling: mocks.billing }))
vi.mock("@lyrashield/evidence-storage", () => ({
  uploadEncryptedArtifact: mocks.upload,
  readEncryptedArtifact: mocks.read,
}))
vi.mock("./composer-fix-proposal", () => ({ prepareComposerFixProposal: mocks.prepare }))
vi.mock("./composer-fix", () => ({ ComposerFixUnavailableError: class extends Error {} }))
import { buildComposerUpdateDiff, diffChecksum } from "@lyrashield/fix"
import { processFixGenerateJob, processQueuedFixGenerateJob } from "./fix-generate.job"
const finding = {
  id: "finding-1",
  targetId: "target-1",
  scanId: "scan-1",
  baseCommit: "a".repeat(40),
  scan: { createdById: "sponsor-1" },
  implicatedFiles: [],
  target: {
    type: "REPO",
    repoOwner: "owner",
    repoName: "repo",
    installationId: "1",
    deletedAt: null,
  },
}
const input = { workspaceId: "ws-1", fixProposalId: "proposal-1" }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.proposal.mockResolvedValue({
    id: "proposal-1",
    status: "draft",
    finding,
    summary: "Fix this issue",
  })
  mocks.evidence.mockResolvedValue([])
  mocks.prepare.mockResolvedValue(null)
  mocks.current.mockResolvedValue({ status: "draft" })
  mocks.upload.mockResolvedValue({
    storageUri: "s3://test/server-generated",
    checksum: "b".repeat(64),
  })
  mocks.billing.mockResolvedValue({ effectivePlan: "PRO" })
  mocks.updateMany.mockResolvedValue({ count: 1 })
})
describe("fix generation lifecycle", () => {
  it("does not regenerate a proposal already ready for approval", async () => {
    mocks.proposal.mockResolvedValue({ status: "ready", finding })
    expect(await processFixGenerateJob(input)).toMatchObject({
      status: "skipped",
      reason: "proposal already ready",
    })
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it("stores a validated Composer envelope in the existing producer-bound namespace", async () => {
    const before =
        JSON.stringify(
          { packages: [{ name: "psr/log", version: "1.1.3" }], "packages-dev": [] },
          null,
          4
        ) + "\n",
      after = before.replace("1.1.3", "1.1.4")
    const diff = buildComposerUpdateDiff("composer.lock", before, after)
    mocks.prepare.mockResolvedValue({
      version: "composer-fix/1",
      workspaceId: "ws-1",
      targetId: "target-1",
      findingId: "finding-1",
      proposalId: "proposal-1",
      baseCommit: "a".repeat(40),
      manifestPath: "composer.json",
      lockPath: "composer.lock",
      packageName: "psr/log",
      fromVersion: "1.1.3",
      toVersion: "1.1.4",
      before,
      after,
      diff,
      diffChecksum: diffChecksum(diff),
      resolverImage: "composer@sha256:" + "b".repeat(64),
      checks: {
        network: "none",
        scripts: false,
        plugins: false,
        install: false,
        lockValidated: true,
      },
      compatibility: "customer-tests-required",
    })
    expect(await processFixGenerateJob(input)).toMatchObject({ status: "stored" })
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        ownerId: "finding-1",
        type: "fix-patch",
        artifactId: "fix-proposal-1",
        content: expect.stringContaining('"version":"composer-fix/1"'),
      })
    )
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "draft" }),
        data: expect.objectContaining({ kind: "composer_update", status: "ready" }),
      })
    )
  })
  it("retains retryability on artifact infrastructure failure", async () => {
    mocks.evidence.mockResolvedValue([{ type: "code_location", storageUri: "s3://test/location" }])
    mocks.read.mockResolvedValue({
      content: Buffer.from(
        JSON.stringify({ file: "src/index.php", fix_before: "before\n", fix_after: "after\n" })
      ),
    })
    mocks.upload.mockRejectedValue(new Error("storage unavailable"))
    await expect(processFixGenerateJob(input)).rejects.toThrow("storage unavailable")
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it("does not replace a proposal rejected while its artifact was being uploaded", async () => {
    mocks.evidence.mockResolvedValue([{ type: "code_location", storageUri: "s3://test/location" }])
    mocks.read.mockResolvedValue({
      content: Buffer.from(
        JSON.stringify({ file: "src/index.php", fix_before: "before\n", fix_after: "after\n" })
      ),
    })
    mocks.current.mockResolvedValue({ status: "rejected" })
    expect(await processFixGenerateJob(input)).toMatchObject({ status: "skipped" })
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it("uses the persisted scan sponsor's entitlement instead of the workspace display plan", async () => {
    mocks.billing.mockResolvedValue({ effectivePlan: "STARTER" })
    mocks.evidence.mockResolvedValue([{ type: "code_location", storageUri: "s3://test/location" }])
    mocks.read.mockResolvedValue({
      content: Buffer.from(
        JSON.stringify({
          file: "src/index.php",
          fix_before: "before\n",
          fix_after: Array.from({ length: 110 }, (_, i) => `line ${i}`).join("\n"),
        })
      ),
    })
    expect(await processFixGenerateJob(input)).toMatchObject({ status: "rejected" })
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          summary: expect.stringMatching(/Fix this issue[\s\S]*100/),
        }),
      })
    )
  })
})

it("settles exhausted infrastructure failure with an actionable reason without overwriting a terminal proposal", async () => {
  mocks.prepare.mockRejectedValue(new Error("resolver offline"))
  await expect(processFixGenerateJob(input, { attempt: 3, maxAttempts: 3 })).rejects.toThrow(
    "resolver offline"
  )
  expect(mocks.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ status: "draft", finding: { workspaceId: "ws-1" } }),
      data: expect.objectContaining({
        status: "failed",
        summary: expect.stringContaining("after retries"),
      }),
    })
  )
})

it("binds queue attempt counters into final failure settlement", async () => {
  mocks.prepare.mockRejectedValue(new Error("resolver offline"))
  await expect(
    processQueuedFixGenerateJob({
      data: input,
      id: "job-1",
      attemptsMade: 2,
      opts: { attempts: 3 },
    })
  ).rejects.toThrow("resolver offline")
  expect(mocks.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) })
  )
})
