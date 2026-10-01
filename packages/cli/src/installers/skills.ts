/* eslint-disable security/detect-non-literal-fs-filename */
import { createHash, randomUUID } from "node:crypto"
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { AgentEntry, ConfigLocation } from "@lyrashield/agent-registry"
import { getPluginDir } from "@lyrashield/agent-plugin"

const OWNER = "lyrashield-agent-skills"
const HASH_RE = /^[a-f0-9]{64}$/

interface SkillManifest {
  owner: typeof OWNER
  version: 1
  files: Record<string, string>
}

interface ManifestSnapshot {
  manifest: SkillManifest
  checksum: string
}

export interface SkillAction {
  action:
    | "installed"
    | "updated"
    | "unchanged"
    | "skipped"
    | "removed"
    | "would-install"
    | "would-update"
    | "would-remove"
  file: string
  reason?: string
}

export interface SkillInstallResult {
  agent: string
  displayName: string
  outcome: "INSTALLED" | "REMOVED" | "PARTIAL" | "NOOP" | "DRY_RUN" | "FAILED"
  path?: string
  actions: SkillAction[]
  message?: string
}

interface SkillOperationOptions {
  agent: AgentEntry
  scope: "project" | "global"
  cwd?: string
  homeDir?: string
  dryRun?: boolean
}

function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex")
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

export function resolveSkillLocation(
  loc: ConfigLocation,
  opts: {
    cwd?: string
    homeDir?: string
    platform?: NodeJS.Platform
  } = {}
): string {
  const platform = opts.platform ?? process.platform
  const selected = loc.platform?.[platform as "darwin" | "linux" | "win32"] ?? loc.path
  const home = opts.homeDir ?? homedir()
  const expanded =
    selected === "~" || selected.startsWith("~/") || selected.startsWith("~\\")
      ? path.join(home, selected.slice(1))
      : selected
  if (path.isAbsolute(expanded)) return path.resolve(expanded)
  return path.resolve(loc.scope === "global" ? home : (opts.cwd ?? process.cwd()), expanded)
}

async function assertSafePath(target: string, scopeRoot: string, minimumDepth = 1): Promise<void> {
  const root = path.resolve(scopeRoot)
  const resolved = path.resolve(target)
  const relative = path.relative(root, resolved)
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).length < minimumDepth
  ) {
    throw new Error(`Refusing skill path outside its scope root: ${target}`)
  }

  const realRoot = await realpath(root)
  let current = root
  const segments = relative.split(path.sep)
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!)
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!entry) break
    if (entry.isSymbolicLink()) throw new Error(`Refusing skill path through symlink: ${current}`)
    if (index < segments.length - 1 && !entry.isDirectory()) {
      throw new Error(`Refusing skill path through non-directory: ${current}`)
    }
    const actual = await realpath(current)
    if (!isInside(realRoot, actual)) {
      throw new Error(`Refusing skill path outside its real scope root: ${target}`)
    }
  }
}

