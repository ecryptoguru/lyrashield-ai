import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, rmdir } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import type {
  ExecutorKey,
  ExecutorSpec,
  ResourceInspection,
  ResourceOwnership,
} from "@lyrashield/runtime-control"
import { isWithin } from "./policy"

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 20_000
const MAX_COMMAND_OUTPUT = 256 * 1024

export interface ExecutorContext {
  attemptId: string
  commandId: string
}

export interface RuntimeExecutor {
  create(key: ExecutorKey, spec: ExecutorSpec, context: ExecutorContext): Promise<ResourceOwnership>
  start(
    ownership: ResourceOwnership,
    spec: ExecutorSpec,
    context: ExecutorContext
  ): Promise<ResourceOwnership>
  inspect(ownership: ResourceOwnership): Promise<ResourceInspection>
  stop(ownership: ResourceOwnership, graceMs?: number): Promise<ResourceInspection>
}

export class AmbiguousResourceError extends Error {
  readonly code = "AMBIGUOUS_RESOURCE"

  constructor(message: string) {
    super(message)
    this.name = "AmbiguousResourceError"
  }
}

export function deriveOwnershipId(attemptId: string, commandId: string, key: ExecutorKey): string {
  return `own_${createHash("sha256").update(`${attemptId}\0${commandId}\0${key}`).digest("hex").slice(0, 40)}`
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = Reflect.get(error, "code")
    return typeof code === "string" ? code : undefined
  }
  return undefined
}

function dockerUnavailable(error: unknown): boolean {
  const code = errorCode(error)
  return code === "ENOENT" || code === "ETIMEDOUT" || code === "ECONNREFUSED"
}

interface DockerInspect {
  Id?: unknown
  State?: { Running?: unknown }
}

