import assert from "node:assert/strict"
import test from "node:test"
import { verifySandboxCoveragePublication } from "../runtime-qualification-foundation.mjs"
import { verifyFreshSandboxPublication } from "../verify-sandbox-publication.mjs"
import {
  SBOM_COVERAGE_LIMITATIONS,
  SBOM_COVERAGE_LIMITS,
  SBOM_COVERAGE_LINK_POLICY,
  SBOM_COVERAGE_POLICY,
  SBOM_COVERAGE_PREDICATE_TYPE,
  SBOM_COVERAGE_REQUIRED_APPS,
  SBOM_COVERAGE_SCOPE,
} from "../../../apps/worker/src/engine/sandbox-sbom-coverage.ts"

const expected = {
  engineRevision: "e".repeat(40),
  publicationRevision: "a".repeat(40),
  publishRunId: "42",
  publishAttempt: "2",
  sandboxDigest: "sha256:" + "b".repeat(64),
}
const now = Date.parse("2026-11-12T00:00:00Z")
const repo = "ecryptoguru/lyrashield-engine"
const invocation = `https://github.com/${repo}/actions/runs/42/attempts/2`
const san = `https://github.com/${repo}/.github/workflows/publish-sandbox.yml@refs/heads/main`
const types = [
  "https://slsa.dev/provenance/v1",
  "https://lyrashieldai.com/attestations/sandbox-qualification/v1",
  SBOM_COVERAGE_PREDICATE_TYPE,
]
const digest = (value) => "sha256:" + value.repeat(64)

function records() {
  const identity = {
    engineRevision: expected.engineRevision,
    workflowRevision: expected.publicationRevision,
    runId: expected.publishRunId,
    runAttempt: expected.publishAttempt,
    indexDigest: expected.sandboxDigest,
  }
  const platform = (arch) => ({
    receiptDigest: digest("1"),
    manifestDigest: digest(arch === "amd64" ? "c" : "d"),
    configDigest: digest("2"),
    containerId: "3".repeat(64),
    rootfsDigest: digest("4"),
    rootfsSize: 12345,
    spdxDocumentDigest: digest("5"),
    goToolSha256: "6".repeat(64),
    exporter: { dockerServer: "29.9.2/0367cbe" },
    ignoredLinks: { count: 1, policy: { ...SBOM_COVERAGE_LINK_POLICY } },
    goApplications: SBOM_COVERAGE_REQUIRED_APPS.map((name) => ({
      name,
      binaryPath: `/usr/local/bin/${name}`,
      binarySha256: "7".repeat(64),
      spdxFileId: `SPDXRef-file-${name}`,
      mainModule: `example.com/${name}`,
      pinnedVersion: "v1.2.3",
      mainSpdxPackageId: `SPDXRef-Package-${name}`,
      dependencyCount: 1,
    })),
    limits: { ...SBOM_COVERAGE_LIMITS },
  })
  const predicates = [
    { runDetails: { metadata: { invocationId: invocation } } },
    {
      schema: "lyrashield.sandbox.qualification.v1",
      ...identity,
      engineCiRun: "40",
      engineCiAttempt: "1",
      platformIndexes: { amd64: digest("8"), arm64: digest("9") },
      platformManifests: { amd64: digest("c"), arm64: digest("d") },
    },
    {
      schema: "lyrashield.sandbox.sbom-coverage.v1",
      ...identity,
      policy: { ...SBOM_COVERAGE_POLICY },
      platforms: { amd64: platform("amd64"), arm64: platform("arm64") },
      requiredGoApplications: [...SBOM_COVERAGE_REQUIRED_APPS],
      scope: [...SBOM_COVERAGE_SCOPE],
      limitations: [...SBOM_COVERAGE_LIMITATIONS],
    },
  ]
  return types.map((type, i) => [
    {
      verificationResult: {
        signature: {
          certificate: {
            issuer: "https://token.actions.githubusercontent.com",
            subjectAlternativeName: san,
            buildSignerURI: san,
            buildSignerDigest: expected.publicationRevision,
            runnerEnvironment: "github-hosted",
            sourceRepositoryURI: "https://github.com/" + repo,
            sourceRepositoryDigest: expected.publicationRevision,
            sourceRepositoryRef: "refs/heads/main",
            sourceRepositoryIdentifier: "1297157605",
            sourceRepositoryOwnerURI: "https://github.com/ecryptoguru",
            sourceRepositoryOwnerIdentifier: "116722580",
            runInvocationURI: invocation,
          },
        },
        verifiedTimestamps: [{ type: "Tlog", timestamp: "2026-11-11T23:00:00Z" }],
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: type,
          subject: [
            {
              name: "ghcr.io/ecryptoguru/lyrashield-sandbox",
              digest: { sha256: expected.sandboxDigest.slice(7) },
            },
          ],
          predicate: predicates[i],
        },
      },
    },
  ])
}
const options = (rows) => ({
  when: now,
  run: (args) => JSON.stringify(rows[types.indexOf(args[args.indexOf("--predicate-type") + 1])]),
})

