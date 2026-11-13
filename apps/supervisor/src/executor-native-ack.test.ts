import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { ExecutorSpec } from "@lyrashield/runtime-control"
import { deriveOwnershipId, DockerRuntimeExecutor } from "./executor"

describe.runIf(!!process.env.LYRA_SANDBOX_TEST_DOCKER_SOCKET)(
  "fresh native Docker acknowledgement",
  () => {
    it("acknowledges only the original create/start responses with exact inspected ownership", async () => {
      const attemptId = `attempt-${randomUUID()}`
      const commandId = `command-${randomUUID()}`
      const expectedOwnership = deriveOwnershipId(attemptId, commandId, "engine")
      const acknowledge = vi.fn(async () => undefined)
      const context = {
        attemptId,
        commandId,
        assertActive: () => undefined,
        nativeInvocation: { requestId: "guard-1", acknowledge },
      }
      const spec: ExecutorSpec = {
        kind: "container",
        image: "python:3.12-slim",
        argv: ["sleep", "60"],
        env: {},
        network: "none",
        cpus: 1,
        memoryMb: 128,
        pidsLimit: 32,
        readOnly: true,
        grantEnvName: "LLM_API_KEY",
      }
      const executor = new DockerRuntimeExecutor()
      let containerId = ""
      try {
        const created = await executor.create("engine", spec, context)
        containerId = created.containerId ?? ""
        expect(containerId).toMatch(/^[a-f0-9]{64}$/)
        expect(acknowledge).toHaveBeenCalledExactlyOnceWith({
          operation: "CONTAINER_CREATE_ACK",
          nativeRequestId: "guard-1",
          inspection: { state: "PRESENT", running: false, ownership: created },
        })
        await executor.create("engine", spec, context)
        expect(acknowledge).toHaveBeenCalledTimes(1)
        await executor.start(created, spec, context)
        expect(acknowledge).toHaveBeenCalledTimes(2)
        expect(acknowledge).toHaveBeenLastCalledWith({
          operation: "CONTAINER_START_ACK",
          nativeRequestId: "guard-1",
          inspection: { state: "PRESENT", running: true, ownership: created },
        })
        await executor.start(created, spec, context)
        expect(acknowledge).toHaveBeenCalledTimes(2)
        const retired = vi.fn(async () => undefined)
        await expect(executor.stop(created, undefined, { acknowledge: retired })).resolves.toEqual({
          state: "ABSENT",
        })
        expect(retired).toHaveBeenCalledExactlyOnceWith({
          ownership: created,
          inspection: { state: "ABSENT" },
        })
        await expect(executor.stop(created, undefined, { acknowledge: retired })).resolves.toEqual({
          state: "ABSENT",
        })
        expect(retired).toHaveBeenCalledTimes(1)
        containerId = ""
      } finally {
        if (containerId) {
          const observed = execFileSync(
            "docker",
            [
              "inspect",
              "--format",
              '{{.Id}}|{{index .Config.Labels "lyrashield.supervisor.ownership"}}',
              containerId,
            ],
            { encoding: "utf8" }
          ).trim()
          if (observed !== `${containerId}|${expectedOwnership}`)
            throw new Error("fixture ownership changed")
          execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore" })
        }
      }
    }, 30_000)
  }
)
