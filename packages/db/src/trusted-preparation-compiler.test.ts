import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { describe, expect, it } from "vitest"
import { buildScanExecutionPlan } from "@lyrashield/types"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import { canonicalizeJson, sha256Sync } from "@lyrashield/security/webmcp"
import { createTrustedPreparationCompiler } from "./trusted-preparation-compiler"
import type { ScanPreparationCommandAuthority } from "./scan-dispatch-command-descriptor"
import {
  buildPreparationStagingRecord,
  preparationStagingRecordSchema,
  trustedPreparationHostPolicySchema,
  verifyPreparationStagingRecord,
} from "./trusted-preparation-proof"

const hash = "a".repeat(64)
const revision = "b".repeat(40)
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 })
const issuerPublicKey = publicKey.export({ format: "pem", type: "spki" }).toString()
const issuerKeyHash = createHash("sha256")
  .update(publicKey.export({ format: "der", type: "spki" }))
  .digest("hex")
const executionContext = {
  environment: "DISPOSABLE" as const,
  databaseIncarnationId: `sha256:${hash}`,
  hostIdentityDigest: `sha256:${hash}`,
  providerFixtureId: `sha256:${hash}`,
}
const hostPolicy = trustedPreparationHostPolicySchema.parse({
  schema: "lyrashield-preparation-host-policy/1",
  authorityEpochId: "epoch-one",
  executionContext,
  engineImage: `registry/engine@sha256:${hash}`,
  sandboxImage: `registry/sandbox@sha256:${hash}`,
  productRevision: revision,
  engineRevision: revision,
  network: "lyrashield-isolated",
  platformMaxBudgetUsd: 5,
  modelRouting: { LYRASHIELD_LUNA_LLM: "gpt-6-luna", LYRASHIELD_SOL_LLM: "gpt-6-sol" },
  isolation: {
    networkPolicyChecksum: hash,
    seccompPolicyChecksum: hash,
    appArmorProfile: "lyrashield",
  },
  issuerKeyHash,
  issuerKeyId: "https://vault.example/keys/runtime/one",
  provider: { providerId: "test-provider", maxRequests: 100, costReservationMicros: 1000 },
})
function fixture(mode = "STANDARD", targetType = "REPO") {
  const executionPlan = buildScanExecutionPlan({
    targetType,
    mode,
    ...(targetType === "REPO" ? { source: { revision } } : {}),
  })
  const authority: ScanPreparationCommandAuthority = {
    commandId: "prepare-one",
    attempt: {
      attemptId: "attempt-one",
      operationId: "operation-one",
      scanId: "scan-one",
      workspaceId: "workspace-one",
      authorityEpochId: "epoch-one",
      authorityRevision: 1,
      workerIdentity: "worker-one",
      billingMode: "PAID",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    executionPlan,
    executionPlanHash: sha256Sync(canonicalizeJson(executionPlan)),
    targetSnapshotDigest: hash,
    scopeDigest: hash,
    policyDigest: hash,
    maxBudgetUsd: String(executionPlan.limits.maxBudgetUsd),
    maxRuntimeMs: executionPlan.limits.maxEngineMs,
    workerGrantId: "grant-one",
    mode,
    goal: "SECURITY",
    attachments: [],
    verifiedDomains: [],
    policy: null,
    focus: undefined,
    target: {
      id: "target-one",
      workspaceId: "workspace-one",
      type: targetType,
      name: "Example",
      url: targetType === "REPO" ? null : "https://example.com",
      apiSpecUrl: null,
      repoProvider: "GITHUB",
      repoOwner: "owner",
      repoName: "repo",
      repoFullName: "owner/repo",
      installationId: "installation-one",
      branch: "main",
      environment: "STAGING",
    },
  }
  const unsigned = {
    schema: "lyrashield-preparation-staging/1",
    purpose: "disposable-preparation",
    executionContext,
    issuerKeyHash,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: authority.attempt.expiresAt,
    operationId: authority.attempt.operationId,
    attemptId: authority.attempt.attemptId,
    scanId: authority.attempt.scanId,
    workspaceId: authority.attempt.workspaceId,
    authorityEpochId: authority.attempt.authorityEpochId,
    executionPlanHash: authority.executionPlanHash,
    targetSnapshotDigest: hash,
    scopeDigest: hash,
    policyDigest: hash,
    hostPolicyChecksum: sha256Hex(canonicalJson(hostPolicy)),
    images: { engine: hostPolicy.engineImage, sandbox: hostPolicy.sandboxImage },
    resources: {
      source: {
        grantId: "source-one",
        root: "/workspace/source",
        revision,
        stagedTreeDigest: hash,
        readOnly: true,
      },
      attachments: null,
      relay: null,
      egress: {
        grantId: "egress-one",
        policyPath: "/run/lyrashield-egress/policy.json",
        policyChecksum: hash,
        authorizedHosts: [],
        relayRequired: false,
        readOnly: true,
      },
    },
    observed: {
      inventoryReceiptChecksum: hash,
      runtimeReceiptChecksum: hash,
      inputReceiptChecksum: hash,
      engineEntrypoint: [],
      sandboxEntrypoint: ["docker-entrypoint.sh"],
    },
  }
  const signed = (record: unknown = unsigned) => {
    const raw = canonicalJson(preparationStagingRecordSchema.parse(record))
    return {
      raw,
      result: {
        algorithm: "RS256",
        keyId: hostPolicy.issuerKeyId,
        signature: sign("RSA-SHA256", Buffer.from(raw), privateKey).toString("base64"),
      },
    }
  }
  return {
    authority,
    unsigned,
    signed,
    compile: createTrustedPreparationCompiler({
      readExecutionContext: async () => executionContext,
      hostPolicy,
      issuerPublicKey,
      readStagingRecord: async () => signed(),
    }),
  }
}

describe("protected preparation compiler", () => {
  it.each(["QUICK", "STANDARD", "DEEP"])(
    "preserves %s routing and binds exact readonly staged resources",
    async (mode) => {
      const { authority, compile } = fixture(mode)
      const result = await compile(authority)
      expect(result.executors.map((executor) => executor.key)).toEqual(["sandbox", "engine"])
      const engine = result.executors[1]!.spec
      if (engine.kind !== "container") throw new Error("wrong executor kind")
      expect(engine.argv[0]).toBe("/opt/lyrashield-venv/bin/lyrashield")
      expect(engine.argv).toContain("/workspace/source")
      expect(engine.env?.LYRASHIELD_LLM).toBe(mode === "DEEP" ? "gpt-6-sol" : "gpt-6-luna")
      expect(engine.resourceDescriptor?.source?.revision).toBe(revision)
      expect(engine.resourceDescriptor?.uid).toBe(1000)
      expect(engine.resourceDescriptor?.isolation.noNewPrivileges).toBe(true)
      expect(result.provider?.maxReservedCostMicros).toBe(Number(authority.maxBudgetUsd) * 1000000)
      expect(canonicalJson(result)).not.toContain("storageUri")
    }
  )
  it("preserves source diff arguments and verified live target routing", async () => {
    const repo = fixture()
    const executionPlan = buildScanExecutionPlan({
      targetType: "REPO",
      mode: "STANDARD",
      workflow: "REVIEW_CHANGES",
      source: { revision, baseRevision: "c".repeat(40), mergeBaseRevision: "d".repeat(40) },
    })
    const authority = {
      ...repo.authority,
      executionPlan,
      executionPlanHash: sha256Sync(canonicalizeJson(executionPlan)),
    }
    const record = repo.signed({ ...repo.unsigned, executionPlanHash: authority.executionPlanHash })
    const compile = createTrustedPreparationCompiler({
      readExecutionContext: async () => executionContext,
      hostPolicy,
      issuerPublicKey,
      readStagingRecord: async () => record,
    })
    const result = await compile(authority)
    const engine = result.executors[1]!.spec
    if (engine.kind !== "container") throw new Error("wrong executor kind")
    expect(engine.argv).toContain("--diff-base")
    expect(engine.argv).toContain("d".repeat(40))
    const live = fixture("STANDARD", "WEB_APP")
    const liveAuthority = {
      ...live.authority,
      verifiedDomains: [
        {
          id: "domain-one",
          domain: "example.com",
          verifiedAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        },
      ],
    }
    const relay = {
      grantId: "relay-one",
      mountRoot: "/run/lyrashield-relay/upstream",
      grantChecksum: hash,
      policyChecksum: hash,
      authorizedHosts: ["example.com"],
      readOnly: true,
    }
    const liveRecord = live.signed({
      ...live.unsigned,
      resources: {
        ...live.unsigned.resources,
        source: null,
        relay,
        egress: {
          ...live.unsigned.resources.egress,
          authorizedHosts: ["example.com"],
          relayRequired: true,
        },
      },
    })
    const liveCompile = createTrustedPreparationCompiler({
      readExecutionContext: async () => executionContext,
      hostPolicy,
      issuerPublicKey,
      readStagingRecord: async () => liveRecord,
    })
    const liveResult = await liveCompile(liveAuthority)
    expect(liveResult.executors[1]!.spec.kind).toBe("container")
    await expect(liveCompile({ ...liveAuthority, verifiedDomains: [] })).rejects.toThrow()
  })
  it("rejects signature changes, source revision changes, expired or mismatched image authority", async () => {
    const { authority, unsigned, signed } = fixture()
    for (const record of [
      { ...signed(), raw: signed().raw + " " },
      {
        ...signed(),
        result: { ...signed().result, keyId: "https://vault.example/keys/untrusted/one" },
      },
      { ...signed(), result: { ...signed().result, algorithm: "PS256" } },
      {
        ...signed(),
        result: { ...signed().result, signature: Buffer.alloc(384).toString("base64") },
      },
      signed({
        ...unsigned,
        resources: {
          ...unsigned.resources,
          source: { ...unsigned.resources.source, revision: "c".repeat(40) },
        },
      }),
      signed({ ...unsigned, expiresAt: new Date(Date.now() - 1000).toISOString() }),
      signed({
        ...unsigned,
        images: { ...unsigned.images, engine: `registry/engine@sha256:${"c".repeat(64)}` },
      }),
      signed({ ...unsigned, policyDigest: "c".repeat(64) }),
    ]) {
      const compile = createTrustedPreparationCompiler({
        readExecutionContext: async () => executionContext,
        hostPolicy,
        issuerPublicKey,
        readStagingRecord: async () => record,
      })
      await expect(compile(authority)).rejects.toThrow()
    }
  })
  it("rejects zero funding, changed persisted plan, missing attachments and deterministic infrastructure", async () => {
    const { authority, compile } = fixture()
    await expect(compile({ ...authority, maxBudgetUsd: "0" })).rejects.toThrow()
    await expect(compile({ ...authority, executionPlanHash: "c".repeat(64) })).rejects.toThrow()
    await expect(
      compile({
        ...authority,
        attachments: [
          {
            id: "attachment-one",
            workspaceId: "workspace-one",
            filename: "readme.txt",
            mediaType: "text/plain",
            byteLength: 2,
            checksum: hash,
            storageUri: "private://one",
            encryptionKeyRef: "key-one",
          },
        ],
      })
    ).rejects.toThrow()
    const deterministic = fixture("QUICK", "WEB_APP")
    await expect(deterministic.compile(deterministic.authority)).rejects.toThrow()
  })
  it("binds independently observed disposable context and constructs only locked authority", async () => {
    const f = fixture()
    const built = buildPreparationStagingRecord(
      f.authority,
      hostPolicy,
      preparationStagingRecordSchema.parse(f.unsigned).resources,
      preparationStagingRecordSchema.parse(f.unsigned).observed,
      executionContext
    )
    expect(built.operationId).toBe(f.authority.attempt.operationId)
    expect(built.executionPlanHash).toBe(f.authority.executionPlanHash)
    expect(built.executionContext).toEqual(executionContext)
    const wrong = { ...executionContext, databaseIncarnationId: `sha256:${"f".repeat(64)}` }
    expect(() =>
      buildPreparationStagingRecord(f.authority, hostPolicy, built.resources, built.observed, wrong)
    ).toThrow()
    for (const contexts of [
      [wrong, wrong],
      [executionContext, wrong],
    ]) {
      let reads = 0
      const compiler = createTrustedPreparationCompiler({
        hostPolicy,
        issuerPublicKey,
        readStagingRecord: async () => f.signed(),
        readExecutionContext: async () => contexts[Math.min(reads++, 1)],
      })
      await expect(compiler(f.authority)).rejects.toThrow()
    }
  })
  it("rejects production claims from the disposable preparation issuer", async () => {
    const { authority, unsigned } = fixture()
    const productionContext = { ...executionContext, environment: "PRODUCTION" }
    expect(() =>
      createTrustedPreparationCompiler({
        hostPolicy: { ...hostPolicy, executionContext: productionContext },
        issuerPublicKey,
        readStagingRecord: async () => undefined,
        readExecutionContext: async () => productionContext,
      })
    ).toThrow()

    const raw = canonicalJson({ ...unsigned, purpose: "production-preparation" })
    const compiler = createTrustedPreparationCompiler({
      hostPolicy,
      issuerPublicKey,
      readStagingRecord: async () => ({
        raw,
        result: {
          algorithm: "RS256",
          keyId: hostPolicy.issuerKeyId,
          signature: sign("RSA-SHA256", Buffer.from(raw), privateKey).toString("base64"),
        },
      }),
      readExecutionContext: async () => executionContext,
    })
    await expect(compiler(authority)).rejects.toThrow()
  })
  it("rejects unapproved key, host policy and caller-injected mount fields", async () => {
    const { authority, unsigned, signed } = fixture()
    const otherKey = generateKeyPairSync("rsa", { modulusLength: 3072 })
      .publicKey.export({ format: "pem", type: "spki" })
      .toString()
    await expect(
      createTrustedPreparationCompiler({
        readExecutionContext: async () => executionContext,
        hostPolicy,
        issuerPublicKey: otherKey,
        readStagingRecord: async () => signed(),
      })(authority)
    ).rejects.toThrow()
    expect(() =>
      trustedPreparationHostPolicySchema.parse({ ...hostPolicy, network: "host" })
    ).toThrow()
    expect(() =>
      signed({
        ...unsigned,
        resources: {
          ...unsigned.resources,
          source: { ...unsigned.resources.source, hostPath: "/etc" },
        },
      })
    ).toThrow()
  })
})

describe("qualified production preparation proof (signature fixture only)", () => {
  function productionFixture() {
    const f = fixture()
    const policy = trustedPreparationHostPolicySchema.parse({
      ...hostPolicy,
      schema: "lyrashield-preparation-host-policy/2",
      executionContext: { environment: "PRODUCTION" },
    })
    const installed = {
      purpose: "production-installed" as const,
      epochId: "epoch-one",
      epoch: 1,
      sourceRevision: revision,
      runtimePolicyDigest: `sha256:${hash}`,
      authorityDigest: `sha256:${hash}`,
      supervisorInstanceId: "supervisor-one",
      preparation: {
        schema: "lyrashield-preparation-delegation/1" as const,
        purpose: "scan-preparation" as const,
        issuerKeyId: policy.issuerKeyId,
        issuerKeyHash,
        publicKey: publicKey.export({ format: "jwk" }),
        preparationPolicyChecksum: sha256Hex(canonicalJson(policy)),
        productRevision: revision,
        workflow: ".github/workflows/issue-runtime-qualification.yml" as const,
        authorityEpochId: "epoch-one",
        epoch: 1,
        targetTypes: ["REPO"] as ["REPO"],
        scanWorkflows: ["REVIEW_TARGET", "REVIEW_CHANGES"] as ["REVIEW_TARGET", "REVIEW_CHANGES"],
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        maxStagingLifetimeMs: 900000 as const,
      },
    }
    const context = { environment: "PRODUCTION" as const, installed }
    const record = buildPreparationStagingRecord(
      f.authority,
      policy,
      preparationStagingRecordSchema.parse(f.unsigned).resources,
      preparationStagingRecordSchema.parse(f.unsigned).observed,
      context
    )
    const raw = canonicalJson(record)
    const envelope = {
      raw,
      result: {
        algorithm: "RS256",
        keyId: policy.issuerKeyId,
        signature: sign("RSA-SHA256", Buffer.from(raw), privateKey).toString("base64"),
      },
    }
    return { ...f, policy, context, record, envelope }
  }
  it("requires an independently observed exact delegation and v2 proof", () => {
    const f = productionFixture()
    expect(f.record.schema).toBe("lyrashield-preparation-staging/2")
    expect(
      verifyPreparationStagingRecord(f.envelope, f.authority, f.policy, issuerPublicKey, f.context)
        .record
    ).toEqual(f.record)
    expect(() =>
      verifyPreparationStagingRecord(f.envelope, f.authority, f.policy, issuerPublicKey, {
        environment: "PRODUCTION",
      })
    ).toThrow()
    expect(() =>
      verifyPreparationStagingRecord(
        f.envelope,
        f.authority,
        f.policy,
        issuerPublicKey,
        executionContext
      )
    ).toThrow()
  })
  it("ignores a caller-supplied production observation callback", async () => {
    const f = productionFixture()
    let calls = 0
    const compiler = createTrustedPreparationCompiler({
      hostPolicy: f.policy,
      issuerPublicKey,
      readStagingRecord: async () => f.envelope,
      readExecutionContext: async () => {
        calls++
        return f.context
      },
    })
    await expect(compiler(f.authority)).rejects.toThrow("Installed execution authority unavailable")
    expect(calls).toBe(0)
    expect(compiler.verifyPreparedCommand).toBeTypeOf("function")
  })
  it.each(["policy", "key", "epoch", "expiry", "purpose"])(
    "rejects an unqualified %s delegation",
    (kind) => {
      const f = productionFixture()
      const delegation = { ...f.context.installed.preparation }
      if (kind === "policy") delegation.preparationPolicyChecksum = "d".repeat(64)
      if (kind === "key") delegation.issuerKeyHash = "d".repeat(64)
      if (kind === "epoch") delegation.epoch = 2
      if (kind === "expiry") delegation.expiresAt = new Date(Date.now() - 1).toISOString()
      if (kind === "purpose") Object.assign(delegation, { purpose: "runtime-qualification" })
      expect(() =>
        verifyPreparationStagingRecord(f.envelope, f.authority, f.policy, issuerPublicKey, {
          ...f.context,
          installed: { ...f.context.installed, preparation: delegation },
        })
      ).toThrow()
    }
  )
  it("never lets the dedicated signer authorize another workflow or revision", () => {
    const f = productionFixture()
    for (const authority of [
      {
        ...f.authority,
        executionPlan: {
          ...f.authority.executionPlan,
          workflow: "AUTHENTICATED_ASSESSMENT" as const,
        },
      },
      {
        ...f.authority,
        executionPlan: {
          ...f.authority.executionPlan,
          source: { ...f.authority.executionPlan.source!, revision: "d".repeat(40) },
        },
      },
    ])
      expect(() =>
        buildPreparationStagingRecord(
          authority,
          f.policy,
          f.record.resources,
          f.record.observed,
          f.context
        )
      ).toThrow()
  })
})