function validateRelativeFile(relative: string): string[] {
  if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative)) {
    throw new Error(`Invalid skill manifest path: ${relative}`)
  }
  const segments = relative.split("/")
  if (segments.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid skill manifest path: ${relative}`)
  }
  return segments
}

async function collectSkillFiles(sourceRoot: string): Promise<Map<string, Buffer>> {
  const rootInfo = await lstat(sourceRoot)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("The bundled LyraShield skill directory is missing or unsafe.")
  }

  const files = new Map<string, Buffer>()
  const skills = await readdir(sourceRoot, { withFileTypes: true })
  for (const skill of skills) {
    if (
      skill.isSymbolicLink() ||
      !skill.isDirectory() ||
      !/^[a-z0-9][a-z0-9-]*$/.test(skill.name)
    ) {
      throw new Error(`Invalid entry in bundled skills: ${skill.name}`)
    }
    let foundSkillFile = false
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error(`Bundled skill contains a symlink: ${fullPath}`)
        if (entry.isDirectory()) {
          await visit(fullPath)
          continue
        }
        if (!entry.isFile()) throw new Error(`Bundled skill contains a non-file entry: ${fullPath}`)
        const relative = path.relative(sourceRoot, fullPath).split(path.sep).join("/")
        validateRelativeFile(relative)
        if (relative === `${skill.name}/SKILL.md`) foundSkillFile = true
        files.set(relative, await readFile(fullPath))
      }
    }
    await visit(path.join(sourceRoot, skill.name))
    if (!foundSkillFile) throw new Error(`Bundled skill ${skill.name} has no SKILL.md.`)
  }
  if (files.size === 0) throw new Error("No shared LyraShield skills are bundled in this CLI.")
  return files
}

async function readManifest(manifestPath: string): Promise<ManifestSnapshot | undefined> {
  const stat = await lstat(manifestPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!stat) return undefined
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing unsafe skill ownership manifest: ${manifestPath}`)
  }
  let raw: string
  let parsed: unknown
  try {
    raw = await readFile(manifestPath, "utf8")
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Refusing unreadable skill ownership manifest: ${manifestPath}`)
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as SkillManifest).owner !== OWNER ||
    (parsed as SkillManifest).version !== 1 ||
    !(parsed as SkillManifest).files ||
    typeof (parsed as SkillManifest).files !== "object" ||
    Array.isArray((parsed as SkillManifest).files)
  ) {
    throw new Error(`Refusing unrecognized skill ownership manifest: ${manifestPath}`)
  }
  const manifest = parsed as SkillManifest
  for (const [relative, checksum] of Object.entries(manifest.files)) {
    validateRelativeFile(relative)
    if (!HASH_RE.test(checksum)) throw new Error(`Invalid checksum in skill manifest: ${relative}`)
  }
  return { manifest, checksum: hash(raw) }
}

async function assertManifestUnchanged(
  manifestPath: string,
  previous: ManifestSnapshot | undefined
): Promise<void> {
  const current = await fileChecksum(manifestPath)
  if (previous ? current !== previous.checksum : current !== undefined) {
    throw new Error(
      previous
        ? "LyraShield skill ownership manifest changed during the operation; the new manifest was not written."
        : "A file appeared at the LyraShield skill ownership manifest path; it was preserved."
    )
  }
}

async function atomicWrite(
  filePath: string,
  content: Buffer | string,
  expectedChecksum?: string
): Promise<void> {
  const temporary = `${filePath}.lyrashield-${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: "wx" })
    if (expectedChecksum && (await fileChecksum(filePath)) !== expectedChecksum) {
      throw Object.assign(new Error("File changed during installation."), {
        code: "LYRASHIELD_OWNERSHIP_CHANGED",
      })
    }
    await rename(temporary, filePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function atomicCreate(filePath: string, content: Buffer | string): Promise<void> {
  const temporary = `${filePath}.lyrashield-${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: "wx" })
    // link() is exclusive: a file created after our earlier existence check is preserved.
    await link(temporary, filePath)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function fileChecksum(filePath: string): Promise<string | undefined> {
  const stat = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!stat) return undefined
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing non-regular skill file: ${filePath}`)
  }
  return hash(await readFile(filePath))
}

function getTarget(options: SkillOperationOptions): {
  root: string
  scopeRoot: string
  home: string
} {
  const locations = (options.agent.skillLocations ?? []).filter(
    (loc) => loc.scope === options.scope
  )
  if (locations.length !== 1) {
    throw new Error(
      locations.length === 0
        ? `No ${options.scope} skill installation path is documented for ${options.agent.displayName}.`
        : `More than one ${options.scope} skill path is documented for ${options.agent.displayName}; install manually to the selected client path.`
    )
  }
  const location = locations[0]!
  const home = options.homeDir ?? homedir()
  const scopeRoot = options.scope === "global" ? home : (options.cwd ?? process.cwd())
  const root = resolveSkillLocation(location, { cwd: options.cwd, homeDir: home })
  return { root, scopeRoot, home }
}

