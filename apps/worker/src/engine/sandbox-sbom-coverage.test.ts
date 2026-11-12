/**
 * Tests for bounded SBOM coverage content policy using fabricated JSON,
 * mirroring the engine's `test_sandbox_sbom_coverage.py` and
 * `test_sandbox_attestation_verification.py` style: positive acceptance of a
 * well-formed aggregate, and negative cases for missing platform receipts,
 * wrong digests, and altered receipts. The five known rootfs hard failures
 * must remain failures — no waivers.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const coldFiles = vi.hoisted(() => ({
  paths: new Map<string, string>(),
  fds: new Set<number>(),
  owner: 0,
  writable: false,
  mount: true,
}))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    openSync: (path: string, flags: number) => {
      const mapped = coldFiles.paths.get(path)
      const fd = actual.openSync(mapped ?? path, flags)
      if (mapped) coldFiles.fds.add(fd)
      return fd
    },
    closeSync: (fd: number) => {
      coldFiles.fds.delete(fd)
      actual.closeSync(fd)
    },
    fstatSync: (fd: number) => {
      const value = actual.fstatSync(fd)
      return coldFiles.fds.has(fd)
        ? Object.assign(value, {
            uid: coldFiles.owner,
            mode: (value.mode & ~0o777) | (coldFiles.writable ? 0o644 : 0o444),
          })
        : value
    },
    lstatSync: (path: string) => {
      if (coldFiles.paths.size && path === "/etc/lyrashield/cold-sandbox")
        return { isDirectory: () => true, uid: coldFiles.owner, mode: 0o40555 }
      return actual.lstatSync(coldFiles.paths.get(path) ?? path)
    },
    readFileSync: (path: string, encoding: "utf8") =>
      path === "/proc/self/mountinfo" && coldFiles.paths.size
        ? `1 0 0:1 / /etc/lyrashield/cold-sandbox ${coldFiles.mount ? "ro" : "rw"} - tmpfs tmpfs ro\n`
        : actual.readFileSync(path, encoding),
  }
})

import {
  SBOM_COVERAGE_LIMITATIONS,
  SBOM_COVERAGE_LIMITS,
  SBOM_COVERAGE_LINK_POLICY,
  SBOM_COVERAGE_POLICY,
  SBOM_COVERAGE_PREDICATE_TYPE,
  SBOM_COVERAGE_REQUIRED_APPS,
  SBOM_COVERAGE_SCOPE,
  verifySandboxSbomCoverage,
  assertSandboxSbomCoverageVerified,
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
            buildSignerDigest: WORKFLOW_REVISION,
            sourceRepositoryURI: `https://github.com/${REPO}`,
            sourceRepositoryDigest: WORKFLOW_REVISION,
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
    revision: WORKFLOW_REVISION,
    ref: REF,
  })
}

describe("verifySandboxSbomCoverage", () => {
  it("accepts structurally matching coverage JSON for both platforms", () => {
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

  it("rejects JSON naming an unapproved signer", () => {
    const aggregate = buildAggregate()
    const records = buildRecords(aggregate)
    records[0].verificationResult.signature.certificate.buildSignerURI =
      "https://github.com/attacker/engine/.github/workflows/publish-sandbox.yml@refs/heads/main"
    expect(() => verify(aggregate, records)).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects a certificate bound to the engine revision instead of the workflow run", () => {
    const aggregate = buildAggregate()
    const records = buildRecords(aggregate)
    records[0].verificationResult.signature.certificate.buildSignerDigest = ENGINE_REVISION
    records[0].verificationResult.signature.certificate.sourceRepositoryDigest = ENGINE_REVISION
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

  it("rejects smuggled resolved-status claims in the coverage predicate", () => {
    const aggregate = buildAggregate()
    const waived = structuredClone(aggregate) as Aggregate & { unresolved?: string[] }
    waived.unresolved = []
    expect(() => verify(waived, buildRecords(waived))).toThrow(/sandbox SBOM coverage/)
    const smuggled = structuredClone(aggregate) as Aggregate & { unresolved?: string[] }
    smuggled.unresolved = HARD_FAILURES
    expect(() => verify(aggregate, buildRecords(smuggled))).toThrow(/sandbox SBOM coverage/)
  })

  it("rejects coverage for the failed local candidate image", () => {
    // No matching record exists for the candidate image digest: the
    // fixture binds the qualified index, so content validation
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

// Synthetic verifier JSON checks the controlled mount contract only. Authenticity
// is established by the protected producer's real pinned-GH OCI verification.
describe("cold protected sandbox evidence mount", () => {
  let directory = ""
  afterEach(() => {
    coldFiles.paths.clear()
    coldFiles.fds.clear()
    coldFiles.owner = 0
    coldFiles.writable = false
    coldFiles.mount = true
    if (directory) rmSync(directory, { recursive: true, force: true })
    directory = ""
  })
  function runtime() {
    directory = mkdtempSync(join(tmpdir(), "cold-sbom-"))
    const aggregate = buildAggregate()
    for (const [name, value] of [
      ["verification", buildRecords(aggregate)],
      ["expected", aggregate],
    ] as const) {
      const path = join(directory, name + ".json")
      writeFileSync(path, JSON.stringify(value))
      coldFiles.paths.set("/etc/lyrashield/cold-sandbox/" + name + ".json", path)
    }
    return {
      LYRASHIELD_COLD_SINGLE_WORKER: "1",
      LYRASHIELD_COLD_DATABASE_EPOCH_SHA256: "1".repeat(64),
      LYRASHIELD_PRODUCT_REVISION: "2".repeat(40),
      LYRASHIELD_WORKER_IMAGE_DIGEST: "sha256:" + "3".repeat(64),
      LYRASHIELD_WORKER_CONCURRENCY: "1",
      LYRASHIELD_ENGINE_REVISION: ENGINE_REVISION,
      LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH:
        "/etc/lyrashield/cold-sandbox/verification.json",
      LYRASHIELD_SANDBOX_SBOM_COVERAGE_EXPECTED_PATH: "/etc/lyrashield/cold-sandbox/expected.json",
      LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO: REPO,
      LYRASHIELD_SANDBOX_SBOM_COVERAGE_REF: REF,
      LYRASHIELD_SANDBOX_SBOM_COVERAGE_ENGINE_REVISION: ENGINE_REVISION,
      LYRASHIELD_SANDBOX_SBOM_COVERAGE_WORKFLOW_REVISION: WORKFLOW_REVISION,
      LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ID: "123",
      LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ATTEMPT: "2",
    }
  }
  it("accepts matching bytes only through the root-owned read-only cold mount", () => {
    expect(() =>
      assertSandboxSbomCoverageVerified(runtime(), IMAGE_NAME + "@" + INDEX_DIGEST)
    ).not.toThrow()
  })
  it("flags cannot replace mount ownership, read-only state, epoch or image binding", () => {
    const env = runtime()
    for (const changed of [
      { LYRASHIELD_COLD_DATABASE_EPOCH_SHA256: "" },
      { LYRASHIELD_WORKER_CONCURRENCY: "2" },
      { LYRASHIELD_ENGINE_REVISION: "f".repeat(40) },
      { LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH: "/tmp/approval.json" },
    ]) {
      expect(() =>
        assertSandboxSbomCoverageVerified({ ...env, ...changed }, IMAGE_NAME + "@" + INDEX_DIGEST)
      ).toThrow()
    }
    coldFiles.owner = 1001
    expect(() => assertSandboxSbomCoverageVerified(env, IMAGE_NAME + "@" + INDEX_DIGEST)).toThrow()
    coldFiles.owner = 0
    coldFiles.mount = false
    expect(() => assertSandboxSbomCoverageVerified(env, IMAGE_NAME + "@" + INDEX_DIGEST)).toThrow()
    coldFiles.mount = true
    coldFiles.writable = true
    expect(() => assertSandboxSbomCoverageVerified(env, IMAGE_NAME + "@" + INDEX_DIGEST)).toThrow()
  })
  it("tampered verification bytes and noncold authority stay closed", () => {
    const env = runtime()
    const aggregate = buildAggregate()
    const records = buildRecords(aggregate, { subjectDigest: "f".repeat(64) })
    writeFileSync(
      coldFiles.paths.get(env.LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH)!,
      JSON.stringify(records)
    )
    expect(() => assertSandboxSbomCoverageVerified(env, IMAGE_NAME + "@" + INDEX_DIGEST)).toThrow()
    expect(() =>
      assertSandboxSbomCoverageVerified(
        { ...env, LYRASHIELD_COLD_SINGLE_WORKER: "0" },
        IMAGE_NAME + "@" + INDEX_DIGEST
      )
    ).toThrow()
  })
})
