/* eslint-disable security/detect-non-literal-fs-filename */
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import path from "node:path"
import type { AgentEntry } from "@lyrashield/agent-registry"
import type {
  CheckRulesOptions,
  RemoveRulesOptions,
  AddRulesOptions,
  RuleFileCheck,
  RuleFormat,
  RuleOutcome,
} from "./types.js"
import { formatForRulesFile, renderRuleForAgent, resolveRuleFilePath } from "./renderers/index.js"

const MANAGED_BLOCK_REGEX =
  /<!--\s*lyrashield:begin\s+v=([\w.]+)\s+sha=([0-9a-f]{12})\s*-->([\s\S]*?)<!--\s*lyrashield:end\s*-->/g

interface ExistingBlock {
  version: string
  declaredSha: string
  body: string
  startIndex: number
  endIndex: number
}

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12)
}

function extractBlocks(content: string): ExistingBlock[] {
  const blocks: ExistingBlock[] = []
  let match: RegExpExecArray | null
  MANAGED_BLOCK_REGEX.lastIndex = 0
  while ((match = MANAGED_BLOCK_REGEX.exec(content)) !== null) {
    blocks.push({
      version: match[1] ?? "",
      declaredSha: match[2] ?? "",
      body: match[3] ?? "",
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    })
  }
  return blocks
}

function normalizeProjectRoot(root?: string): string {
  return root ? path.resolve(root) : process.cwd()
}

function resolveWithinProject(projectRoot: string, relativeFile: string): string {
  const target = path.resolve(projectRoot, relativeFile)
  if (!target.startsWith(projectRoot)) {
    throw new Error(`Refusing to write rule file outside project root: ${relativeFile}`)
  }
  return target
}