async function prepareTarget(
  options: SkillOperationOptions,
  create = true
): Promise<{ root: string; scopeRoot: string; manifestPath: string; manifestScopeRoot: string }> {
  const { root, scopeRoot, home } = getTarget(options)
  await assertSafePath(root, scopeRoot, 2)
  if (create && !options.dryRun) {
    await mkdir(root, { recursive: true })
    await assertSafePath(root, scopeRoot, 2)
  }
  // Keep ownership state outside the project tree so repository files cannot claim it.
  const manifestRoot = path.join(home, ".lyrashield", "skills")
  const manifestPath = path.join(manifestRoot, `${hash(root)}.json`)
  await assertSafePath(manifestPath, home, 3)
  if (create && !options.dryRun) {
    await mkdir(manifestRoot, { recursive: true, mode: 0o700 })
    await assertSafePath(manifestPath, home, 3)
  }
  return { root, scopeRoot, manifestPath, manifestScopeRoot: home }
}

async function getChildPath(root: string, relative: string, scopeRoot: string): Promise<string> {
  const segments = validateRelativeFile(relative)
  const fullPath = path.resolve(root, ...segments)
  if (!isInside(root, fullPath))
    throw new Error(`Refusing skill path outside installation root: ${relative}`)
  await assertSafePath(fullPath, scopeRoot, 2 + segments.length)
  return fullPath
}

function outcomeFor(actions: SkillAction[], dryRun = false): SkillInstallResult["outcome"] {
  if (dryRun) return "DRY_RUN"
  if (actions.some((action) => action.action === "skipped")) return "PARTIAL"
  if (actions.some((action) => action.action === "installed" || action.action === "updated")) {
    return "INSTALLED"
  }
  if (actions.some((action) => action.action === "removed")) return "REMOVED"
  return "NOOP"
}

