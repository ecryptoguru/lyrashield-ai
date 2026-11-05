/**
 * Tests for the product consumer of the signed bounded SBOM coverage
 * attestation, mirroring the engine's `test_sandbox_sbom_coverage.py` and
 * `test_sandbox_attestation_verification.py` style: positive acceptance of a
 * well-formed aggregate, and negative cases for missing platform receipts,
 * wrong digests, and altered receipts. The five known rootfs hard failures
 * must remain failures — no waivers.
 */

import { describe, expect, it } from "vitest"

import {
  SBOM_COVERAGE_LIMITATIONS,
  SBOM_COVERAGE_LIMITS,
  SBOM_COVERAGE_LINK_POLICY,
  SBOM_COVERAGE_POLICY,
  SBOM_COVERAGE_PREDICATE_TYPE,
  SBOM_COVERAGE_REQUIRED_APPS,
  SBOM_COVERAGE_SCOPE,
  verifySandboxSbomCoverage,
} from "./sandbox-sbom-coverage"

const IMAGE_NAME = "ghcr.io/ecryptoguru/lyrashield-sandbox"
const REPO = "ecryptoguru/lyrashield-engine"
const REF = "refs/heads/main"
const ENGINE_REVISION = "b".repeat(40)
const WORKFLOW_REVISION = "e".repeat(40)
const DIGEST_HEX = "a".repeat(64)
const INDEX_DIGEST = `sha256:${DIGEST_HEX}`

const IDENTITY = {
  engineRevision: ENGINE_REVISION,
  workflowRevision: WORKFLOW_REVISION,
  runId: "123",
  runAttempt: "2",
  indexDigest: INDEX_DIGEST,
}

const PLATFORM_DIGESTS: Record<string, string[]> = {
  amd64: ["c", "e", "1", "3", "5", "7"],
  arm64: ["d", "f", "2", "4", "6", "8"],
}

function goApplications() {
  return [...SBOM_COVERAGE_REQUIRED_APPS].map((name) => ({
    name,
    binaryPath: `/usr/local/bin/${name}`,
    binarySha256: "9".repeat(64),
    spdxFileId: `SPDXRef-file-${name}`,
    mainModule: `example.com/${name}`,
    pinnedVersion: "v1.2.3",
    mainSpdxPackageId: `SPDXRef-Package-${name}`,
    dependencyCount: 3,
  }))
}

function platformReceipt(arch: "amd64" | "arm64") {
  const [receipt, manifest, config, container, rootfs, spdx] = PLATFORM_DIGESTS[arch]
  return {
    receiptDigest: `sha256:${receipt.repeat(64)}`,
    manifestDigest: `sha256:${manifest.repeat(64)}`,
    configDigest: `sha256:${config.repeat(64)}`,
    containerId: container.repeat(64),
    rootfsDigest: `sha256:${rootfs.repeat(64)}`,
    rootfsSize: 12345,
    spdxDocumentDigest: `sha256:${spdx.repeat(64)}`,
    goToolSha256: "9".repeat(64),
    exporter: { dockerServer: "29.9.2/0367cbe" },
    ignoredLinks: { count: 2535, policy: { ...SBOM_COVERAGE_LINK_POLICY } },
    goApplications: goApplications(),
    limits: { ...SBOM_COVERAGE_LIMITS },
  }
}

function buildAggregate() {
  return {
    schema: "lyrashield.sandbox.sbom-coverage.v1",
    policy: { ...SBOM_COVERAGE_POLICY },
    indexDigest: INDEX_DIGEST,
    engineRevision: ENGINE_REVISION,
    workflowRevision: WORKFLOW_REVISION,
    runId: "123",
    runAttempt: "2",
    platforms: { amd64: platformReceipt("amd64"), arm64: platformReceipt("arm64") },
    requiredGoApplications: [...SBOM_COVERAGE_REQUIRED_APPS],
    scope: [...SBOM_COVERAGE_SCOPE],
    limitations: [...SBOM_COVERAGE_LIMITATIONS],
  }
}

type Aggregate = ReturnType<typeof buildAggregate>

function buildRecords(aggregate: unknown, overrides?: { subjectDigest?: string }) {
  const invocation = `https://github.com/${REPO}/actions/runs/123/attempts/2`
  return [
    {
      verificationResult: {
        signature: {
          certificate: {
            issuer: "https://token.actions.githubusercontent.com",
            buildSignerURI: `https://github.com/${REPO}/.github/workflows/publish-sandbox.yml@${REF}`,
            buildSignerDigest: ENGINE_REVISION,
            sourceRepositoryURI: `https://github.com/${REPO}`,
            sourceRepositoryDigest: ENGINE_REVISION,
            sourceRepositoryRef: REF,
            runnerEnvironment: "github-hosted",
            runInvocationURI: invocation,
          },
        },
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          subject: [
            { name: IMAGE_NAME, digest: { sha256: overrides?.subjectDigest ?? DIGEST_HEX } },
          ],
          predicateType: SBOM_COVERAGE_PREDICATE_TYPE,
          predicate: aggregate,
        },
      },
    },
  ]
}

function verify(aggregate: unknown, records: unknown, identity = IDENTITY) {
  return verifySandboxSbomCoverage({
    records,
    expectedAggregate: aggregate,
    identity,
    imageName: IMAGE_NAME,
    repo: REPO,
    revision: ENGINE_REVISION,
    ref: REF,
  })
}

