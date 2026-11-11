/* eslint-disable security/detect-non-literal-fs-filename -- Only verifier-owned temporary paths are inspected. */
import assert from "node:assert/strict"
import test from "node:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import * as foundation from "../runtime-qualification-foundation.mjs"
import { checkIssuerHealth } from "../qualification-issuer-health.mjs"
import { verifyQualificationIssuerToken } from "../paired-runtime-github.mjs"

const repo = "ecryptoguru/lyrashield-engine"
const image = "ghcr.io/ecryptoguru/lyrashield-sandbox"
const workflow = repo + "/.github/workflows/publish-sandbox.yml"
const san = "https://github.com/" + workflow + "@refs/heads/main"
const expected = {
  publicationRevision: "a".repeat(40),
  sandboxDigest: "sha256:" + "b".repeat(64),
  publishRunId: "42",
  publishAttempt: "2",
}
const now = Date.parse("2026-11-11T12:00:00.000Z")
const invocation = "https://github.com/" + repo + "/actions/runs/42/attempts/2"
// Synthetic process fixtures do not claim a real attestation or native coverage.
const raw = JSON.stringify({
  mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
  verificationMaterial: { certificate: { rawBytes: "fixture" } },
  dsseEnvelope: { payload: "fixture", signatures: [{ sig: "fixture" }] },
})
function rows() {
  return [
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
        verifiedTimestamps: [{ type: "Tlog", timestamp: "2026-11-11T11:00:00.000Z" }],
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [{ name: image, digest: { sha256: expected.sandboxDigest.slice(7) } }],
          predicate: { runDetails: { metadata: { invocationId: invocation } } },
        },
      },
    },
  ]
}
const runRows = (value) => ({ run: () => JSON.stringify(value), when: now })

test("raw bundle is reverified with exact pinned policy, private scratch bytes and cleanup", () => {
  let bundlePath
  const result = foundation.verifySandboxAttestationBundle(raw, expected, {
    when: now,
    run: (args) => {
      bundlePath = args[args.indexOf("--bundle") + 1]
      assert.equal(readFileSync(bundlePath, "utf8"), raw)
      assert.equal(statSync(bundlePath).mode & 0o777, 0o600)
      assert.deepEqual(args, [
        "attestation",
        "verify",
        "oci://" + image + "@" + expected.sandboxDigest,
        "--bundle",
        bundlePath,
        "--hostname",
        "github.com",
        "--repo",
        repo,
        "--signer-workflow",
        workflow,
        "--cert-identity",
        san,
        "--cert-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        "--signer-digest",
        expected.publicationRevision,
        "--source-digest",
        expected.publicationRevision,
        "--source-ref",
        "refs/heads/main",
        "--predicate-type",
        "https://slsa.dev/provenance/v1",
        "--deny-self-hosted-runners",
        "--format",
        "json",
      ])
      return JSON.stringify(rows())
    },
  })
  assert.equal(existsSync(bundlePath), false)
  assert.deepEqual(result, {
    schema: "lyrashield-sandbox-provenance-check/1",
    qualified: false,
    packageCoverage: "UNVERIFIED",
    bundleChecksum: createHash("sha256").update(raw).digest("hex"),
    ...expected,
    checkedAt: new Date(now).toISOString(),
  })
  assert.ok(Object.isFrozen(result))
})

test("saved verification JSON and malformed, oversized or unbounded inputs never invoke gh", () => {
  let calls = 0
  const options = {
    run: () => {
      calls++
      return JSON.stringify(rows())
    },
    when: now,
  }
  for (const untrusted of [
    JSON.stringify(rows()),
    JSON.stringify(rows()[0]),
    "{",
    "x".repeat(1048577),
    "null",
    "{}",
  ])
    assert.throws(() => foundation.verifySandboxAttestationBundle(untrusted, expected, options))
  for (const field of Object.keys(expected))
    assert.throws(() =>
      foundation.verifySandboxAttestationBundle(raw, { ...expected, [field]: "foreign" }, options)
    )
  assert.throws(() =>
    foundation.verifySandboxAttestationBundle(raw, { ...expected, qualified: true }, options)
  )
  const getter = { ...expected }
  Object.defineProperty(getter, "publicationRevision", {
    get: () => {
      throw new Error("getter")
    },
  })
  assert.throws(() => foundation.verifySandboxAttestationBundle(raw, getter, options))
  assert.equal(calls, 0)
})

test("verifier failure, invalid stdout and ambiguous results fail closed and clean private bytes", () => {
  let bundlePath
  for (const output of ["{", "null", "[]", "{}", JSON.stringify([...rows(), ...rows()])]) {
    assert.throws(() =>
      foundation.verifySandboxAttestationBundle(raw, expected, {
        when: now,
        run: (args) => {
          bundlePath = args[args.indexOf("--bundle") + 1]
          return output
        },
      })
    )
    assert.equal(existsSync(bundlePath), false)
  }
  assert.throws(() =>
    foundation.verifySandboxAttestationBundle(raw, expected, {
      when: now,
      run: (args) => {
        bundlePath = args[args.indexOf("--bundle") + 1]
        throw new Error("cryptographic verification rejected tampered bundle")
      },
    })
  )
  assert.equal(existsSync(bundlePath), false)
})

