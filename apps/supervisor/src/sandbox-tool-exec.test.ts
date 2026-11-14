import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type {
  AuthorityAction,
  JournalRecord,
  ResourceOwnership,
  ScanAuthorityFence,
} from "@lyrashield/runtime-control"
import { DockerRuntimeExecutor } from "./executor"
import { SandboxToolDocker } from "./sandbox-tool-docker"
import {
  sandboxToolExecChecksum,
  startSandboxToolExec,
  type SandboxToolExecScope,
} from "./sandbox-tool-exec"
import { SandboxToolJournal, type SandboxToolEvent } from "./sandbox-tool-journal"

const toolRequest = {
  binding: {
    attemptId: "attempt-1",
    operationId: "operation-1",
    authorityEpochId: "epoch-1",
    sandboxHandle: "sandbox-1",
  },
  requestId: "1d5b3040-b775-43a0-a7fb-ac5965fb91fa",
  commandId: "1d5b3040-b775-43a0-a7fb-ac5965fb91fa",
  argv: ["/bin/sh", "-c", "exit 0"],
  cwd: "/workspace",
  user: "pentester" as const,
  timeoutSeconds: 10,
  maxOutputBytes: 1024,
}
const ownership: ResourceOwnership = {
  kind: "container",
  executorKey: "sandbox",
  ownershipId: `own_${"a".repeat(40)}`,
  containerId: "b".repeat(64),
}
const action: AuthorityAction = {
  phase: "SANDBOX_TOOL",
  operationId: "operation-1",
  attemptId: "attempt-1",
  scanId: "scan-1",
  workspaceId: "workspace-1",
  authorityEpochId: "epoch-1",
  authorityRevision: 1,
  authorityChecksum: "c".repeat(64),
  actionChecksum: "d".repeat(64),
  commandId: "prepare-1",
  requestId: toolRequest.requestId,
  executorKey: "sandbox",
}
function scopeFor(resource: ResourceOwnership = ownership): SandboxToolExecScope {
  const scope = {
    action: { ...action },
    workspaceRoot: "/workspace",
    supervisorInstanceId: "supervisor-1.tools",
    ownership: resource,
  }
  scope.action.actionChecksum = sandboxToolExecChecksum(toolRequest, scope)
  return scope
}
function fixture() {
  const events: SandboxToolEvent[] = []
  const order: string[] = []
  const journal = {
    load: vi.fn(async () =>
      events.map((payload, index): JournalRecord<SandboxToolEvent> => ({
        version: 1,
        sequence: index + 1,
        previousHash: "0".repeat(64),
        payload,
        hash: "0".repeat(64),
        signature: "0".repeat(64),
      }))
    ),
    append: vi.fn(async (event: SandboxToolEvent) => {
      order.push(event.type)
      events.push(event)
    }),
  }
  const fence: ScanAuthorityFence = {
    run: async (_binding, effect) => effect(() => undefined, { guardId: "guard-1" }),
  }
  const docker = {
    inspect: vi.fn(async () => undefined),
    create: vi.fn(async () => {
      order.push("create")
      return "e".repeat(64)
    }),
    start: vi.fn(async () => {
      order.push("start")
    }),
  }
  const executor = {
    inspect: vi.fn(async (resource: ResourceOwnership) => ({
      state: "PRESENT",
      running: true,
      ownership: resource,
    })),
  }
  const deps = {
    fence,
    journal: journal as unknown as SandboxToolJournal,
    docker: docker as unknown as SandboxToolDocker,
    executor: executor as unknown as DockerRuntimeExecutor,
  }
  return { events, order, journal, docker, executor, deps }
}