export async function installAgentSkills(
  options: SkillOperationOptions
): Promise<SkillInstallResult> {
  const { agent } = options
  const actions: SkillAction[] = []
  try {
    const { root, scopeRoot, manifestPath, manifestScopeRoot } = await prepareTarget(options)
    const sourceRoot = path.join(getPluginDir(), "skills")
    const sourceFiles = await collectSkillFiles(sourceRoot)
    const manifestSnapshot = await readManifest(manifestPath)
    const ownedFiles = { ...(manifestSnapshot?.manifest.files ?? {}) }

    for (const [relative, content] of sourceFiles) {
      const target = await getChildPath(root, relative, scopeRoot)
      const sourceHash = hash(content)
      const currentHash = await fileChecksum(target)
      const priorHash = ownedFiles[relative]
      if (currentHash === undefined) {
        actions.push({ action: options.dryRun ? "would-install" : "installed", file: target })
        if (!options.dryRun) {
          await mkdir(path.dirname(target), { recursive: true })
          await assertSafePath(target, scopeRoot, 2 + validateRelativeFile(relative).length)
          try {
            await atomicCreate(target, content)
            ownedFiles[relative] = sourceHash
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              actions[actions.length - 1] = {
                action: "skipped",
                file: target,
                reason: "a file appeared during installation; it was preserved",
              }
            } else {
              throw error
            }
          }
        }
      } else if (priorHash === undefined) {
        actions.push({
          action: "skipped",
          file: target,
          reason: "existing skill file is not recorded as LyraShield-owned; it was preserved",
        })
      } else if (currentHash !== priorHash) {
        actions.push({
          action: "skipped",
          file: target,
          reason: "skill file was customized after installation; it was preserved",
        })
      } else if (currentHash === sourceHash) {
        actions.push({ action: "unchanged", file: target })
      } else {
        actions.push({ action: options.dryRun ? "would-update" : "updated", file: target })
        if (!options.dryRun) {
          await assertSafePath(target, scopeRoot, 2 + validateRelativeFile(relative).length)
          const confirmHash = await fileChecksum(target)
          if (confirmHash !== priorHash) {
            actions[actions.length - 1] = {
              action: "skipped",
              file: target,
              reason: "skill file changed during installation; it was preserved",
            }
            continue
          }
          try {
            await atomicWrite(target, content, priorHash)
            ownedFiles[relative] = sourceHash
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "LYRASHIELD_OWNERSHIP_CHANGED")
              throw error
            actions[actions.length - 1] = {
              action: "skipped",
              file: target,
              reason: "skill file changed during installation; it was preserved",
            }
          }
        }
      }
    }

    for (const [relative, priorHash] of Object.entries(ownedFiles)) {
      if (sourceFiles.has(relative)) continue
      const target = await getChildPath(root, relative, scopeRoot)
      const currentHash = await fileChecksum(target)
      if (currentHash === undefined) {
        delete ownedFiles[relative]
      } else if (currentHash !== priorHash) {
        actions.push({
          action: "skipped",
          file: target,
          reason: "removed upstream skill file was customized; it was preserved",
        })
      } else {
        actions.push({ action: options.dryRun ? "would-remove" : "removed", file: target })
        if (!options.dryRun) {
          await assertSafePath(target, scopeRoot, 2 + validateRelativeFile(relative).length)
          if ((await fileChecksum(target)) === priorHash) await rm(target)
          else {
            actions[actions.length - 1] = {
              action: "skipped",
              file: target,
              reason: "skill file changed during installation; it was preserved",
            }
            continue
          }
          delete ownedFiles[relative]
        }
      }
    }

    if (!options.dryRun && (manifestSnapshot || Object.keys(ownedFiles).length > 0)) {
      await assertSafePath(manifestPath, manifestScopeRoot, 3)
      await assertManifestUnchanged(manifestPath, manifestSnapshot)
      const body = `${JSON.stringify({ owner: OWNER, version: 1, files: ownedFiles } satisfies SkillManifest, null, 2)}\n`
      if (manifestSnapshot) await atomicWrite(manifestPath, body, manifestSnapshot.checksum)
      else await atomicCreate(manifestPath, body)
    }
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: outcomeFor(actions, options.dryRun),
      path: root,
      actions,
      message:
        "Local skill files do not confirm client discovery; restart or reload the client, then verify its skill list.",
    }
  } catch (error) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      actions,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function removeAgentSkills(
  options: SkillOperationOptions
): Promise<SkillInstallResult> {
  const { agent } = options
  const actions: SkillAction[] = []
  try {
    const { root, scopeRoot, manifestPath, manifestScopeRoot } = await prepareTarget(options, false)
    const manifestSnapshot = await readManifest(manifestPath)
    if (!manifestSnapshot) {
      return {
        agent: agent.id,
        displayName: agent.displayName,
        outcome: "NOOP",
        path: root,
        actions,
        message: "No LyraShield skill ownership manifest was found; no files were removed.",
      }
    }

    const ownedFiles = { ...manifestSnapshot.manifest.files }
    for (const [relative, checksum] of Object.entries(manifestSnapshot.manifest.files)) {
      const target = await getChildPath(root, relative, scopeRoot)
      const currentHash = await fileChecksum(target)
      if (currentHash === undefined) {
        delete ownedFiles[relative]
      } else if (currentHash !== checksum) {
        actions.push({
          action: "skipped",
          file: target,
          reason: "skill file was customized after installation; it was preserved",
        })
      } else {
        actions.push({ action: options.dryRun ? "would-remove" : "removed", file: target })
        if (!options.dryRun) {
          await assertSafePath(target, scopeRoot, 2 + validateRelativeFile(relative).length)
          if ((await fileChecksum(target)) === checksum) await rm(target)
          else {
            actions[actions.length - 1] = {
              action: "skipped",
              file: target,
              reason: "skill file changed during removal; it was preserved",
            }
            continue
          }
          delete ownedFiles[relative]
        }
      }
    }

    if (!options.dryRun && Object.keys(ownedFiles).length === 0) {
      await assertManifestUnchanged(manifestPath, manifestSnapshot)
      await rm(manifestPath)
    } else if (!options.dryRun) {
      await assertSafePath(manifestPath, manifestScopeRoot, 3)
      await assertManifestUnchanged(manifestPath, manifestSnapshot)
      await atomicWrite(
        manifestPath,
        `${JSON.stringify({ owner: OWNER, version: 1, files: ownedFiles } satisfies SkillManifest, null, 2)}\n`,
        manifestSnapshot.checksum
      )
    }
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: outcomeFor(actions, options.dryRun),
      path: root,
      actions,
      message: "Only unmodified files recorded in LyraShield's ownership manifest are removed.",
    }
  } catch (error) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      actions,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
