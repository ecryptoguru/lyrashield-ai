/* eslint-disable security/detect-non-literal-fs-filename -- Private temporary checkout fixtures only. */
import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, writeFile } from "node:fs/promises"
const gitMock = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  const { promisify } = await import("node:util")
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: gitMock }) }
})

vi.mock("@lyrashield/db", () => ({
  prisma: {
    retest: { findMany: vi.fn() },
    findingCandidate: { findMany: vi.fn() },
    scanResultManifest: { findFirst: vi.fn() },
    scanCoverageReceipt: { findMany: vi.fn() },
  },
}))
vi.mock("@lyrashield/integrations", () => ({ getInstallationToken: vi.fn() }))
import { prisma } from "@lyrashield/db"
import { getInstallationToken } from "@lyrashield/integrations"
import { listOwnedScanDirectories } from "./stale-resource-reaper"
import {
  authorizeDeterministicRetest,
  assertRetestFilesystemCapacity,
  checkoutDeterministicRetest as checkout,
} from "./deterministic-retest"
const checkoutDeterministicRetest = (params: Omit<Parameters<typeof checkout>[0], "scanId">) =>
  checkout({ ...params, scanId: "cabcdefghijklmnopqrstuvwx" })

describe("deterministic retest authority", () => {
  it("requires a finite production tmpfs cap rather than host-bind storage", () => {
    expect(() =>
      assertRetestFilesystemCapacity({ type: 0x01021994, blocks: 262144, bsize: 4096 })
    ).not.toThrow()
    expect(() =>
      assertRetestFilesystemCapacity({ type: 0xef53, blocks: 262144, bsize: 4096 })
    ).toThrow("capped tmpfs")
    expect(() =>
      assertRetestFilesystemCapacity({ type: 0x01021994, blocks: 524288, bsize: 4096 })
    ).toThrow("capped tmpfs")
    expect(() =>
      assertRetestFilesystemCapacity({ type: 0x01021994, blocks: NaN, bsize: 4096 })
    ).toThrow("capped tmpfs")
  })
  beforeEach(() => {
    vi.resetAllMocks()
    gitMock.mockImplementation(async (_file: string, args: string[]) => {
      const init = args.indexOf("init")
      if (init >= 0) await mkdir(args[init + 1]!, { recursive: true })
      if (args.includes("rev-parse")) return { stdout: "a".repeat(40) }
      if (args.includes("ls-tree")) return { stdout: `100644 blob ${"b".repeat(40)} 3\tfile.txt\n` }
      if (args.includes("checkout"))
        await writeFile(`${args[args.indexOf("-C") + 1]}/file.txt`, "ok\n")
      return { stdout: "" }
    })
    vi.mocked(prisma.retest.findMany).mockResolvedValue([
      { finding: { id: "f", scanId: "baseline", targetId: "t", workspaceId: "w" } },
    ] as never)
    vi.mocked(prisma.findingCandidate.findMany).mockResolvedValue([
      { scannerSource: "secrets" },
    ] as never)
    vi.mocked(prisma.scanCoverageReceipt.findMany).mockResolvedValue([
      { controlId: "secrets", status: "COMPLETED" },
    ] as never)
    const manifest = { target: { id: "t" }, engineExecution: { sourceRevision: "a".repeat(40) } }
    vi.mocked(prisma.scanResultManifest.findFirst).mockResolvedValue({
      manifest,
      checksum: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    } as never)
  })
  it("requires persisted baseline, candidates and completed family coverage", async () => {
    await expect(authorizeDeterministicRetest("s", "w", "t")).resolves.toBeUndefined()
    vi.mocked(prisma.scanCoverageReceipt.findMany).mockResolvedValue([])
    await expect(authorizeDeterministicRetest("s", "w", "t")).rejects.toThrow("provenance")
  })
  it("rejects forged target or model candidates", async () => {
    await expect(authorizeDeterministicRetest("s", "w", "other")).rejects.toThrow("lineage")
    vi.mocked(prisma.findingCandidate.findMany).mockResolvedValue([
      { scannerSource: "engine" },
    ] as never)
    await expect(authorizeDeterministicRetest("s", "w", "t")).rejects.toThrow("provenance")
  })
  it("rejects missing lineage and modified receipts", async () => {
    vi.mocked(prisma.scanResultManifest.findFirst).mockResolvedValue({
      manifest: {},
      checksum: "bad",
    } as never)
    await expect(authorizeDeterministicRetest("s", "w", "t")).rejects.toThrow("provenance")
    vi.mocked(prisma.retest.findMany).mockResolvedValue([])
    await expect(authorizeDeterministicRetest("s", "w", "t")).rejects.toThrow("lineage")
  })
  it.each(["../bad/repo", "https://other/repo", "-bad/repo"])(
    "rejects unsafe repository %s before transport",
    async (repoFullName) => {
      await expect(
        checkoutDeterministicRetest({
          repoFullName,
          branch: "main",
          installationId: null,
          timeoutMs: 1000,
          isCancelled: async () => false,
        })
      ).rejects.toThrow("Invalid repository")
    }
  )
  it("rejects cancelled checkout without a model or transport call", async () => {
    await expect(
      checkoutDeterministicRetest({
        repoFullName: "owner/repo",
        branch: "main",
        installationId: null,
        timeoutMs: 1000,
        isCancelled: async () => true,
      })
    ).rejects.toThrow("checkout failed")
  })
  it("rejects LFS pointer content rather than claiming full source coverage", async () => {
    const implementation = gitMock.getMockImplementation()!
    gitMock.mockImplementation(async (file: string, args: string[]) => {
      const result = await implementation(file, args)
      if (args.includes("checkout"))
        await writeFile(
          `${args[args.indexOf("-C") + 1]}/file.txt`,
          "version https://git-lfs.github.com/spec/v1\noid sha256:abc\n"
        )
      return result
    })
    await expect(
      checkoutDeterministicRetest({
        repoFullName: "owner/repo",
        branch: null,
        installationId: null,
        timeoutMs: 1000,
        isCancelled: async () => false,
      })
    ).rejects.toThrow("checkout failed")
  })
  it("bounds a stalled installation-token request", async () => {
    vi.mocked(getInstallationToken).mockReturnValue(new Promise(() => {}))
    await expect(
      checkoutDeterministicRetest({
        repoFullName: "owner/repo",
        branch: "main",
        installationId: "123",
        timeoutMs: 10,
        isCancelled: async () => false,
      })
    ).rejects.toThrow("checkout failed")
    expect(gitMock).not.toHaveBeenCalled()
  })
  it("resolves an exact revision from isolated transport and cleans up", async () => {
    const result = await checkoutDeterministicRetest({
      repoFullName: "owner/repo",
      branch: "main",
      installationId: null,
      timeoutMs: 1000,
      isCancelled: async () => false,
    })
    expect(result.sourceRevision).toBe("a".repeat(40))
    expect(await listOwnedScanDirectories(new Set())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scanId: "cabcdefghijklmnopqrstuvwx",
          path: result.checkoutPath.replace(/\/source$/, ""),
        }),
      ])
    )
    expect(gitMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["fetch", "--depth=1", "--no-tags", "origin", "refs/heads/main"]),
      expect.objectContaining({
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null" }),
      })
    )
    await result.cleanup()
  })
  it.each(["160000 commit", "120000 blob"])("rejects incomplete %s source trees", async (mode) => {
    gitMock.mockImplementation(async (_file: string, args: string[]) => {
      if (args.includes("rev-parse")) return { stdout: "a".repeat(40) }
      if (args.includes("ls-tree")) return { stdout: `${mode} ${"b".repeat(40)} 3\tentry\n` }
      return { stdout: "" }
    })
    await expect(
      checkoutDeterministicRetest({
        repoFullName: "owner/repo",
        branch: "main",
        installationId: null,
        timeoutMs: 1000,
        isCancelled: async () => false,
      })
    ).rejects.toThrow("checkout failed")
    expect(gitMock.mock.calls.some((call) => call[1].includes("checkout"))).toBe(false)
  })
})
