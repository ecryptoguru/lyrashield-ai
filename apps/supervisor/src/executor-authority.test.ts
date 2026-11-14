import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AuthorityFenceError,
  PostgresScanAuthorityFence,
  type AuthorityAction,
  type ExecutorSpec,
  type ResourceOwnership,
} from "@lyrashield/runtime-control"
import { DockerRuntimeExecutor, LinuxProcessExecutor } from "./executor"

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root() {
  const path = await mkdtemp(join(tmpdir(), "executor-authority-"))
  roots.push(path)
  return path
}

const context = {
  attemptId: "attempt-test",
  commandId: "command-test",
  assertActive: () => {
    throw new Error("authority expired")
  },
}
const containerSpec: ExecutorSpec = {
  kind: "container",
  image: `example@sha256:${"a".repeat(64)}`,
  argv: [],
  env: {},
  network: "sandbox",
  cpus: 1,
  memoryMb: 128,
  pidsLimit: 32,
  readOnly: true,
  grantEnvName: "LLM_API_KEY",
}
const ownership: ResourceOwnership = {
  executorKey: "engine",
  kind: "container",
  ownershipId: `own_${"a".repeat(40)}`,
  containerId: "b".repeat(64),
}

async function fakeDocker(path: string) {
  const marker = join(path, "docker-mutated")
  const executable = join(path, "docker")
  await writeFile(
    executable,
    `#!/bin/sh\nif [ "$1" = create ] || [ "$1" = start ]; then\n  touch '${marker}'\n  [ "$1" = create ] && printf '%s\\n' '${"b".repeat(64)}'\nfi\nexit 0\n`
  )
  await chmod(executable, 0o700)
  vi.stubEnv("PATH", `${path}:${process.env.PATH}`)
  return marker
}

describe("executor authority at the mutation boundary", () => {
  it("does not create a container after the ownership lookup outlives authority", async () => {
    const path = await root()
    const marker = await fakeDocker(path)
    await expect(
      new DockerRuntimeExecutor().create("engine", containerSpec, context)
    ).rejects.toThrow("authority expired")
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("checks authority again immediately before invoking container creation", async () => {
    const path = await root()
    const marker = await fakeDocker(path)
    const assertActive = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error("authority expired")
      })
    await expect(
      new DockerRuntimeExecutor().create("engine", containerSpec, { ...context, assertActive })
    ).rejects.toThrow("authority expired")
    expect(assertActive).toHaveBeenCalledTimes(2)
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not start a container after inspection outlives authority", async () => {
    const path = await root()
    const marker = await fakeDocker(path)
    const executor = new DockerRuntimeExecutor()
    vi.spyOn(executor, "inspect").mockResolvedValue({ state: "PRESENT", running: false, ownership })
    await expect(executor.start(ownership, containerSpec, context)).rejects.toThrow(
      "authority expired"
    )
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not start after a native fence session closes during inspection", async () => {
    const path = await root()
    const marker = await fakeDocker(path)
    const executor = new DockerRuntimeExecutor()
    let entered: () => void = () => undefined
    let resume: () => void = () => undefined
    const checking = new Promise<void>((resolve) => {
      entered = resolve
    })
    const finishCheck = new Promise<void>((resolve) => {
      resume = resolve
    })
    vi.spyOn(executor, "inspect").mockImplementation(async () => {
      entered()
      await finishCheck
      return { state: "PRESENT", running: false, ownership }
    })
    const events = new EventEmitter()
    const connection = {
      on: events.on.bind(events),
      off: events.off.bind(events),
      release: vi.fn(),
      query: async (sql: string) => ({
        rows: sql.includes("acquire_scan")
          ? [{ acquired: true }]
          : sql.includes("gate_held")
            ? [{ held: true, nowMs: String(Date.now()) }]
            : [],
      }),
    }
    const fence = new PostgresScanAuthorityFence(
      { connect: async () => connection, query: connection.query },
      async () => ({ deadlineAt: new Date(Date.now() + 5_000) })
    )
    const binding: AuthorityAction = {
      phase: "EXECUTOR_START",
      operationId: "operation-1",
      attemptId: "attempt-test",
      scanId: "scan-1",
      workspaceId: "workspace-1",
      authorityEpochId: "epoch-1",
      authorityRevision: 1,
      commandId: "command-test",
      executorKey: "engine",
      authorityChecksum: "a".repeat(64),
      actionChecksum: "b".repeat(64),
    }
    let lateStart: Promise<ResourceOwnership> | undefined
    const fenced = fence.run(binding, (assertActive) => {
      lateStart = executor.start(ownership, containerSpec, { ...context, assertActive })
      return lateStart
    })
    const fencedResult = fenced.catch((error: unknown) => error)
    await checking
    events.emit("end")
    expect(await fencedResult).toBeInstanceOf(AuthorityFenceError)
    resume()
    await expect(lateStart).rejects.toBeInstanceOf(AuthorityFenceError)
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it("does not create a cgroup after the filesystem lookup outlives authority", async () => {
    const path = await root()
    const executor = new LinuxProcessExecutor(path)
    Object.defineProperty(executor, "qualified", { value: true })
    const cgroupPath = join(path, "group")
    const spec: ExecutorSpec = {
      kind: "process",
      command: "/usr/bin/true",
      args: [],
      cwd: path,
      cgroupPath,
      env: {},
      grantEnvName: "LLM_API_KEY",
    }
    await expect(executor.create("engine", spec, context)).rejects.toThrow("authority expired")
    await expect(readFile(cgroupPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not spawn a process after the cgroup lookup outlives authority", async () => {
    const path = await root()
    const executor = new LinuxProcessExecutor(path)
    Object.defineProperty(executor, "qualified", { value: true })
    await writeFile(join(path, "cgroup.procs"), "")
    const spec: ExecutorSpec = {
      kind: "process",
      command: "/usr/bin/true",
      args: [],
      cwd: path,
      cgroupPath: path,
      env: {},
      grantEnvName: "LLM_API_KEY",
    }
    const processOwnership: ResourceOwnership = {
      executorKey: "engine",
      kind: "process",
      ownershipId: ownership.ownershipId,
      cgroupPath: path,
    }
    await expect(executor.start(processOwnership, spec, context)).rejects.toThrow(
      "authority expired"
    )
  })

  it("checks authority again immediately before spawning a process", async () => {
    const path = await root()
    const executor = new LinuxProcessExecutor(path)
    Object.defineProperty(executor, "qualified", { value: true })
    await writeFile(join(path, "cgroup.procs"), "")
    const spec: ExecutorSpec = {
      kind: "process",
      command: "/usr/bin/true",
      args: [],
      cwd: path,
      cgroupPath: path,
      env: {},
      grantEnvName: "LLM_API_KEY",
    }
    const processOwnership: ResourceOwnership = {
      executorKey: "engine",
      kind: "process",
      ownershipId: ownership.ownershipId,
      cgroupPath: path,
    }
    const assertActive = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error("authority expired")
      })
    await expect(
      executor.start(processOwnership, spec, { ...context, assertActive })
    ).rejects.toThrow("authority expired")
    expect(assertActive).toHaveBeenCalledTimes(2)
  })
})