async function listContainerIds(ownership: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=lyrashield.supervisor.ownership=${ownership}`,
    ],
    { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_COMMAND_OUTPUT }
  )
  return stdout.split(/\s+/).filter(Boolean)
}

export class DockerRuntimeExecutor implements RuntimeExecutor {
  async create(
    key: ExecutorKey,
    spec: ExecutorSpec,
    context: ExecutorContext
  ): Promise<ResourceOwnership> {
    if (spec.kind !== "container") throw new Error("docker executor requires a container spec")
    const ownership = deriveOwnershipId(context.attemptId, context.commandId, key)
    const existing = await listContainerIds(ownership)
    if (existing.length > 1)
      throw new AmbiguousResourceError("multiple containers match one ownership")
    if (existing.length === 1) {
      return {
        executorKey: key,
        kind: "container",
        ownershipId: ownership,
        containerId: existing[0]!,
        createdAt: new Date().toISOString(),
      }
    }
    const name = `lyrashield-supervisor-${ownership.slice(4, 36)}`
    const args = [
      "create",
      "--pull=never",
      "--name",
      name,
      "--label",
      `lyrashield.supervisor.attempt=${context.attemptId}`,
      "--label",
      `lyrashield.supervisor.ownership=${ownership}`,
      "--network",
      spec.network,
      "--cpus",
      String(spec.cpus),
      "--memory",
      `${spec.memoryMb}m`,
      "--pids-limit",
      String(spec.pidsLimit),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--init",
    ]
    if (spec.readOnly) args.push("--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m")
    for (const [keyName, value] of Object.entries(spec.env).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      args.push("--env", `${keyName}=${value}`)
    }
    args.push(spec.image, ...spec.argv)
    const { stdout } = await execFileAsync("docker", args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT,
    })
    const containerId = stdout.trim()
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
      throw new Error("docker create did not return an exact immutable container id")
    }
    return {
      executorKey: key,
      kind: "container",
      ownershipId: ownership,
      containerId,
      createdAt: new Date().toISOString(),
    }
  }

  async start(
    ownership: ResourceOwnership,
    _spec: ExecutorSpec,
    _context: ExecutorContext
  ): Promise<ResourceOwnership> {
    if (!ownership.containerId || !/^[a-f0-9]{12,64}$/.test(ownership.containerId)) {
      throw new Error("container ownership has no valid container id")
    }
    const inspection = await this.inspect(ownership)
    if (inspection.state === "UNKNOWN") throw new Error("container state is unavailable")
    if (inspection.state === "PRESENT" && inspection.running) return ownership
    await execFileAsync("docker", ["start", ownership.containerId], {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT,
    })
    return ownership
  }

  async inspect(ownership: ResourceOwnership): Promise<ResourceInspection> {
    try {
      const ids = await listContainerIds(ownership.ownershipId)
      if (ids.length === 0) return { state: "ABSENT" }
      if (ids.length > 1) return { state: "UNKNOWN", detail: "multiple containers match ownership" }
      const { stdout } = await execFileAsync("docker", ["container", "inspect", ids[0]!], {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_COMMAND_OUTPUT,
      })
      const parsed: unknown = JSON.parse(stdout)
      if (!Array.isArray(parsed) || parsed.length !== 1) {
        return { state: "UNKNOWN", detail: "container inspect is not a single record" }
      }
      const record = parsed[0]
      if (record === null || typeof record !== "object") {
        return { state: "UNKNOWN", detail: "container inspect is malformed" }
      }
      const inspectRecord: DockerInspect = record
      const id = typeof inspectRecord.Id === "string" ? inspectRecord.Id : ""
      if (!/^[a-f0-9]{64}$/.test(id)) {
        return { state: "UNKNOWN", detail: "container inspect has no exact id" }
      }
      return {
        state: "PRESENT",
        running: inspectRecord.State?.Running === true,
        ownership: { ...ownership, containerId: id },
      }
    } catch (error) {
      return dockerUnavailable(error)
        ? { state: "UNKNOWN", detail: "container daemon unavailable" }
        : { state: "UNKNOWN", detail: "container inspection failed" }
    }
  }

  async stop(ownership: ResourceOwnership): Promise<ResourceInspection> {
    if (ownership.kind !== "container") {
      return { state: "UNKNOWN", detail: "container executor received non-container ownership" }
    }
    let containerId = ownership.containerId
    if (!containerId) {
      const current = await this.inspect(ownership)
      if (current.state === "ABSENT") return current
      if (current.state === "UNKNOWN" || !current.ownership?.containerId) return current
      containerId = current.ownership.containerId
    }
    try {
      await execFileAsync("docker", ["container", "rm", "--force", containerId], {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_COMMAND_OUTPUT,
      })
    } catch {
      const afterFailure = await this.inspect(ownership)
      if (afterFailure.state === "ABSENT") return afterFailure
      return { state: "UNKNOWN", detail: "container removal failed" }
    }
    return this.inspect(ownership)
  }
}

function readPids(path: string): Promise<number[]> {
  // path is rooted in the configured cgroup hierarchy and resolved by the caller.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFile(path, "utf8").then((raw) =>
    raw
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  )
}

async function waitForPidsToExit(cgroupPath: string, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let pids = await readPids(resolve(cgroupPath, "cgroup.procs"))
  while (pids.length > 0 && Date.now() < deadline) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50))
    pids = await readPids(resolve(cgroupPath, "cgroup.procs"))
  }
  return pids
}

export class LinuxProcessExecutor implements RuntimeExecutor {
  // Process ownership and privilege separation are not yet qualified. This
  // is deliberately not configurable by request or environment.
  private readonly qualified = false
  constructor(
    private readonly allowedCgroupRoot: string,
    private readonly stopGraceMs = 2_000
  ) {}

  async create(
    key: ExecutorKey,
    spec: ExecutorSpec,
    context: ExecutorContext
  ): Promise<ResourceOwnership> {
    if (!this.qualified)
      throw new Error("process execution is held pending isolation qualification")
    if (spec.kind !== "process") throw new Error("process executor requires a process spec")
    if (!isWithin(resolve(this.allowedCgroupRoot), resolve(spec.cgroupPath))) {
      throw new Error("cgroup path is outside the supervisor root")
    }
    if (await this.pathExists(spec.cgroupPath)) {
      return {
        executorKey: key,
        kind: "process",
        ownershipId: deriveOwnershipId(context.attemptId, context.commandId, key),
        cgroupPath: spec.cgroupPath,
      }
    }
    // cgroupPath is validated against the configured supervisor root above.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(spec.cgroupPath, { recursive: false, mode: 0o700 })
    return {
      executorKey: key,
      kind: "process",
      ownershipId: deriveOwnershipId(context.attemptId, context.commandId, key),
      cgroupPath: spec.cgroupPath,
    }
  }

  async start(
    ownership: ResourceOwnership,
    spec: ExecutorSpec,
    _context: ExecutorContext
  ): Promise<ResourceOwnership> {
    if (!this.qualified)
      throw new Error("process execution is held pending isolation qualification")
    if (ownership.kind !== "process" || !ownership.cgroupPath || spec.kind !== "process") {
      throw new Error("process ownership has no usable cgroup spec")
    }
    const cgroupPath = resolve(ownership.cgroupPath)
    const procsPath = resolve(cgroupPath, "cgroup.procs")
    try {
      const existing = await readPids(procsPath)
      if (existing.length > 0) {
        return { ...ownership, processGroupId: existing[0] }
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    const script = 'printf "%s" "$$" > "$1" || exit 125; shift; exec "$@"'
    const child = spawn(
      "/bin/sh",
      ["-c", script, "lyrashield-owner", procsPath, spec.command, ...spec.args],
      {
        cwd: spec.cwd,
        detached: true,
        stdio: "ignore",
        env: {
          ...spec.env,
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LYRASHIELD_SUPERVISOR_OWNERSHIP: ownership.ownershipId,
        },
      }
    )
    if (!child.pid) throw new Error("process executor could not obtain a pid")
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("error", rejectSpawn)
      child.once("spawn", () => resolveSpawn())
    })
    return { ...ownership, processGroupId: child.pid }
  }

  async inspect(ownership: ResourceOwnership): Promise<ResourceInspection> {
    if (!this.qualified) return { state: "UNKNOWN", detail: "process ownership is not qualified" }
    if (ownership.kind !== "process" || !ownership.cgroupPath) {
      return { state: "UNKNOWN", detail: "process ownership has no cgroup" }
    }
    try {
      const exists = await this.pathExists(ownership.cgroupPath)
      if (!exists) return { state: "ABSENT" }
      const pids = await readPids(resolve(ownership.cgroupPath, "cgroup.procs"))
      return { state: "PRESENT", running: pids.length > 0, ownership }
    } catch {
      return { state: "UNKNOWN", detail: "process cgroup is unreadable", ownership }
    }
  }

  async stop(
    ownership: ResourceOwnership,
    graceMs = this.stopGraceMs
  ): Promise<ResourceInspection> {
    if (!this.qualified) return { state: "UNKNOWN", detail: "process ownership is not qualified" }
    if (ownership.kind !== "process" || !ownership.cgroupPath) {
      return { state: "UNKNOWN", detail: "process ownership has no cgroup" }
    }
    const procsPath = resolve(ownership.cgroupPath, "cgroup.procs")
    let pids: number[]
    try {
      if (!(await this.pathExists(ownership.cgroupPath))) return { state: "ABSENT" }
      pids = await readPids(procsPath)
    } catch {
      return { state: "UNKNOWN", detail: "process cgroup is unreadable" }
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM")
      } catch (error) {
        if (errorCode(error) !== "ESRCH") {
          // Permission errors mean ownership cannot be proven; continue with the
          // remaining descendants and let the final read decide the outcome.
        }
      }
    }
    if (ownership.processGroupId) {
      try {
        process.kill(-ownership.processGroupId, "SIGTERM")
      } catch {
        // The group may already be gone; the cgroup remains authoritative.
      }
    }
    let remaining = await waitForPidsToExit(ownership.cgroupPath, graceMs)
    for (const pid of remaining) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // A concurrent exit is harmless; verify the cgroup after signalling.
      }
    }
    if (ownership.processGroupId) {
      try {
        process.kill(-ownership.processGroupId, "SIGKILL")
      } catch {
        // The group may already be gone.
      }
    }
    remaining = await waitForPidsToExit(ownership.cgroupPath, 5_000)
    if (remaining.length > 0) {
      return { state: "UNKNOWN", detail: "owned descendants remain after SIGKILL" }
    }
    try {
      // ownership.cgroupPath is the exact configured process ownership root.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await rmdir(ownership.cgroupPath)
      return { state: "ABSENT" }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { state: "ABSENT" }
      return { state: "UNKNOWN", detail: "empty cgroup could not be removed" }
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      // path is the exact configured cgroup ownership root.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const metadata = await lstat(path)
      return metadata.isDirectory()
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false
      throw error
    }
  }
}
