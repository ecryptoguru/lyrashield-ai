import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, copyFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  proposal: vi.fn(),
  finding: vi.fn(),
  workspace: vi.fn(),
  approval: vi.fn(),
  branch: vi.fn(),
  write: vi.fn(),
  pr: vi.fn(),
  rls: vi.fn(),
  begin: vi.fn(),
  env: {
    NODE_ENV: "test",
    LYRASHIELD_LOCAL_EVIDENCE_STORAGE: "1",
    LYRASHIELD_LOCAL_EVIDENCE_DIR: "",
    BETTER_AUTH_SECRET: "disposable-test-only-evidence-secret",
  },
}))
vi.mock("./fix-pr-connection", () => ({ hasActiveFixPrConnection: mocks.connection }))
vi.mock("@lyrashield/config", () => ({ env: mocks.env }))
vi.mock("@lyrashield/db", () => ({
  getFixProposal: mocks.proposal,
  withWorkspaceRLS: mocks.rls,
  assertEvidenceEncrypted: vi.fn(),
  hashInput: (_action: string, input: unknown) => JSON.stringify(input),
  createApproval: mocks.approval,
  findPendingApprovalByHash: vi.fn(),
  claimApprovalExecution: vi.fn().mockResolvedValue(true),
  completeApprovalExecution: vi.fn(),
  failApprovalExecution: vi.fn(),
  createPullRequestRecord: vi.fn().mockResolvedValue({ status: "open" }),
  beginFixPrExecution: mocks.begin,
  getFixPrExecution: vi.fn().mockResolvedValue(null),
  markFixPrRecovery: vi.fn().mockResolvedValue(undefined),
  prisma: {
    finding: { findFirst: mocks.finding },
    workspace: { findUnique: mocks.workspace },
  },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock("@lyrashield/integrations", () => ({
  getDefaultBranch: vi.fn().mockResolvedValue("main"),
  getBranchRefSha: vi.fn().mockResolvedValue("scanned-sha"),
  getFileContent: vi.fn().mockResolvedValue("const insecure = true\n"),
  createBranch: mocks.branch,
  createOrUpdateFile: mocks.write,
  createPullRequest: mocks.pr,
}))
vi.mock("@lyrashield/billing", () => ({
  resolveAccountBilling: vi.fn().mockResolvedValue({ effectivePlan: "PRO" }),
}))

import {
  uploadEncryptedArtifact,
  readEncryptedArtifact,
  EvidenceStorageConfigurationError,
} from "@lyrashield/evidence-storage"
import { buildUnifiedDiff, validatePatchDiff, patchScopeForPlan } from "@lyrashield/fix"
import { resolveFixPrRequest } from "./fix-pr-context"
import { requestFixPrApproval } from "./fix-pr"
import { processFixGenerateJob } from "../../../worker/src/jobs/fix-generate.job"

const diff = buildUnifiedDiff("src/a.ts", "const insecure = true\n", "const insecure = false\n")
const resolve = () => resolveFixPrRequest("workspace-1", "proposal-1", "user-1")

async function storePatch(
  overrides: { ownerId?: string; artifactId?: string; content?: string } = {}
) {
  return uploadEncryptedArtifact({
    workspaceId: "workspace-1",
    ownerId: "finding-1",
    type: "fix-patch",
    artifactId: "fix-proposal-1",
    content: diff,
    ...overrides,
  })
}

function reference(storageUri: string, status = "draft") {
  mocks.proposal.mockResolvedValue({
    id: "proposal-1",
    findingId: "finding-1",
    diffRef: storageUri,
    status,
  })
}

describe("fix PR patch provenance with disposable encrypted artifacts", () => {
  beforeAll(async () => {
    mocks.env.LYRASHIELD_LOCAL_EVIDENCE_DIR = await mkdtemp(join(tmpdir(), "fix provenance-"))
  })
  afterAll(async () => {
    await rm(mocks.env.LYRASHIELD_LOCAL_EVIDENCE_DIR, { recursive: true, force: true })
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.connection.mockResolvedValue(true)
    mocks.begin.mockResolvedValue({ created: true, record: { status: "opening" } })
    mocks.finding.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      implicatedFiles: ["src/a.ts"],
      baseCommit: "scanned-sha",
      target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
    })
    mocks.workspace.mockResolvedValue({ plan: "PRO" })
    mocks.approval.mockResolvedValue({ id: "receipt-1", status: "APPROVED" })
    mocks.pr.mockResolvedValue({ number: 1, url: "http://localhost/mock-pr/1" })
  })

  it.each(["ready", "approved", "pr_opened"])(
    "preserves generated patches in %s lifecycle state",
    async (status) => {
      const artifact = await storePatch()
      reference(artifact.storageUri, status)
      expect(await resolve()).toMatchObject({
        diff,
        fixProposalId: "proposal-1",
        baseCommit: "scanned-sha",
      })
    }
  )

  it("accepts the actual worker producer's encrypted artifact", async () => {
    const structured = await uploadEncryptedArtifact({
      workspaceId: "workspace-1",
      ownerId: "finding-1",
      type: "code_location",
      artifactId: "code-loc-0",
      content: JSON.stringify({
        file: "src/a.ts",
        fix_before: "const insecure = true\n",
        fix_after: "const insecure = false\n",
      }),
    })
    const finding = {
      id: "finding-1",
      targetId: "target-1",
      baseCommit: "scanned-sha",
      scanId: "original-scan",
      scan: { createdById: "sponsor-1" },
      implicatedFiles: ["src/a.ts"],
    }
    const tx = {
      fixProposal: {
        findFirst: vi.fn().mockResolvedValue({ status: "draft", finding }),
        findUnique: vi.fn().mockResolvedValue({ status: "draft" }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      evidence: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ storageUri: structured.storageUri, type: "code_location" }]),
      },
      workspace: { findUnique: vi.fn().mockResolvedValue({ plan: "PRO" }) },
      finding: { update: vi.fn() },
    }
    mocks.rls.mockImplementation(async (_workspaceId, operation) => operation(tx))
    const result = await processFixGenerateJob({
      workspaceId: "workspace-1",
      fixProposalId: "proposal-1",
    })
    expect(result.status).toBe("stored")
    expect(tx.fixProposal.updateMany).toHaveBeenCalledWith({
      where: {
        id: "proposal-1",
        status: "draft",
        finding: { workspaceId: "workspace-1" },
        deletedAt: null,
      },
      data: { status: "ready", diffRef: result.diffRef },
    })
    reference(result.diffRef!, "ready")
    expect((await resolve()).diff).toBe(diff)
  })

  it("rejects another proposal's valid generated patch in the same workspace", async () => {
    const artifact = await storePatch({ artifactId: "fix-proposal-2" })
    reference(artifact.storageUri)
    await expect(resolve()).rejects.toMatchObject({ code: "PROPOSAL_PATCH_PROVENANCE_REQUIRED" })
  })

  it("rejects a generated patch owned by another finding", async () => {
    const artifact = await storePatch({ ownerId: "finding-2" })
    reference(artifact.storageUri)
    await expect(resolve()).rejects.toMatchObject({ code: "PROPOSAL_PATCH_PROVENANCE_REQUIRED" })
  })

  it("rejects user-authored control evidence even when its bytes pass patch scope validation", async () => {
    const artifact = await uploadEncryptedArtifact({
      workspaceId: "workspace-1",
      namespace: "evidence-control-1",
      ownerId: "user-1",
      type: "control-evidence",
      artifactId: "upload-1",
      content: diff,
      contentType: "text/plain",
    })
    expect(
      (await readEncryptedArtifact(artifact.storageUri, "workspace-1")).content.toString()
    ).toBe(diff)
    expect(validatePatchDiff(diff, "src/a.ts", ["src/a.ts"], patchScopeForPlan("PRO")).ok).toBe(
      true
    )
    reference(artifact.storageUri)
    await expect(resolve()).rejects.toMatchObject({ code: "PROPOSAL_PATCH_PROVENANCE_REQUIRED" })
  })

  it("rejects non-patch finding evidence references", async () => {
    const artifact = await uploadEncryptedArtifact({
      workspaceId: "workspace-1",
      ownerId: "finding-1",
      type: "code_location",
      artifactId: "code-loc-0",
      content: JSON.stringify({ file: "src/a.ts" }),
    })
    reference(artifact.storageUri)
    await expect(resolve()).rejects.toMatchObject({ code: "PROPOSAL_PATCH_PROVENANCE_REQUIRED" })
  })

  it("stops an uploaded patch before credential-authorized provider writes", async () => {
    const artifact = await uploadEncryptedArtifact({
      workspaceId: "workspace-1",
      namespace: "evidence-control-1",
      ownerId: "user-1",
      type: "control-evidence",
      artifactId: "upload-1",
      content: diff,
      contentType: "text/plain",
    })
    reference(artifact.storageUri)
    await expect(
      (async () => {
        const context = await resolve()
        return requestFixPrApproval(
          { ...context, authorization: { kind: "api-key", id: "key-1" } },
          "http://localhost"
        )
      })()
    ).rejects.toMatchObject({ code: "PROPOSAL_PATCH_PROVENANCE_REQUIRED" })
    expect(mocks.approval).not.toHaveBeenCalled()
    expect(mocks.branch).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.pr).not.toHaveBeenCalled()
  })

  it("preserves scope-validated generated patch execution under credential authorization", async () => {
    reference((await storePatch()).storageUri, "ready")
    const context = await resolve()
    expect(
      (
        await requestFixPrApproval(
          { ...context, authorization: { kind: "api-key", id: "key-1" } },
          "http://localhost"
        )
      ).status
    ).toBe("opened")
    expect(mocks.write).toHaveBeenCalledWith(
      42,
      "acme",
      "app",
      "src/a.ts",
      "const insecure = false\n",
      expect.any(String),
      expect.any(String),
      "74063c928e3a962eb0a8eb60c71bd99c821e6ede"
    )
    expect(mocks.pr).toHaveBeenCalledOnce()
  })

  it("rechecks a connection disabled after generating a proposal", async () => {
    const artifact = await storePatch()
    reference(artifact.storageUri)
    await expect(resolve()).resolves.toMatchObject({ installationId: 42 })
    mocks.connection.mockResolvedValue(false)
    await expect(resolve()).rejects.toMatchObject({ code: "GITHUB_CONNECTION_INACTIVE" })
    expect(mocks.branch).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it("rejects authenticated bytes that do not match the producer key's digest", async () => {
    const original = await storePatch()
    const replacement = await storePatch({
      content: buildUnifiedDiff("src/a.ts", "old\n", "changed\n"),
    })
    // Both objects are authenticated ciphertext in this test-owned temporary directory.
    await copyFile(fileURLToPath(replacement.storageUri), fileURLToPath(original.storageUri))
    reference(original.storageUri)
    await expect(resolve()).rejects.toMatchObject({ code: "PROPOSAL_PATCH_PROVENANCE_REQUIRED" })
  })

  it.each([
    "not a URI",
    "https://storage.invalid/patch",
    "s3://bucket/unrelated-key",
    "file:///etc/passwd",
  ])("returns a safe provenance conflict for invalid stored reference %s", async (uri) => {
    reference(uri)
    await expect(resolve()).rejects.toMatchObject({
      code: "PROPOSAL_PATCH_PROVENANCE_REQUIRED",
      status: 409,
    })
  })

  it("returns a safe conflict when the generated artifact is missing", async () => {
    const artifact = await storePatch()
    await rm(fileURLToPath(artifact.storageUri))
    reference(artifact.storageUri)
    await expect(resolve()).rejects.toMatchObject({
      code: "PROPOSAL_PATCH_UNAVAILABLE",
      status: 409,
    })
  })

  it("keeps evidence configuration outages as infrastructure errors", async () => {
    reference((await storePatch()).storageUri)
    mocks.env.LYRASHIELD_LOCAL_EVIDENCE_STORAGE = "0"
    try {
      await expect(resolve()).rejects.toBeInstanceOf(EvidenceStorageConfigurationError)
    } finally {
      mocks.env.LYRASHIELD_LOCAL_EVIDENCE_STORAGE = "1"
    }
  })

  it("retains the existing cross-workspace read guard", async () => {
    const artifact = await uploadEncryptedArtifact({
      workspaceId: "workspace-2",
      ownerId: "finding-1",
      type: "fix-patch",
      artifactId: "fix-proposal-1",
      content: diff,
    })
    reference(artifact.storageUri)
    await expect(resolve()).rejects.toMatchObject({
      code: "PROPOSAL_PATCH_PROVENANCE_REQUIRED",
      status: 409,
    })
  })
})