describe("detached sandbox tool invocation", () => {
  it("records the exact Docker exec identity before its only start", async () => {
    const f = fixture()
    expect(await startSandboxToolExec(toolRequest, scopeFor(), f.deps)).toEqual({
      execId: "e".repeat(64),
    })
    expect(f.order).toEqual([
      "tool_intent",
      "create",
      "tool_created",
      "tool_starting",
      "start",
      "tool_started",
    ])
    expect(f.events[1]?.tool.execId).toBe("e".repeat(64))
    expect(f.events.every((event) => Reflect.get(event.tool, "maxOutputBytes") === 1024)).toBe(true)
    expect(f.docker.start).toHaveBeenCalledOnce()
  })

  it("holds fresh request IDs when start acknowledgement is lost", async () => {
    const f = fixture()
    f.docker.start.mockRejectedValueOnce(new Error("ack lost"))
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow("ack lost")
    const next = { ...toolRequest, requestId: "b7f2c35f-82d5-4fd3-80f1-dfa5f9d49f5b" }
    next.commandId = next.requestId
    const scope = scopeFor()
    scope.action.requestId = next.requestId
    scope.action.actionChecksum = sandboxToolExecChecksum(next, scope)
    await expect(startSandboxToolExec(next, scope, f.deps)).rejects.toThrow("unresolved")
    expect(f.docker.create).toHaveBeenCalledOnce()
    expect(f.docker.start).toHaveBeenCalledOnce()
  })

  it("holds a new client even when Docker acknowledged start but engine receipt is unproven", async () => {
    const f = fixture()
    await startSandboxToolExec(toolRequest, scopeFor(), f.deps)
    const next = { ...toolRequest, requestId: "b7f2c35f-82d5-4fd3-80f1-dfa5f9d49f5b" }
    next.commandId = next.requestId
    const scope = scopeFor()
    scope.action.requestId = next.requestId
    scope.action.actionChecksum = sandboxToolExecChecksum(next, scope)
    await expect(startSandboxToolExec(next, scope, f.deps)).rejects.toThrow("unresolved")
    expect(f.docker.create).toHaveBeenCalledOnce()
  })

  it("rejects a changed sandbox handle without invoking Docker", async () => {
    const f = fixture()
    const changed = {
      ...toolRequest,
      binding: { ...toolRequest.binding, sandboxHandle: "sandbox-2" },
    }
    await expect(startSandboxToolExec(changed, scopeFor(), f.deps)).rejects.toThrow("binding")
    expect(f.docker.create).not.toHaveBeenCalled()
  })

  it("uses the exact snapshotted ownership if the caller mutates its object during fencing", async () => {
    const f = fixture()
    const scope = scopeFor({ ...ownership })
    f.deps.fence = {
      run: async (_action, effect) => {
        scope.ownership.containerId = "f".repeat(64)
        scope.ownership.ownershipId = `own_${"f".repeat(40)}`
        return effect(() => undefined, { guardId: "guard-1" })
      },
    }
    await startSandboxToolExec(toolRequest, scope, f.deps)
    expect(f.docker.inspect).toHaveBeenCalledWith(ownership.containerId, ownership.ownershipId)
    expect(f.docker.create).toHaveBeenCalledWith(
      ownership.containerId,
      toolRequest.argv,
      "/workspace"
    )
    expect(f.events[0]?.tool.containerId).toBe(ownership.containerId)
  })

  it("rejects a different sandbox on the Docker socket", async () => {
    const f = fixture()
    f.docker.inspect.mockRejectedValueOnce(new Error("wrong daemon or sandbox"))
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "wrong daemon"
    )
    expect(f.docker.create).not.toHaveBeenCalled()
    expect(f.events).toEqual([])
  })

  it("does not invoke anything when the current action fence rejects", async () => {
    const f = fixture()
    f.deps.fence = {
      run: async () => {
        throw new Error("authority unavailable")
      },
    }
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "authority unavailable"
    )
    expect(f.journal.load).not.toHaveBeenCalled()
    expect(f.docker.create).not.toHaveBeenCalled()
  })

  it("does not invoke if the fence does not supply a committed guard", async () => {
    const f = fixture()
    f.deps.fence = { run: async (_binding, effect) => effect(() => undefined) }
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "durable sandbox invocation guard"
    )
    expect(f.journal.load).not.toHaveBeenCalled()
    expect(f.docker.create).not.toHaveBeenCalled()
  })

  it("never creates an exec if the original intent cannot be mirrored", async () => {
    const f = fixture()
    f.journal.append.mockRejectedValueOnce(new Error("mirror unavailable"))
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "mirror unavailable"
    )
    expect(f.docker.create).not.toHaveBeenCalled()
  })

  it("does not start when the native fence expires after Docker create", async () => {
    const f = fixture()
    let active = true
    f.deps.fence = {
      run: async (_action, effect) =>
        effect(
          () => {
            if (!active) throw new Error("fence expired")
          },
          { guardId: "guard-1" }
        ),
    }
    f.docker.create.mockImplementationOnce(async () => {
      active = false
      return "e".repeat(64)
    })
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "fence expired"
    )
    expect(f.events.map((event) => event.type)).toEqual(["tool_intent"])
    expect(f.docker.start).not.toHaveBeenCalled()
  })

  it("does not start if retaining the created exec ID loses its mirror acknowledgement", async () => {
    const f = fixture()
    f.journal.append.mockImplementationOnce(async (event) => {
      f.events.push(event)
    })
    f.journal.append.mockRejectedValueOnce(new Error("created record acknowledgement lost"))
    await expect(startSandboxToolExec(toolRequest, scopeFor(), f.deps)).rejects.toThrow(
      "acknowledgement lost"
    )
    expect(f.docker.create).toHaveBeenCalledOnce()
    expect(f.docker.start).not.toHaveBeenCalled()
  })
})