test("protected process freshly verifies all three predicates and never adopts saved JSON", () => {
  const rows = records(),
    calls = []
  const result = verifySandboxCoveragePublication(expected, {
    when: now,
    run: (args) => {
      calls.push(args)
      assert.ok(args.includes("--bundle-from-oci"))
      assert.equal(args.includes("--bundle"), false)
      assert.equal(args.includes("--custom-trusted-root"), false)
      assert.equal(args[args.indexOf("--cert-identity") + 1], san)
      assert.equal(args[args.indexOf("--source-digest") + 1], expected.publicationRevision)
      return options(rows).run(args)
    },
  })
  assert.equal(calls.length, 3)
  assert.equal(result.engineRevision, expected.engineRevision)
  assert.equal(result.signedBoundedCoverageVerified, true)
  assert.equal(result.qualified, false)
  assert.equal(result.nativeInventoryRechecked, false)
  assert.ok(Object.isFrozen(result))
})

for (const [label, mutate] of [
  [
    "missing native arm64",
    (p) => {
      delete p.platforms.arm64
    },
  ],
  [
    "same native manifest",
    (p) => {
      p.platforms.arm64.manifestDigest = p.platforms.amd64.manifestDigest
    },
  ],
  [
    "platform drift",
    (p) => {
      p.platforms.amd64.manifestDigest = digest("f")
    },
  ],
  [
    "unbounded rootfs",
    (p) => {
      p.platforms.amd64.rootfsSize = SBOM_COVERAGE_LIMITS.rootfsExportBytes + 1
    },
  ],
  [
    "missing application",
    (p) => {
      p.platforms.arm64.goApplications.pop()
    },
  ],
  [
    "scope waiver",
    (p) => {
      p.scope.pop()
    },
  ],
  [
    "limit waiver",
    (p) => {
      p.platforms.amd64.limits.processingSeconds++
    },
  ],
  [
    "runtime substitution",
    (p) => {
      p.engineRevision = "f".repeat(40)
    },
  ],
])
  test(`authenticated coverage still rejects ${label}`, () => {
    const rows = records()
    mutate(rows[2][0].verificationResult.statement.predicate)
    assert.throws(() => verifySandboxCoveragePublication(expected, options(rows)))
  })

for (let i = 0; i < types.length; i++)
  test(`predicate ${i} requires actual verifier success and exact signed identity`, () => {
    assert.throws(() =>
      verifySandboxCoveragePublication(expected, {
        when: now,
        run: (args) => {
          if (args[args.indexOf("--predicate-type") + 1] === types[i])
            throw new Error("bad signature")
          return options(records()).run(args)
        },
      })
    )
    for (const mutate of [
      (r) => {
        r.signature.certificate.runInvocationURI += "0"
      },
      (r) => {
        r.signature.certificate.sourceRepositoryIdentifier = "1"
      },
      (r) => {
        r.signature.certificate.buildSignerDigest = "f".repeat(40)
      },
      (r) => {
        r.statement.subject[0].digest.sha256 = "f".repeat(64)
      },
      (r) => {
        r.verifiedTimestamps = []
      },
    ]) {
      const rows = records()
      mutate(rows[i][0].verificationResult)
      assert.throws(() => verifySandboxCoveragePublication(expected, options(rows)))
    }
  })

test("selectors cannot replace verification results or supply getters, files or extra claims", () => {
  let calls = 0
  for (const value of [
    records(),
    { ...expected, qualified: true },
    { ...expected, engineRevision: "legacy" },
  ])
    assert.throws(() =>
      verifySandboxCoveragePublication(value, {
        run: () => {
          calls++
          return "[]"
        },
      })
    )
  const getter = { ...expected }
  Object.defineProperty(getter, "engineRevision", { get: () => assert.fail("getter invoked") })
  assert.throws(() => verifySandboxCoveragePublication(getter))
  assert.equal(calls, 0)
})

test("a signed fresh image cannot be relabeled as another selected engine revision", () => {
  assert.throws(() =>
    verifySandboxCoveragePublication(
      { ...expected, engineRevision: "3001517530300ca5f602536bfadcbd3c95ad3039" },
      options(records())
    )
  )
})

test("protected issuer identity failure precedes candidate reads and no credential is exchanged", async () => {
  let reads = 0
  await assert.rejects(
    verifyFreshSandboxPublication(JSON.stringify(expected), {
      readIdentity: async () => {
        throw new Error("foreign reusable job")
      },
      verify: () => {
        reads++
        return {}
      },
    })
  )
  assert.equal(reads, 0)
  const result = await verifyFreshSandboxPublication(JSON.stringify(expected), {
    readIdentity: async () => ({ token: "none" }),
    verify: (value) => verifySandboxCoveragePublication(value, options(records())),
  })
  assert.equal(result.qualified, false)
})
