import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuthorityAction, VerifyActionAuthority } from "@lyrashield/runtime-control"

const fixture = vi.hoisted(() => ({
  installed: {
    purpose: "production-installed",
    epochId: "epoch-test",
    epoch: 1,
    sourceRevision: "a".repeat(40),
    runtimePolicyDigest: `sha256:${"b".repeat(64)}`,
    authorityDigest: `sha256:${"c".repeat(64)}`,
    supervisorInstanceId: "supervisor-test",
  },
  databaseAllowed: true,
  hostAvailable: true,
}))
vi.mock("pg", () => ({
  default: {
    Pool: class {
      async end() {}
    },
  },
}))
vi.mock("@lyrashield/runtime-control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/runtime-control")>()
  return {
    ...actual,
    createInstalledExecutionAuthorityCapability: () => ({
      verifyAction: async () => {
        if (!fixture.hostAvailable) throw new Error("installed authority unavailable")
        return fixture.installed
      },
    }),
    PostgresDurableScanAuthorityFence: class {
      constructor(
        _pool: unknown,
        private readonly verify: VerifyActionAuthority
      ) {}
      async run<T>(binding: AuthorityAction, effect: () => T): Promise<T> {
        await this.verify({ query: async () => ({ rows: [] }), release: () => {} }, binding)
        return effect()
      }
    },
  }
})
vi.mock("@lyrashield/db/src/scan-execution-action-intent", () => ({
  createScanExecutionActionAuthorityVerifier: () => async () => {
    if (!fixture.databaseAllowed) throw new Error("database authority rejected")
    return { deadlineAt: new Date(Date.now() + 1000) }
  },
}))
const { loadDatabaseSupervisorAuthority } = await import("./database-authority")

const original = "original-controller-key-".repeat(3)
const wrapper = "independent-wrapper-key-".repeat(3)
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const source = {
  streamId: "supervisor-stream",
  authorityEpochId: "epoch-test",
  supervisorInstanceId: "supervisor-test",
  originalKeyHash: hash(original),
  wrapperKeyHash: hash(wrapper),
  socketPath: "/run/lyrashield/supervisor.sock",
}
const config = {
  signingSecret: original,
  supervisorInstanceId: "supervisor-test",
  controlToken: "private-control-token-".repeat(3),
}
const env = () => ({
  LYRASHIELD_SCAN_EXECUTION_DATABASE_URL: "postgresql://fixture@127.0.0.1:1/lyrashield_test",
  LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON: JSON.stringify(source),
  LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET: wrapper,
  LYRASHIELD_AUTHORITY_EPOCH_ID: "epoch-test",
  LYRASHIELD_PRODUCT_REVISION: "a".repeat(40),
  LYRASHIELD_RUNTIME_POLICY_DIGEST: `sha256:${"b".repeat(64)}`,
})
const action: AuthorityAction = {
  phase: "PREPARE",
  operationId: "operation-test",
  attemptId: "attempt-test",
  scanId: "scan-test",
  workspaceId: "workspace-test",
  authorityEpochId: "epoch-test",
  authorityRevision: 1,
  authorityChecksum: "d".repeat(64),
  actionChecksum: "e".repeat(64),
  commandId: "command-test",
}
beforeEach(() => {
  fixture.databaseAllowed = true
  fixture.hostAvailable = true
  fixture.installed = {
    purpose: "production-installed",
    epochId: "epoch-test",
    epoch: 1,
    sourceRevision: "a".repeat(40),
    runtimePolicyDigest: `sha256:${"b".repeat(64)}`,
    authorityDigest: `sha256:${"c".repeat(64)}`,
    supervisorInstanceId: "supervisor-test",
  }
})

describe("installed supervisor database authority", () => {
  it("does not install a fence without a database configuration", () => {
    expect(loadDatabaseSupervisorAuthority(config, {})).toBeUndefined()
  })
  it("rejects incomplete or mismatched protected journal configuration", () => {
    expect(() =>
      loadDatabaseSupervisorAuthority(config, {
        ...env(),
        LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET: "",
      })
    ).toThrow()
    expect(() =>
      loadDatabaseSupervisorAuthority(config, {
        ...env(),
        LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON: JSON.stringify({
          ...source,
          supervisorInstanceId: "other-instance",
        }),
      })
    ).toThrow()
    expect(() =>
      loadDatabaseSupervisorAuthority(config, {
        ...env(),
        LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON: JSON.stringify({
          ...source,
          originalKeyHash: "f".repeat(64),
        }),
      })
    ).toThrow()
    expect(() =>
      loadDatabaseSupervisorAuthority(config, {
        ...env(),
        LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON: JSON.stringify({
          ...source,
          wrapperKeyHash: source.originalKeyHash,
        }),
        LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET: original,
      })
    ).toThrow()
  })
  it("requires both the installed host identity and current database authority before an effect", async () => {
    const authority = loadDatabaseSupervisorAuthority(config, env())!
    let effects = 0
    const run = () => authority.authorityFence.run(action, () => ++effects)
    try {
      await expect(run()).resolves.toBe(1)
      const installed = fixture.installed
      for (const mismatch of [
        { epochId: "different-epoch" },
        { sourceRevision: "f".repeat(40) },
        { runtimePolicyDigest: `sha256:${"f".repeat(64)}` },
        { supervisorInstanceId: "different-supervisor" },
      ]) {
        fixture.installed = { ...installed, ...mismatch }
        await expect(run()).rejects.toThrow()
      }
      fixture.installed = installed
      fixture.hostAvailable = false
      await expect(run()).rejects.toThrow()
      fixture.hostAvailable = true
      fixture.databaseAllowed = false
      await expect(run()).rejects.toThrow()
      expect(effects).toBe(1)
    } finally {
      await authority.close()
    }
  })
})
