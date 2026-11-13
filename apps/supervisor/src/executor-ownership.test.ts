import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ExecutorSpec, ResourceOwnership } from "@lyrashield/runtime-control"
import { DockerRuntimeExecutor } from "./executor"

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const containerId = "b".repeat(64)
const ownership: ResourceOwnership = {
  executorKey: "engine",
  kind: "container",
  ownershipId: `own_${"a".repeat(40)}`,
  containerId,
}
const spec: ExecutorSpec = {
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
const context = { attemptId: "attempt-test", commandId: "command-test", assertActive: () => {} }

async function dockerFixture(
  listedId: string,
  inspectedId = listedId,
  label = ownership.ownershipId
) {
  const path = await mkdtemp(join(tmpdir(), "executor-ownership-"))
  roots.push(path)
  await writeFile(join(path, "ids"), listedId)
  await writeFile(
    join(path, "inspection"),
    JSON.stringify([
      {
        Id: inspectedId,
        Config: { Labels: { "lyrashield.supervisor.ownership": label } },
        State: { Running: false },
      },
    ])
  )
  await writeFile(
    join(path, "docker"),
    '#!/bin/sh\ncase "$1 $2" in\n  "container ls") cat "$FIXTURE_ROOT/ids" ;;\n  "container inspect") cat "$FIXTURE_ROOT/inspection" ;;\n  *) printf "%s\\n" "$*" >> "$FIXTURE_ROOT/mutations" ;;\nesac\n'
  )
  await chmod(join(path, "docker"), 0o700)
  vi.stubEnv("FIXTURE_ROOT", path)
  vi.stubEnv("PATH", `${path}:${process.env.PATH}`)
  return join(path, "mutations")
}

describe("Docker retained resource ownership", () => {
  it.each([
    ["different retained id", "c".repeat(64), "c".repeat(64), ownership.ownershipId],
    ["different inspected id", containerId, "c".repeat(64), ownership.ownershipId],
    ["different inspected label", containerId, containerId, `own_${"c".repeat(40)}`],
    ["truncated lookup id", containerId.slice(0, 12), containerId, ownership.ownershipId],
  ])("holds mutations for %s", async (_name, listedId, inspectedId, label) => {
    const marker = await dockerFixture(listedId, inspectedId, label)
    const executor = new DockerRuntimeExecutor()
    await expect(executor.inspect(ownership)).resolves.toMatchObject({ state: "UNKNOWN" })
    await expect(executor.start(ownership, spec, context)).rejects.toThrow(/unavailable/)
    await expect(executor.stop(ownership)).resolves.toMatchObject({ state: "UNKNOWN" })
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not start or remove a missing retained container", async () => {
    const marker = await dockerFixture("")
    const executor = new DockerRuntimeExecutor()
    await expect(executor.start(ownership, spec, context)).rejects.toThrow(/unavailable/)
    await expect(executor.stop(ownership)).resolves.toMatchObject({ state: "ABSENT" })
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("starts only the full id with matching lookup and inspection ownership", async () => {
    const marker = await dockerFixture(containerId)
    await expect(new DockerRuntimeExecutor().start(ownership, spec, context)).resolves.toEqual(
      ownership
    )
    expect(await readFile(marker, "utf8")).toBe(`start ${containerId}\n`)
  })

  it("can discover an owned resource during cancellation without trusting an absent id", async () => {
    const marker = await dockerFixture(containerId)
    const discovered = { ...ownership }
    delete discovered.containerId
    await new DockerRuntimeExecutor().stop(discovered)
    expect(await readFile(marker, "utf8")).toBe(`container rm --force ${containerId}\n`)
  })
})
