/* eslint-disable security/detect-non-literal-fs-filename -- private metadata-only snapshot; validated relative paths */
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, posix } from "node:path"
import { z } from "zod"
import {
  GoMetadataBroker,
  GO_RESOLVER_LIMITS,
  missingGoMetadataPaths,
  type GoMetadataReceipt,
} from "./go-metadata-broker"
import type { EcosystemResolution } from "./ecosystem-lock-parsers"

// Official multi-platform index, inspected and fixture-qualified 2026-10-30.
export const GO_RESOLVER_IMAGE =
  "golang:1.26.8-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c"
export const GO_RESOLVER_TOOLCHAIN = "go1.26.8"
const INPUT_NAMES = new Set(["go.mod", "go.sum", "go.work", "go.work.sum"])
const exactVersion = /^v\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/
const moduleIdentity = z.object({
  Path: z.string().min(1),
  Version: z.string().optional(),
  GoModSum: z.string().optional(),
})
const editedModule = z.object({
  Replace: z
    .array(z.object({ New: moduleIdentity }))
    .nullable()
    .optional(),
  Use: z
    .array(z.object({ DiskPath: z.string() }))
    .nullable()
    .optional(),
})
const listedModule = moduleIdentity.extend({
  Main: z.boolean().optional(),
  Replace: moduleIdentity.optional(),
  Error: z.unknown().optional(),
  GoModSum: z.string().optional(),
})
export interface GoResolutionReceipt {
  schemaVersion: 1
  image: string
  toolchain: string | null
  expectedToolchain: string
  inputs: Array<{ path: string; sha256: string }>
  metadata: GoMetadataReceipt[]
  outputSha256?: string
  status: "COMPLETE" | "PARTIAL" | "UNSUPPORTED"
}
export interface GoResolution extends EcosystemResolution {
  receipt: GoResolutionReceipt
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function parseGoJsonStream(content: string): unknown[] {
  if (Buffer.byteLength(content) > 4 * 1024 * 1024)
    throw new Error("Go metadata output byte limit reached")
  const objects: unknown[] = []
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    if (start < 0) {
      if (/\s/.test(char!)) continue
      if (char !== "{") throw new Error("Malformed Go metadata output")
      start = i
      depth = 1
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) {
      objects.push(JSON.parse(content.slice(start, i + 1)))
      start = -1
    }
    if (objects.length > GO_RESOLVER_LIMITS.modules) throw new Error("Go module limit reached")
  }
  if (start >= 0) throw new Error("Incomplete Go metadata output")
  if (!objects.length) throw new Error("Go metadata output is missing")
  return objects
}
export function validateGoLocalPath(directory: string, path: string, inputs: Set<string>): string {
  if (path.includes("\\") || posix.isAbsolute(path))
    throw new Error("Go local path escapes the snapshot")
  const target = posix.normalize(posix.join(directory, path))
  if (target === ".." || target.startsWith("../") || !inputs.has(posix.join(target, "go.mod")))
    throw new Error("Go local path is outside the contained metadata snapshot")
  return target
}
export function buildGoSandboxArgs(config: {
  name: string
  input: string
  proxy: string
  directory: string
  command: string[]
  workspace?: string
}): string[] {
  const uid = process.getuid?.()
  if (!uid) throw new Error("Go resolver requires a non-root worker user")
  return [
    "run",
    "--rm",
    "--pull=never",
    `--name=${config.name}`,
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--user=${uid}:${uid}`,
    "--pids-limit=64",
    "--memory=256m",
    "--cpus=1",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777",
    "--mount",
    `type=bind,src=${config.input},dst=/input`,
    "--mount",
    `type=bind,src=${config.proxy},dst=/proxy,readonly`,
    "--workdir",
    posix.join("/input", config.directory),
    ...[
      "HOME=/tmp",
      "GOPATH=/tmp/go",
      "GOCACHE=/tmp/cache",
      "GOMODCACHE=/tmp/modules",
      "GOTOOLCHAIN=local",
      "GOVCS=*:off",
      "GOPROXY=file:///proxy",
      "GOSUMDB=off",
      "GOPRIVATE=",
      "GONOPROXY=",
      "GONOSUMDB=",
      "GOENV=off",
      "GOFLAGS=",
      "CGO_ENABLED=0",
      "GOTELEMETRY=off",
      `GOWORK=${config.workspace ? posix.join("/input", config.workspace) : "off"}`,
    ].flatMap((value) => ["--env", value]),
    "--entrypoint",
    config.command[0]!,
    GO_RESOLVER_IMAGE,
    ...config.command.slice(1),
  ]
}
function docker(
  args: string[],
  timeout: number,
  signal?: AbortSignal
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    execFile(
      "docker",
      args,
      { timeout, signal, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr })
    )
  )
}
async function runSandbox(
  config: Parameters<typeof buildGoSandboxArgs>[0],
  deadline: number,
  signal?: AbortSignal
) {
  const remaining = deadline - Date.now()
  if (remaining <= 0 || signal?.aborted) throw new Error("Go resolution deadline or cancellation")
  try {
    const output = await docker(buildGoSandboxArgs(config), remaining, signal)
    if (signal?.aborted || Date.now() >= deadline)
      throw new Error("Go resolution deadline or cancellation")
    return output
  } finally {
    await docker(["rm", "--force", config.name], 5000)
  }
}

function validateGoInputs(inputs: Map<string, string>, receipt: GoResolutionReceipt): void {
  let bytes = 0
  for (const [path, content] of inputs) {
    if (
      !INPUT_NAMES.has(basename(path)) ||
      path.includes("\\") ||
      path.startsWith("/") ||
      path.split("/").some((part) => part === ".." || !part) ||
      path.includes(",") ||
      /[\x00-\x1f]/.test(path) ||
      posix.normalize(path) !== path
    )
      throw new Error("Unsupported Go metadata input path")
    bytes += Buffer.byteLength(content)
    if (
      Buffer.byteLength(content) > 512 * 1024 ||
      bytes > GO_RESOLVER_LIMITS.bytes ||
      inputs.size > GO_RESOLVER_LIMITS.modules * 4
    )
      throw new Error("Go metadata input budget exhausted")
    receipt.inputs.push({ path, sha256: hash(content) })
  }
}

type GoRunner = (
  directory: string,
  command: string[],
  workspace?: string
) => ReturnType<typeof runSandbox>
async function goContexts(
  inputs: Map<string, string>,
  mods: string[],
  works: string[],
  run: GoRunner
) {
  const contexts: Array<{ directory: string; file: string; workspace?: string }> = []
  const workspaceMembers = new Set<string>()
  // Native metadata parsing preserves quoted paths, excludes and replacement syntax.
  for (const file of [...works, ...mods]) {
    const directory = dirname(file)
    const edited = await run(directory, [
      "go",
      basename(file) === "go.work" ? "work" : "mod",
      "edit",
      "-json",
      posix.join("/input", file),
    ])
    if (!edited.ok) throw new Error("Go input cannot be parsed with the pinned local toolchain")
    const parsed = editedModule.parse(JSON.parse(edited.stdout))
    for (const replacement of parsed.Replace ?? []) {
      if (replacement.New.Version) {
        if (!exactVersion.test(replacement.New.Version))
          throw new Error("Mutable Go replacement is unsupported")
      } else validateGoLocalPath(directory, replacement.New.Path, new Set(inputs.keys()))
    }
    if (basename(file) === "go.work") {
      for (const member of parsed.Use ?? [])
        workspaceMembers.add(
          posix.join(
            validateGoLocalPath(directory, member.DiskPath, new Set(inputs.keys())),
            "go.mod"
          )
        )
      contexts.push({ directory, file, workspace: file })
    }
  }
  for (const file of mods)
    if (!workspaceMembers.has(file)) contexts.push({ directory: dirname(file), file })
  return contexts
}

function collectGoPackages(stdout: string, file: string, result: GoResolution): void {
  const issue = (reason: string, name = file) =>
    result.unresolved.push({ ecosystem: "Go", name, reason })
  const listed = parseGoJsonStream(stdout).map((value) => listedModule.parse(value))
  if (!listed.some((value) => value.Main))
    throw new Error("Go selected module output is missing its main module")
  for (const value of listed) {
    const selectedModule = listedModule.parse(value)
    if (selectedModule.Main) continue
    if (selectedModule.Error) {
      issue("Go module graph contains an unresolved module", file)
      continue
    }
    const selected = selectedModule.Replace ?? selectedModule
    if (!selected.Version || !exactVersion.test(selected.Version)) {
      issue(
        "Go local or mutable replacement has no exact public release identity",
        selectedModule.Path
      )
      continue
    }
    result.packages.push({
      name: selected.Path,
      version: selected.Version,
      ecosystem: "Go",
      filePath: file,
      source: "https://proxy.golang.org",
      ...(selected.GoModSum ? { checksum: selected.GoModSum } : {}),
      ...(selectedModule.Replace
        ? { replaces: { name: selectedModule.Path, version: selectedModule.Version } }
        : {}),
    })
    if (result.packages.length > GO_RESOLVER_LIMITS.modules)
      throw new Error("Go selected module limit reached")
  }
}

/** Execute only Go metadata commands on copied manifests; no repository source,
 * credentials, source archives, toolchain downloads or network enter the capsule.
 * The pre-provisioned digest must exist locally or resolution remains unsupported.
 */
export async function resolveGoModules(
  inputs: Map<string, string>,
  options: { signal?: AbortSignal; deadline?: number; broker?: GoMetadataBroker } = {}
): Promise<GoResolution> {
  const deadline = Math.min(
    options.deadline ?? Infinity,
    Date.now() + GO_RESOLVER_LIMITS.milliseconds
  )
  const result: GoResolution = {
    packages: [],
    unresolved: [],
    receipt: {
      schemaVersion: 1,
      image: GO_RESOLVER_IMAGE,
      toolchain: null,
      expectedToolchain: GO_RESOLVER_TOOLCHAIN,
      inputs: [],
      metadata: [],
      status: "UNSUPPORTED",
    },
  }
  const issue = (reason: string, name = "go.mod") =>
    result.unresolved.push({ ecosystem: "Go", name, reason })
  const inputBytes = [...inputs.values()].reduce(
    (sum, content) => sum + Buffer.byteLength(content),
    0
  )
  const broker =
    options.broker ??
    new GoMetadataBroker(deadline, options.signal, undefined, {
      modules: GO_RESOLVER_LIMITS.modules,
      bytes: Math.max(0, GO_RESOLVER_LIMITS.bytes - inputBytes),
    })
  let root: string | undefined
  try {
    if (options.signal?.aborted || Date.now() >= deadline)
      throw new Error("Go resolution deadline or cancellation")
    validateGoInputs(inputs, result.receipt)
    const mods = [...inputs.keys()].filter((path) => basename(path) === "go.mod")
    const works = [...inputs.keys()].filter((path) => basename(path) === "go.work")
    if (!mods.length) throw new Error("Go checksums alone do not identify a selected module graph")
    root = await mkdtemp(join(tmpdir(), "lyrashield-go-resolver-"))
    const input = join(root, "input"),
      proxy = join(root, "proxy")
    await mkdir(input, { mode: 0o700 })
    await chmod(input, 0o700)
    await mkdir(proxy, { mode: 0o700 })
    for (const [path, content] of inputs) {
      const destination = join(input, path)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await chmod(dirname(destination), 0o700)
      await writeFile(destination, content, { mode: 0o600 })
      await chmod(destination, 0o600)
    }
    const run = (directory: string, command: string[], workspace?: string) =>
      runSandbox(
        { name: `lyrashield-go-${randomUUID()}`, input, proxy, directory, command, workspace },
        deadline,
        options.signal
      )
    const version = await run(".", ["go", "version"])
    if (!version.ok || !version.stdout.startsWith(`go version ${GO_RESOLVER_TOOLCHAIN} `))
      throw new Error("Pinned Go resolver image or toolchain is unavailable")
    result.receipt.toolchain = GO_RESOLVER_TOOLCHAIN
    const contexts = await goContexts(inputs, mods, works, run)
    const outputs: string[] = []
    const downloaded = new Set<string>()
    for (const context of contexts) {
      let completed = false
      for (let attempt = 0; attempt <= GO_RESOLVER_LIMITS.modules; attempt++) {
        const command = [
          "go",
          "list",
          "-m",
          "-json",
          ...(!context.workspace ? ["-mod=mod"] : []),
          "all",
        ]
        const output = await run(context.directory, command, context.workspace)
        if (output.ok) {
          outputs.push(output.stdout)
          collectGoPackages(output.stdout, context.file, result)
          completed = true
          break
        }
        const missing = missingGoMetadataPaths(output.stderr)
        if (!missing.length)
          throw new Error(
            "Go module graph is unavailable, inconsistent or requires unsupported metadata"
          )
        if (missing.every((path) => downloaded.has(path)))
          throw new Error("Go metadata resolution made no progress")
        for (const path of missing) {
          const content = await broker.get(path)
          const destination = join(proxy, path)
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
          await writeFile(destination, content, { mode: 0o600 })
          downloaded.add(path)
        }
      }
      if (!completed) throw new Error("Go module resolution iteration limit reached")
    }
    result.receipt.outputSha256 = hash(outputs.join("\n"))
  } catch (error) {
    issue(
      error instanceof Error && !error.message.includes("\n") && error.message.length < 160
        ? error.message
        : "Go module resolution failed"
    )
  } finally {
    if (root) await rm(root, { recursive: true, force: true })
  }
  result.packages = result.packages.slice(0, GO_RESOLVER_LIMITS.modules)
  result.receipt.inputs.sort((a, b) => a.path.localeCompare(b.path))
  result.receipt.metadata = broker.receipts
  result.receipt.status = result.unresolved.length
    ? result.packages.length
      ? "PARTIAL"
      : "UNSUPPORTED"
    : "COMPLETE"
  return result
}