describe.runIf(!!process.env.LYRA_SANDBOX_TEST_DOCKER_SOCKET)("disposable Docker sandbox", () => {
  it("creates and starts the exact retained exec as pentester", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sandbox-tool-docker-"))
    const image = `sandbox-tool-test-${randomUUID()}`
    let containerId = ""
    try {
      writeFileSync(
        join(directory, "Dockerfile"),
        "FROM python:3.12-slim\nRUN useradd -m -u 10001 pentester && mkdir -p /workspace && chown pentester /workspace\n"
      )
      execFileSync("docker", ["build", "--network=none", "--pull=false", "-t", image, directory], {
        stdio: "pipe",
        timeout: 90_000,
      })
      containerId = execFileSync(
        "docker",
        [
          "run",
          "-d",
          "--network",
          "none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--label",
          `lyrashield.supervisor.ownership=${ownership.ownershipId}`,
          "--user",
          "10001:10001",
          "--entrypoint",
          "sleep",
          image,
          "60",
        ],
        { encoding: "utf8", timeout: 30_000 }
      ).trim()
      const f = fixture()
      const resource = { ...ownership, containerId }
      const scope = scopeFor(resource)
      f.deps.docker = new SandboxToolDocker(process.env.LYRA_SANDBOX_TEST_DOCKER_SOCKET!)
      f.deps.executor = new DockerRuntimeExecutor()
      const { execId } = await startSandboxToolExec(toolRequest, scope, f.deps)
      const result = JSON.parse(
        execFileSync(
          "curl",
          [
            "--fail",
            "--silent",
            "--unix-socket",
            process.env.LYRA_SANDBOX_TEST_DOCKER_SOCKET!,
            `http://localhost/v1.41/exec/${execId}/json`,
          ],
          { encoding: "utf8", timeout: 10_000 }
        )
      )
      expect(result.ContainerID).toBe(containerId)
      expect(result.ProcessConfig.user).toBe("pentester")
      expect(f.events.map((event) => event.type)).toEqual([
        "tool_intent",
        "tool_created",
        "tool_starting",
        "tool_started",
      ])
    } finally {
      if (containerId)
        execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore", timeout: 30_000 })
      try {
        execFileSync("docker", ["image", "rm", "-f", image], { stdio: "ignore", timeout: 30_000 })
      } catch {
        /* no image was built */
      }
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
