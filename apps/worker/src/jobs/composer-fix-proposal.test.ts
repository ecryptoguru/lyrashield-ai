import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
const mocks = vi.hoisted(() => ({
  candidate: vi.fn(),
  manifest: vi.fn(),
  receipt: vi.fn(),
  integration: vi.fn(),
  read: vi.fn(),
  regenerate: vi.fn(),
  github: vi.fn(),
  proxy: vi.fn(),
  proxyFetch: vi.fn(),
}))
vi.mock("@lyrashield/config", () => ({
  env: {
    NODE_ENV: "production",
    LYRASHIELD_EGRESS_PROXY_URL: "https://proxy.test",
    LYRASHIELD_EGRESS_PROXY_SECRET: "dummy",
    LYRASHIELD_EGRESS_PROXY_CONNECT_TIMEOUT_MS: 10000,
    LYRASHIELD_EGRESS_PROXY_READ_TIMEOUT_MS: 30000,
  },
}))
vi.mock("@lyrashield/security", () => ({ createEgressProxyFetchFn: mocks.proxy }))
vi.mock("@lyrashield/db", () => ({
  withWorkspaceRLS: async (_ws: string, fn: (tx: unknown) => unknown) =>
    fn({
      findingCandidate: { findFirst: mocks.candidate },
      scanResultManifest: { findUnique: mocks.manifest },
      scanCoverageReceipt: { findFirst: mocks.receipt },
      integration: { findFirst: mocks.integration },
    }),
  verifyStoredManifestChecksum: (row: { checksumInput?: string; checksum?: string }) =>
    row?.checksumInput &&
    createHash("sha256").update(row.checksumInput).digest("hex") === row.checksum
      ? "MATCH"
      : "MISMATCH",
}))
vi.mock("@lyrashield/evidence-storage", () => ({ readEncryptedArtifact: mocks.read }))
vi.mock("@lyrashield/integrations", () => ({ getFileContent: mocks.github }))
vi.mock("./composer-fix", () => ({
  regenerateComposerLock: mocks.regenerate,
  ComposerFixUnavailableError: class extends Error {},
}))
import { prepareComposerFixProposal } from "./composer-fix-proposal"

const metadata = {
  package_name: "psr/log",
  installed_version: "1.1.3",
  package_ecosystem: "packagist",
  fixed_version: "1.1.4",
  lockfile_path: "composer.lock",
}
const claim = { findingClass: "dependency_cve", dependencyMetadata: metadata }
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex")
const finding = {
  id: "finding-1",
  scanId: "scan-1",
  baseCommit: "a".repeat(40),
  targetId: "target-1",
  target: {
    type: "REPO",
    repoOwner: "owner",
    repoName: "repo",
    installationId: "1",
    deletedAt: null,
  },
}
const params = {
  workspaceId: "ws-1",
  proposalId: "proposal-1",
  finding,
  evidence: [{ storageUri: "s3://test/claim", type: "claim_context" }],
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.proxy.mockReturnValue(mocks.proxyFetch)
  mocks.read.mockResolvedValue({ content: Buffer.from(JSON.stringify(claim)) })
  mocks.candidate.mockResolvedValue({
    payload: {
      findingClass: "dependency_cve",
      contentHashes: { dependencyMetadata: hash(metadata) },
    },
  })
  const manifest = {
    target: { id: "target-1", type: "REPO" },
    sourceExecution: { sourceRevision: "a".repeat(40) },
    terminalOutcome: { status: "COMPLETED" },
  }
  mocks.manifest.mockResolvedValue({
    manifest,
    checksumInput: JSON.stringify(manifest),
    checksum: hash(manifest),
  })
  mocks.receipt.mockResolvedValue({ status: "COMPLETED" })
  mocks.integration.mockResolvedValue({ id: "integration-1" })
  mocks.github.mockImplementation(
    async (_id: number, _owner: string, _repo: string, path: string) =>
      path.endsWith(".lock") ? "before-lock" : "before-manifest"
  )
  mocks.regenerate.mockResolvedValue({
    after: "after-lock",
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
})
describe("Composer finding to resolver authorization", () => {
  it("requires a deterministic SCA candidate rather than trusting an engine claim", async () => {
    mocks.candidate.mockResolvedValue(null)
    await expect(prepareComposerFixProposal(params)).rejects.toThrow(/deterministic|SCA/)
    expect(mocks.regenerate).not.toHaveBeenCalled()
  })
  it("rejects replaced claim metadata and missing immutable scan provenance", async () => {
    mocks.candidate.mockResolvedValue({
      payload: {
        findingClass: "dependency_cve",
        contentHashes: { dependencyMetadata: "b".repeat(64) },
      },
    })
    await expect(prepareComposerFixProposal(params)).rejects.toThrow(/evidence|metadata/)
    mocks.candidate.mockResolvedValue({
      payload: {
        findingClass: "dependency_cve",
        contentHashes: { dependencyMetadata: hash(metadata) },
      },
    })
    mocks.manifest.mockResolvedValue(null)
    await expect(prepareComposerFixProposal(params)).rejects.toThrow(/manifest|provenance/)
  })
  it("fails closed after the GitHub integration has been disconnected", async () => {
    mocks.integration.mockResolvedValue(null)
    await expect(prepareComposerFixProposal(params)).rejects.toThrow(/integration/)
    expect(mocks.github).not.toHaveBeenCalled()
  })
  it("binds a generated update to the exact stored target, finding, proposal and source revision", async () => {
    const result = await prepareComposerFixProposal(params)
    expect(result).toMatchObject({
      version: "composer-fix/1",
      workspaceId: "ws-1",
      targetId: "target-1",
      findingId: "finding-1",
      proposalId: "proposal-1",
      baseCommit: "a".repeat(40),
      lockPath: "composer.lock",
      packageName: "psr/log",
      fromVersion: "1.1.3",
      toVersion: "1.1.4",
      compatibility: "customer-tests-required",
    })
    expect(mocks.github).toHaveBeenCalledWith(1, "owner", "repo", "composer.lock", "a".repeat(40))
  })
})

it("uses the authenticated approved egress transport in the production proposal path", async () => {
  await prepareComposerFixProposal(params)
  expect(mocks.proxy).toHaveBeenCalledWith(
    expect.objectContaining({ url: "https://proxy.test", secret: "dummy" })
  )
  expect(mocks.regenerate).toHaveBeenCalledWith(
    expect.objectContaining({ fetchFn: mocks.proxyFetch })
  )
})

it("fails closed when production has no approved metadata transport", async () => {
  mocks.proxy.mockReturnValue(undefined)
  await expect(prepareComposerFixProposal(params)).rejects.toThrow(/egress proxy/)
  expect(mocks.regenerate).not.toHaveBeenCalled()
})
