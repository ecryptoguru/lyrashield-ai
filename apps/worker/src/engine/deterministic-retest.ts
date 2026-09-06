import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm, readdir, lstat, mkdir, open } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { prisma } from "@lyrashield/db"
import { getInstallationToken } from "@lyrashield/integrations"
import {
  ENGINE_CHECKOUT_ROOT,
  assertEngineTempRootReady,
  engineWorkspacePath,
} from "./workspace-path"

const execute = promisify(execFile)
const SCANNERS = new Set(["sca", "secrets", "agent_config", "ai_app_security", "ml_supply_chain"])

/** Authorization comes from persisted lineage, never from queue instructions. */
export async function authorizeDeterministicRetest(
  scanId: string,
  workspaceId: string,
  targetId: string
) {
  const retests = await prisma.retest.findMany({
    where: { scanId, workspaceId, status: { in: ["pending", "running"] } },
    select: { finding: { select: { id: true, scanId: true, targetId: true, workspaceId: true } } },
  })
  if (!retests.length) throw new Error("Deterministic retest has no persisted finding lineage")
  for (const { finding } of retests) {
    if (finding.targetId !== targetId || finding.workspaceId !== workspaceId)
      throw new Error("Deterministic retest target lineage mismatch")
    const [candidates, baseline, coverage] = await Promise.all([
      prisma.findingCandidate.findMany({
        where: { workspaceId, scanId: finding.scanId, findingId: finding.id },
        select: { scannerSource: true },
      }),
      prisma.scanResultManifest.findFirst({
        where: { scan: { workspaceId, targetId }, scanId: finding.scanId },
      }),
      prisma.scanCoverageReceipt.findMany({
        where: { scan: { workspaceId, targetId }, scanId: finding.scanId },
        select: { controlId: true, status: true },
      }),
    ])
    const receipt = baseline?.manifest as
      | {
          target?: { id?: string }
          engineExecution?: { sourceRevision?: string }
          sourceExecution?: { sourceRevision?: string }
        }
      | undefined
    const revision =
      receipt?.sourceExecution?.sourceRevision ?? receipt?.engineExecution?.sourceRevision
    if (
      !candidates.length ||
      candidates.some(
        ({ scannerSource }) =>
          !SCANNERS.has(scannerSource) ||
          !coverage.some((row) => row.controlId === scannerSource && row.status === "COMPLETED")
      ) ||
      receipt?.target?.id !== targetId ||
      !revision ||
      !/^[a-f0-9]{40}$/i.test(revision) ||
      !/^[a-f0-9]{64}$/i.test(baseline?.checksum ?? "")
    ) {
      throw new Error("Deterministic retest baseline provenance is incomplete")
    }
  }
}

