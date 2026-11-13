import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import type { ExecutorSpec, ResourceOwnership } from "@lyrashield/runtime-control"
import { LinuxProcessExecutor } from "./executor"

describe("unqualified process executor", () => {
  it("does not adopt, launch, inspect or kill an unverified cgroup", async () => {
    const executor = new LinuxProcessExecutor(tmpdir())
    const spec: ExecutorSpec = {
      kind: "process",
      command: "/usr/bin/true",
      args: [],
      cwd: tmpdir(),
      cgroupPath: tmpdir(),
      env: {},
      grantEnvName: "LLM_API_KEY",
    }
    const ownership: ResourceOwnership = {
      executorKey: "engine",
      kind: "process",
      ownershipId: `own_${"a".repeat(40)}`,
      cgroupPath: tmpdir(),
    }
    const context = {
      attemptId: "attempt-test",
      commandId: "command-test",
      assertActive: () => undefined,
    }
    await expect(executor.create("engine", spec, context)).rejects.toThrow(/held/)
    await expect(executor.start(ownership, spec, context)).rejects.toThrow(/held/)
    await expect(executor.inspect(ownership)).resolves.toMatchObject({ state: "UNKNOWN" })
    await expect(executor.stop(ownership)).resolves.toMatchObject({ state: "UNKNOWN" })
  })
})