test("signed-certificate identity and run attempt cannot be substituted by matching predicate claims", () => {
  for (const field of Object.keys(rows()[0].verificationResult.signature.certificate)) {
    const changed = rows()
    changed[0].verificationResult.signature.certificate[field] = "foreign"
    assert.throws(
      () => foundation.verifySandboxAttestationBundle(raw, expected, runRows(changed)),
      field
    )
  }
  for (const field of ["publishRunId", "publishAttempt", "publicationRevision", "sandboxDigest"]) {
    const changed = {
      ...expected,
      [field]: field.startsWith("publish") ? "3" : expected[field].replaceAll(/a|b/g, "c"),
    }
    assert.throws(
      () => foundation.verifySandboxAttestationBundle(raw, changed, runRows(rows())),
      field
    )
  }
})

test("subject substitution, extra subjects, predicate drift and absent timestamp proof are rejected", () => {
  const mutations = [
    (r) => {
      r.statement.subject[0].name += "/foreign"
    },
    (r) => {
      r.statement.subject[0].digest.sha256 = "c".repeat(64)
    },
    (r) => {
      r.statement.subject.push(r.statement.subject[0])
    },
    (r) => {
      r.statement._type = "foreign"
    },
    (r) => {
      r.statement.predicateType = "foreign"
    },
    (r) => {
      r.statement.predicate.runDetails.metadata.invocationId = invocation.replace(
        "attempts/2",
        "attempts/1"
      )
    },
    (r) => {
      r.verifiedTimestamps = []
    },
    (r) => {
      r.verifiedTimestamps[0].timestamp = "invalid"
    },
    (r) => {
      r.verifiedTimestamps[0].timestamp = "2027-01-01T00:00:00.000Z"
    },
  ]
  for (const mutate of mutations) {
    const changed = rows()
    mutate(changed[0].verificationResult)
    assert.throws(() => foundation.verifySandboxAttestationBundle(raw, expected, runRows(changed)))
  }
})

test("qualification has no arbitrary signer, candidate payload or credential-exchange interface", () => {
  assert.deepEqual(Object.keys(foundation).sort(), [
    "issueRuntimeQualification",
    "verifySandboxAttestationBundle",
  ])
  for (const input of [
    undefined,
    raw,
    rows(),
    { qualified: true, run: () => assert.fail("exchange") },
  ])
    assert.throws(
      () => foundation.issueRuntimeQualification(input),
      /trusted evidence readers required/
    )
})

test("cryptographic issuer negatives fail before mocked Key Vault exchange or signing", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256" }] }
  const source = "d".repeat(40),
    productRepo = "ecryptoguru/lyrashield-ai"
  const caller = ".github/workflows/qualify-runtime-issuer.yml"
  const reusable = ".github/workflows/issue-runtime-qualification.yml"
  const identity = {
    source,
    owner: "9:2",
    runId: "9",
    attempt: "2",
    path: caller,
    event: "workflow_dispatch",
    repoId: "1286618458",
    ownerId: "116722580",
  }
  const seconds = now / 1000
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "api://AzureADTokenExchange",
    sub: "repo:" + productRepo + ":environment:release-qualification",
    environment: "release-qualification",
    repository: productRepo,
    repository_id: identity.repoId,
    repository_owner_id: identity.ownerId,
    ref: "refs/heads/main",
    sha: source,
    event_name: identity.event,
    run_id: identity.runId,
    run_attempt: identity.attempt,
    runner_environment: "github-hosted",
    workflow_ref: productRepo + "/" + caller + "@refs/heads/main",
    workflow_sha: source,
    job_workflow_ref: productRepo + "/" + reusable + "@refs/heads/main",
    job_workflow_sha: source,
    iat: seconds - 5,
    nbf: seconds - 5,
    exp: seconds + 60,
  }
  const token = (value) => {
    const base = (part) => Buffer.from(JSON.stringify(part)).toString("base64url")
    const body = base({ alg: "RS256", kid: "fixture" }) + "." + base(value)
    return body + "." + sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")
  }
  verifyQualificationIssuerToken(token(claims), jwks, identity, seconds)
  const negatives = Object.keys(claims).map((field) => token({ ...claims, [field]: "foreign" }))
  negatives.push(
    token({ ...claims, run_attempt: "1" }),
    token({ ...claims, exp: seconds }),
    token({ ...claims, runner_environment: "self-hosted" })
  )
  const tampered = token(claims).split(".")
  tampered[1] = Buffer.from(JSON.stringify({ ...claims, exp: seconds + 90 })).toString("base64url")
  negatives.push(tampered.join("."))
  let exchanges = 0
  for (const candidate of negatives)
    await assert.rejects(
      checkIssuerHealth({
        readIdentity: async () => {
          verifyQualificationIssuerToken(candidate, jwks, identity, seconds)
          return { token: candidate, identity }
        },
        run: () => {
          exchanges++
          assert.fail("Key Vault must not be reached")
        },
      })
    )
  assert.equal(exchanges, 0)
})
