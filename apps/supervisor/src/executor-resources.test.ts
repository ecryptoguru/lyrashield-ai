import { describe, expect, it } from "vitest"
import { executorSpecSchema } from "@lyrashield/runtime-control"
import { DockerRuntimeExecutor } from "./executor"

const digest = `sha256:${"a".repeat(64)}`
const hash = "b".repeat(64)
const descriptor = {
  schema: "lyrashield-executor-resources/1", hostPolicyChecksum: hash, imageDigest: digest,
  uid: 1000, gid: 1000, workspaceRoot: "/workspace", workdir: "/workspace",
  source: null, attachments: null, relay: null,
  egress: { grantId: "egress-1", policyPath: "/run/lyrashield-egress/policy.json", policyChecksum: hash, authorizedHosts: [], relayRequired: false, readOnly: true },
  scratchRoot: "/workspace/.attachments-scratch",
  isolation: { networkPolicyChecksum: hash, seccompPolicyChecksum: hash, appArmorProfile: "fixture-profile", dropCapabilities: "ALL", noNewPrivileges: true, readOnlyRoot: true, shmMb: 512 },
  stagingRecordChecksum: hash, issuerKeyHash: hash,
}
const spec = {
  kind: "container", image: `fixture@${digest}`, argv: [], env: {}, network: "none",
  cpus: 1, memoryMb: 128, pidsLimit: 32, readOnly: true, grantEnvName: "LLM_API_KEY",
}

describe("protected executor resource descriptor", () => {
  it("preserves legacy specs and binds new descriptors to the exact image and read-only root", () => {
    expect(executorSpecSchema.parse(spec)).toEqual(spec)
    expect(executorSpecSchema.safeParse({ ...spec, resourceDescriptor: descriptor }).success).toBe(true)
    expect(executorSpecSchema.safeParse({ ...spec, image: `fixture@sha256:${"f".repeat(64)}`, resourceDescriptor: descriptor }).success).toBe(false)
    expect(executorSpecSchema.safeParse({ ...spec, readOnly: false, resourceDescriptor: descriptor }).success).toBe(false)
  })

  it("fails before create or start until protected resource installation is implemented", async () => {
    const parsed = executorSpecSchema.parse({ ...spec, resourceDescriptor: descriptor })
    const executor = new DockerRuntimeExecutor()
    const context = { attemptId: "attempt-1", commandId: "command-1", assertActive: () => undefined }
    await expect(executor.create("engine", parsed, context)).rejects.toThrow("protected resource installation")
    await expect(executor.start({ kind: "container", executorKey: "engine", ownershipId: `own_${"c".repeat(40)}`, containerId: "d".repeat(64) }, parsed, context)).rejects.toThrow("protected resource installation")
  })
})