async function backupExisting(filePath: string): Promise<string | undefined> {
  try {
    await access(filePath)
  } catch {
    return undefined
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = `${filePath}.lyrashield-backup-${stamp}`
  await copyFile(filePath, backupPath)
  return backupPath
}

async function isGitTrackedUnignored(projectRoot: string, targetPath: string): Promise<boolean> {
  let rel: string
  try {
    rel = path.relative(projectRoot, targetPath)
  } catch {
    return false
  }
  if (!rel || rel.startsWith("..")) return false

  const tracked = await new Promise<boolean>((resolve) => {
    execFile("git", ["ls-files", "--error-unmatch", rel], { cwd: projectRoot }, (err) =>
      resolve(err === null)
    )
  })
  if (!tracked) return false

  const ignored = await new Promise<boolean>((resolve) => {
    execFile("git", ["check-ignore", rel], { cwd: projectRoot }, (err) => resolve(err === null))
  })
  return tracked && !ignored
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const parent = path.dirname(filePath)
  await mkdir(parent, { recursive: true })
  const tmp = `${filePath}.lyrashield-tmp`
  await writeFile(tmp, content, "utf-8")
  await writeFile(filePath, content, "utf-8")
  await rm(tmp, { force: true })
}

async function getRuleFilePaths(agent: AgentEntry, projectRoot: string) {
  const result: { format: RuleFormat; file: string; target: string }[] = []
  for (const rulesFile of agent.rulesFiles) {
    const format = formatForRulesFile(rulesFile)
    if (!format) continue
    const file = resolveRuleFilePath(rulesFile)
    const target = resolveWithinProject(projectRoot, file)
    result.push({ format, file, target })
  }
  return result
}

export async function addRules(
  agent: AgentEntry,
  options: AddRulesOptions = {}
): Promise<RuleOutcome[]> {
  const projectRoot = normalizeProjectRoot(options.projectRoot)
  const outcomes: RuleOutcome[] = []

  for (const { format, file, target } of await getRuleFilePaths(agent, projectRoot)) {
    const rule = renderRuleForAgent(agent, file, options.policyVersion)

    let exists = false
    try {
      await access(target)
      exists = true
    } catch {
      // file does not exist
    }

    if (!exists) {
      if (options.dryRun) {
        outcomes.push({
          file,
          format,
          action: "would-add",
          sha: rule.sha,
        })
        continue
      }
      const backup = await backupExisting(target)
      await atomicWrite(target, rule.content)
      outcomes.push({
        file,
        format,
        action: "added",
        backupPath: backup,
        sha: rule.sha,
      })
      continue
    }

    const existing = await readFile(target, "utf-8")
    const blocks = extractBlocks(existing)

    if (blocks.length > 0) {
      const first = blocks[0]!
      const actualSha = hashBody(first.body)
      if (actualSha !== first.declaredSha) {
        if (options.force) {
          outcomes.push({
            file,
            format,
            action: options.dryRun ? "would-update" : "updated",
            reason: "divergence detected; overwritten because --force was used",
            backupPath: options.dryRun ? undefined : await backupExisting(target),
            sha: rule.sha,
          })
          if (!options.dryRun) await atomicWrite(target, rule.content)
        } else {
          outcomes.push({
            file,
            format,
            action: "refused",
            reason: `managed block has diverged (declared sha ${first.declaredSha}, actual ${actualSha}); use --force to overwrite`,
            sha: first.declaredSha,
          })
        }
        continue
      }

      const fullBlock = existing.slice(first.startIndex, first.endIndex)
      const expectedBegin = `<!-- lyrashield:begin v=${rule.policyVersion} sha=${rule.sha} -->`
      if (fullBlock.startsWith(expectedBegin) && first.body === `\n${rule.inner}\n`) {
        outcomes.push({
          file,
          format,
          action: "skipped",
          sha: rule.sha,
        })
        continue
      }

      if (options.dryRun) {
        outcomes.push({
          file,
          format,
          action: "would-update",
          sha: rule.sha,
        })
      } else {
        const backup = await backupExisting(target)
        const updated =
          existing.slice(0, first.startIndex) + rule.content + existing.slice(first.endIndex)
        await atomicWrite(target, updated)
        outcomes.push({
          file,
          format,
          action: "updated",
          backupPath: backup,
          sha: rule.sha,
        })
      }
      continue
    }

    const tracked = await isGitTrackedUnignored(projectRoot, target)
    if (!options.force) {
      outcomes.push({
        file,
        format,
        action: "refused",
        reason: tracked
          ? "file exists, is tracked by git, and is not gitignored; use --force to overwrite"
          : "file exists with no managed LyraShield block; use --force to overwrite",
        sha: rule.sha,
      })
      continue
    }

    if (options.dryRun) {
      outcomes.push({
        file,
        format,
        action: "would-update",
        sha: rule.sha,
      })
    } else {
      const backup = await backupExisting(target)
      await atomicWrite(target, rule.content)
      outcomes.push({
        file,
        format,
        action: "updated",
        backupPath: backup,
        sha: rule.sha,
      })
    }
  }

  return outcomes
}

export async function removeRules(
  agent: AgentEntry,
  options: RemoveRulesOptions = {}
): Promise<RuleOutcome[]> {
  const projectRoot = normalizeProjectRoot(options.projectRoot)
  const outcomes: RuleOutcome[] = []

  for (const { format, file, target } of await getRuleFilePaths(agent, projectRoot)) {
    let exists = false
    try {
      await access(target)
      exists = true
    } catch {
      // file does not exist
    }

    if (!exists) {
      outcomes.push({
        file,
        format,
        action: options.dryRun ? "would-remove" : "removed",
        reason: "file did not exist",
      })
      continue
    }

    if (options.dryRun) {
      outcomes.push({
        file,
        format,
        action: "would-remove",
      })
      continue
    }

    const existing = await readFile(target, "utf-8")
    const blocks = extractBlocks(existing)

    if (blocks.length === 0) {
      outcomes.push({
        file,
        format,
        action: "removed",
        reason: "no LyraShield managed block found",
      })
      continue
    }

    let cleaned = existing
    for (const block of [...blocks].reverse()) {
      cleaned = cleaned.slice(0, block.startIndex) + cleaned.slice(block.endIndex)
    }

    const trimmed = cleaned.trim()
    if (trimmed.length === 0) {
      const backup = await backupExisting(target)
      await rm(target, { force: true })
      outcomes.push({
        file,
        format,
        action: "removed",
        backupPath: backup,
      })
    } else {
      const backup = await backupExisting(target)
      await atomicWrite(target, cleaned.replace(/\n+$/, "\n"))
      outcomes.push({
        file,
        format,
        action: "removed",
        backupPath: backup,
      })
    }
  }

  return outcomes
}

export async function checkRules(
  agent: AgentEntry,
  options: CheckRulesOptions = {}
): Promise<RuleFileCheck[]> {
  const projectRoot = normalizeProjectRoot(options.projectRoot)
  const checks: RuleFileCheck[] = []

  for (const { format, file, target } of await getRuleFilePaths(agent, projectRoot)) {
    let exists = false
    try {
      await access(target)
      exists = true
    } catch {
      // file does not exist
    }

    if (!exists) {
      checks.push({ file, format, state: "missing" })
      continue
    }

    const content = await readFile(target, "utf-8")
    const blocks = extractBlocks(content)

    if (blocks.length === 0) {
      checks.push({ file, format, state: "untracked" })
      continue
    }

    for (const block of blocks) {
      const actualSha = hashBody(block.body)
      if (actualSha === block.declaredSha) {
        checks.push({
          file,
          format,
          state: "valid",
          version: block.version,
          sha: block.declaredSha,
        })
      } else {
        checks.push({
          file,
          format,
          state: "diverged",
          version: block.version,
          sha: `${block.declaredSha} (actual ${actualSha})`,
        })
      }
    }
  }

  return checks
}