/** Separate checkout: fixed GitHub transport, no hooks/submodules, bounded lifetime and tree. */
export async function checkoutDeterministicRetest(params: {
  scanId: string
  repoFullName: string | null
  branch: string | null
  installationId: string | null
  timeoutMs: number
  isCancelled: () => Promise<boolean>
}) {
  if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0)
    throw new Error("Deterministic checkout deadline exhausted")
  if (
    params.installationId &&
    (!/^\d+$/.test(params.installationId) ||
      !Number.isSafeInteger(Number(params.installationId)) ||
      Number(params.installationId) <= 0)
  )
    throw new Error("Invalid repository installation identity")
  if (
    !params.repoFullName ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(params.repoFullName) ||
    params.repoFullName.includes("..")
  )
    throw new Error("Invalid repository identity")
  if (
    params.branch !== null &&
    (!params.branch ||
      params.branch.startsWith("-") ||
      /[\x00-\x20~^:?*\[\\]/.test(params.branch) ||
      params.branch.includes(".."))
  )
    throw new Error("Invalid repository branch")
  await assertEngineTempRootReady()
  engineWorkspacePath(params.scanId)
  // Reuse the existing owned-checkout naming contract so the stale-resource
  // reaper can recover process-kill leftovers using persisted scan ownership.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(ENGINE_CHECKOUT_ROOT, { recursive: true })
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const checkoutRootStat = await lstat(ENGINE_CHECKOUT_ROOT)
  if (!checkoutRootStat.isDirectory() || checkoutRootStat.isSymbolicLink())
    throw new Error("Unsafe checkout root")
  const root = await mkdtemp(join(ENGINE_CHECKOUT_ROOT, `repo_${params.scanId}_`))
  const checkoutPath = join(root, "source")
  const home = join(root, "home")
  // Worker-generated private directory, never a target-supplied path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(home)
  const abort = new AbortController()
  // This is a sampled soft bound; the worker's tmpfs quota remains the hard disk limit.
  let checkingSize = false
  const measure = async (directory: string): Promise<number> => {
    let size = 0
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const stat = await lstat(path).catch(() => null)
      if (!stat) continue
      if (stat.isSymbolicLink()) throw new Error("Unsupported source symlink")
      size += stat.size + (stat.isDirectory() ? await measure(path) : 0)
      if (size > 512 * 1024 * 1024) throw new Error("Checkout size limit")
    }
    return size
  }
  const diskPoll = setInterval(() => {
    if (checkingSize) return
    checkingSize = true
    void measure(root)
      .catch(() => abort.abort())
      .finally(() => {
        checkingSize = false
      })
  }, 1000)
  const timer = setTimeout(() => abort.abort(), Math.min(Math.max(1, params.timeoutMs), 120_000))
  const poll = setInterval(() => {
    void params
      .isCancelled()
      .then((cancelled) => {
        if (cancelled) abort.abort()
      })
      .catch(() => abort.abort())
  }, 1000)
  try {
    const aborted = new Promise<never>((_, reject) => {
      if (abort.signal.aborted) reject(new Error("Checkout deadline exceeded"))
      else
        abort.signal.addEventListener(
          "abort",
          () => reject(new Error("Checkout deadline exceeded")),
          { once: true }
        )
    })
    if (await Promise.race([params.isCancelled(), aborted]))
      throw new Error("Deterministic checkout cancelled")
    const token = params.installationId
      ? await Promise.race([
          getInstallationToken(Number(params.installationId)),
          new Promise<never>((_, reject) => {
            if (abort.signal.aborted) reject(new Error("Checkout deadline exceeded"))
            else
              abort.signal.addEventListener(
                "abort",
                () => reject(new Error("Checkout deadline exceeded")),
                { once: true }
              )
          }),
        ])
      : null
    const gitEnv = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: token ? "1" : "0",
      ...(token
        ? {
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          }
        : {}),
    }
    const git = (args: string[]) =>
      execute(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "protocol.file.allow=never",
          "-c",
          "protocol.ext.allow=never",
          ...args,
        ],
        { env: gitEnv, signal: abort.signal, timeout: 120_000, maxBuffer: 1024 * 1024 }
      )
    await git(["init", checkoutPath])
    await git([
      "-C",
      checkoutPath,
      "remote",
      "add",
      "origin",
      `https://github.com/${params.repoFullName}.git`,
    ])
    await git([
      "-C",
      checkoutPath,
      "fetch",
      "--depth=1",
      "--no-tags",
      "origin",
      params.branch ? `refs/heads/${params.branch}` : "HEAD",
    ])
    const { stdout } = await git([
      "-C",
      checkoutPath,
      "rev-parse",
      "--verify",
      "FETCH_HEAD^{commit}",
    ])
    const sourceRevision = stdout.trim()
    if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error("Invalid resolved source revision")
    const { stdout: tree } = await git(["-C", checkoutPath, "ls-tree", "-r", "-l", sourceRevision])
    let treeBytes = 0
    for (const line of tree.split("\n").filter(Boolean)) {
      if (/^(120000|160000) /.test(line))
        throw new Error("Symlinks and submodules require a full source review")
      const size = /^\d+ blob [a-f0-9]+\s+(\d+)\t/.exec(line)?.[1]
      if (!size) throw new Error("Unsupported Git tree entry")
      treeBytes += Number(size)
      if (treeBytes > 512 * 1024 * 1024) throw new Error("Repository tree exceeds size limit")
    }
    await git(["-C", checkoutPath, "checkout", "--detach", sourceRevision])
    let bytes = 0
    let files = 0
    const inspect = async (directory: string): Promise<void> => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (abort.signal.aborted) throw new Error("Deterministic checkout cancelled")
        const path = join(directory, entry.name)
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const stat = await lstat(path)
        if (stat.isSymbolicLink())
          throw new Error("Repository symlinks are unsupported for deterministic retests")
        bytes += stat.size
        files += 1
        if (bytes > 512 * 1024 * 1024 || files > 100_000)
          throw new Error("Deterministic repository checkout exceeds size limit")
        if (stat.isDirectory()) await inspect(path)
        else if (stat.isFile() && !path.includes("/.git/")) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const header = Buffer.alloc(128)
            await file.read(header, 0, header.length, 0)
            if (header.toString().startsWith("version https://git-lfs.github.com/spec/v1"))
              throw new Error("Git LFS content requires a full source review")
          } finally {
            await file.close()
          }
        }
      }
    }
    await inspect(checkoutPath)
    return {
      checkoutPath,
      sourceRevision,
      cleanup: () => rm(root, { recursive: true, force: true }),
    }
  } catch {
    await rm(root, { recursive: true, force: true })
    throw new Error("Deterministic repository checkout failed or exceeded its limits")
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
    clearInterval(diskPoll)
  }
}