describe("verifySandboxSbomCoverage", () => {
  it("accepts a signed bounded coverage attestation for both platforms", () => {
    const aggregate = buildAggregate()
    expect(() => verify(aggregate, buildRecords(aggregate))).not.toThrow()
  })

  it("rejects a missing platform receipt", () => {
    const aggregate = buildAggregate()
    delete (aggregate.platforms as Record<string, unknown>).arm64
    expect(() => verify(aggregate, buildRecords(aggregate))).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects an attestation for the wrong subject digest", () => {
    const aggregate = buildAggregate()
    expect(() =>
      verify(aggregate, buildRecords(aggregate, { subjectDigest: "0".repeat(64) }))
    ).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects a wrong index digest in the identity", () => {
    const aggregate = buildAggregate()
    expect(() =>
      verify(aggregate, buildRecords(aggregate), {
        ...IDENTITY,
        indexDigest: "sha256:8233203294f63dee305842334263037acaf7e9e4f75297b87ddfbf0267b3e688",
      })
    ).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects an altered rootfs digest in a platform receipt", () => {
    const aggregate = buildAggregate()
    aggregate.platforms.amd64.rootfsSize = 8 * 1024 * 1024 * 1024 + 1
    expect(() => verify(aggregate, buildRecords(aggregate))).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects an altered Go application receipt", () => {
    const aggregate = buildAggregate()
    aggregate.platforms.arm64.goApplications[0].binarySha256 = "not-a-digest"
    expect(() => verify(aggregate, buildRecords(aggregate))).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects an altered scope or limitations claim", () => {
    const aggregate = buildAggregate()
    aggregate.scope = ["debian:var/lib/dpkg/status"]
    expect(() => verify(aggregate, buildRecords(aggregate))).toThrow(/sandbox SBOM coverage/)
    const second = buildAggregate()
    second.limitations = second.limitations.slice(1)
    expect(() => verify(second, buildRecords(second))).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects a statement predicate that differs from the expected aggregate", () => {
    const aggregate = buildAggregate()
    const tampered = structuredClone(aggregate) as Aggregate
    tampered.platforms.arm64.goApplications[0].binarySha256 = "0".repeat(64)
    expect(() => verify(aggregate, buildRecords(tampered))).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects an attestation with the wrong predicate type", () => {
    const aggregate = buildAggregate()
    const records = buildRecords(aggregate)
    records[0].verificationResult.statement.predicateType =
      "https://lyrashieldai.com/attestations/sandbox-sbom/v1"
    expect(() => verify(aggregate, records)).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects an attestation from an untrusted signer", () => {
    const aggregate = buildAggregate()
    const records = buildRecords(aggregate)
    records[0].verificationResult.signature.certificate.buildSignerURI =
      "https://github.com/attacker/engine/.github/workflows/publish-sandbox.yml@refs/heads/main"
    expect(() => verify(aggregate, records)).toThrow(/sandbox SBOM coverage/)
  })
})

describe("five known rootfs hard failures remain failures", () => {
  const HARD_FAILURES = [
    "usr/lib/python3/dist-packages/mitmproxy/addons/onboardingapp/static/fontawesome",
    "usr/lib/python3/dist-packages/mitmproxy/tools/web/static/fonts",
    "usr/share/nodejs/npm/man",
    "usr/share/nodejs/source-map/package.json",
    "usr/share/nodejs/windows-release/package.json",
  ]

  it("rejects classification-shaped evidence as an aggregate", () => {
    const classification = {
      architecture: "amd64",
      image: "sha256:8233203294f63dee305842334263037acaf7e9e4f75297b87ddfbf0267b3e688",
      priorUnresolved: HARD_FAILURES.map((failedPath) => ({
        classification: "failed",
        path: failedPath,
        reason: "unresolved",
      })),
    }
    const aggregate = buildAggregate()
    expect(() => verify(classification, buildRecords(classification))).toThrow(
      /sandbox SBOM coverage/
    )
    expect(() => verify(aggregate, buildRecords(aggregate))).not.toThrow()
  })

  it("rejects a waiver that drops limitations for the failed paths", () => {
    const aggregate = buildAggregate()
    aggregate.limitations = aggregate.limitations.filter(
      (entry) => !HARD_FAILURES.some((p) => entry.includes(p))
    )
    aggregate.limitations = [
      ...aggregate.limitations,
      `All ${HARD_FAILURES.length} rootfs aliases resolved`,
    ]
    expect(() => verify(aggregate, buildRecords(aggregate))).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects smuggled resolved-status claims in the signed predicate", () => {
    const aggregate = buildAggregate()
    const waived = structuredClone(aggregate) as Aggregate & { unresolved?: string[] }
    waived.unresolved = []
    expect(() => verify(waived, buildRecords(waived))).toThrow(/sandbox SBOM coverage/)
    const smuggled = structuredClone(aggregate) as Aggregate & { unresolved?: string[] }
    smuggled.unresolved = HARD_FAILURES
    expect(() => verify(aggregate, buildRecords(smuggled))).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects coverage for the failed local candidate image", () => {
    // No accepted signed record exists for the candidate image digest: the
    // only signed attestation binds the qualified index, so verification
    // under the candidate digest fails closed.
    const aggregate = buildAggregate()
    const candidate = {
      ...IDENTITY,
      indexDigest: "sha256:8233203294f63dee305842334263037acaf7e9e4f75297b87ddfbf0267b3e688",
    }
    expect(() => verify(aggregate, buildRecords(aggregate), candidate)).toThrow(
      /sandbox SBOM coverage/
    )
  })
})
