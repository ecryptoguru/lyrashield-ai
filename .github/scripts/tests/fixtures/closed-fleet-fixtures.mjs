// In-memory local keys and synthetic evidence. Never production qualification.
import { createHash, generateKeyPairSync, privateEncrypt, sign, constants } from "node:crypto"
import { canonicalJson, evidenceKinds } from "../../fleet-qualification-schema.ts"

export const now = 1794398400
const pair = (bits) => generateKeyPairSync("rsa", { modulusLength: bits })
const evidenceKeys = Object.fromEntries(
  [...evidenceKinds, "intent"].map((kind) => [kind, pair(2048)])
)
const signingKey = pair(3072),
  oidcKey = pair(2048)
const s256 = (raw) => "sha256:" + createHash("sha256").update(raw).digest("hex")
const digest = (value) => "sha256:" + value.repeat(64)
const revision = (value) => value.repeat(40)
const owner = "42:2"
const product = "ecryptoguru/lyrashield-ai",
  engine = "ecryptoguru/lyrashield-engine"
const caller = ".github/workflows/qualify-runtime-issuer.yml"
const reusable = ".github/workflows/issue-runtime-qualification.yml"
const publication = {
  publicationRevision: revision("d"),
  publishRunId: "90",
  publishAttempt: "1",
  sandboxDigest: digest("5"),
}
const invocation = "https://github.com/" + engine + "/actions/runs/90/attempts/1"
const san =
  "https://github.com/" + engine + "/.github/workflows/publish-sandbox.yml@refs/heads/main"
const fleet = {
  productRevision: revision("a"),
  engineRevision: revision("c"),
  webDigest: digest("1"),
  scannerDigest: digest("1"),
  proxyDigest: digest("2"),
  workerDigest: digest("3"),
  sandboxDigest: digest("5"),
  brokerDigest: digest("6"),
  supervisorDigest: digest("7"),
  providerGatewayDigest: digest("8"),
  migrationChecksum: digest("9"),
  runtimePolicyDigest: digest("0"),
}
export const rawBundle = JSON.stringify({
  mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
  verificationMaterial: { certificate: { rawBytes: "fixture" } },
  dsseEnvelope: { payload: "fixture", signatures: [{ sig: "fixture" }] },
})
const native = {
  manifestDigest: digest("b"),
  inventoryDigest: digest("c"),
  coverageDigest: digest("d"),
  extractorDigest: digest("e"),
  packageCount: 100,
  coveredCount: 100,
  scope: "ALL_ENUMERATED_PACKAGES",
}
function rows() {
  return [
    {
      verificationResult: {
        signature: {
          certificate: {
            issuer: "https://token.actions.githubusercontent.com",
            subjectAlternativeName: san,
            buildSignerURI: san,
            buildSignerDigest: publication.publicationRevision,
            runnerEnvironment: "github-hosted",
            sourceRepositoryURI: "https://github.com/" + engine,
            sourceRepositoryDigest: publication.publicationRevision,
            sourceRepositoryRef: "refs/heads/main",
            sourceRepositoryIdentifier: "1297157605",
            sourceRepositoryOwnerURI: "https://github.com/ecryptoguru",
            sourceRepositoryOwnerIdentifier: "116722580",
            runInvocationURI: invocation,
          },
        },
        verifiedTimestamps: [{ timestamp: new Date((now - 1) * 1000).toISOString() }],
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [
            {
              name: "ghcr.io/ecryptoguru/lyrashield-sandbox",
              digest: { sha256: fleet.sandboxDigest.slice(7) },
            },
          ],
          predicate: { runDetails: { metadata: { invocationId: invocation } } },
        },
      },
    },
  ]
}
function fixtureData() {
  return structuredClone({
    fleet,
    source: {
      productRepositoryId: "1286618458",
      engineRepositoryId: "1297157605",
      repositoryOwnerId: "116722580",
      productRevision: fleet.productRevision,
      engineRevision: fleet.engineRevision,
      productTreeSha: revision("b"),
      engineTreeSha: revision("f"),
      productCiReceiptDigest: digest("d"),
      engineCiReceiptDigest: digest("e"),
      productWorkflow: ".github/workflows/ci.yml",
      productRunId: "31",
      productAttempt: "1",
      engineWorkflow: ".github/workflows/ci.yml",
      engineRunId: "80",
      engineAttempt: "2",
      publication,
    },
    inventory: {
      provenanceBundleDigest: s256(rawBundle),
      amd64: native,
      arm64: { ...native, manifestDigest: digest("f") },
    },
    migration: { checksum: fleet.migrationChecksum, schemaProofDigest: digest("a") },
    policy: { digest: fleet.runtimePolicyDigest, policyProofDigest: digest("b") },
    journal: {
      epoch: 3,
      sequence: 10,
      supervisorHeadDigest: digest("c"),
      independentHeadDigest: digest("c"),
      postgresHeadDigest: digest("c"),
      confirmedOperationDigest: digest("d"),
    },
    rollback: {
      fleet: { ...fleet, productRevision: revision("e"), workerDigest: digest("f") },
      archiveDigest: digest("a"),
      admission: "held",
      journalProofDigest: digest("b"),
    },
  })
}

function mockKeyVaultResult(args, managedKey) {
  const bytes = Buffer.from(args[args.indexOf("--digest") + 1], "base64")
  // Mock the RSA PKCS#1 v1.5 SHA-256 digest-signing primitive, not a live key.
  const encoded = Buffer.concat([
    Buffer.from("3031300d060960864801650304020105000420", "hex"),
    bytes,
  ])
  return {
    algorithm: "RS256",
    keyId: managedKey.keyId,
    signature: privateEncrypt(
      { key: signingKey.privateKey, padding: constants.RSA_PKCS1_PADDING },
      encoded
    ).toString("base64"),
  }
}

export function fixture() {
  const calls = [],
    intents = []
  const identity = {
    source: fleet.productRevision,
    owner,
    runId: "42",
    attempt: "2",
    path: caller,
    event: "workflow_dispatch",
    repoId: "1286618458",
    ownerId: "116722580",
  }
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "api://AzureADTokenExchange",
    sub: "repo:" + product + ":environment:release-qualification",
    environment: "release-qualification",
    repository: product,
    repository_id: identity.repoId,
    repository_owner_id: identity.ownerId,
    ref: "refs/heads/main",
    sha: identity.source,
    event_name: identity.event,
    run_id: identity.runId,
    run_attempt: identity.attempt,
    runner_environment: "github-hosted",
    workflow_ref: product + "/" + caller + "@refs/heads/main",
    workflow_sha: identity.source,
    job_workflow_ref: product + "/" + reusable + "@refs/heads/main",
    job_workflow_sha: identity.source,
    iat: now - 5,
    nbf: now - 5,
    exp: now + 600,
  }
  const jwt = (value = claims) => {
    const encode = (part) => Buffer.from(JSON.stringify(part)).toString("base64url")
    const body = encode({ alg: "RS256", kid: "fixture-oidc" }) + "." + encode(value)
    return (
      body + "." + sign("RSA-SHA256", Buffer.from(body), oidcKey.privateKey).toString("base64url")
    )
  }
  const trust = Object.fromEntries(
    [...evidenceKinds, "intent"].map((kind) => [
      kind,
      {
        keyId: "urn:closed-evidence:" + kind,
        publicKey: evidenceKeys[kind].publicKey.export({ format: "jwk" }),
      },
    ])
  )
  const data = fixtureData()
  const records = Object.fromEntries(
    evidenceKinds.map((kind) => [
      kind,
      {
        schema: "lyrashield-closed-fleet-evidence/1",
        kind,
        owner,
        epoch: 3,
        bindingDigest: s256(canonicalJson(fleet)),
        issuedAt: now - 1,
        expiresAt: now + 600,
        data: data[kind],
      },
    ])
  )
  const signedEvidence = (kind, value = records[kind]) => {
    const raw = canonicalJson(value)
    return {
      raw,
      algorithm: "RS256",
      keyId: trust[kind].keyId,
      signature: sign("RSA-SHA256", Buffer.from(raw), evidenceKeys[kind].privateKey).toString(
        "base64"
      ),
    }
  }
  const managedKey = {
    keyId: "https://fixture.vault.azure.net/keys/closed-fleet/" + "1".repeat(32),
    algorithm: "RS256",
    publicKey: signingKey.publicKey.export({ format: "jwk" }),
    clientId: "00000000-0000-4000-8000-000000000001",
    tenantId: "00000000-0000-4000-8000-000000000002",
  }
  const ports = {
    issuer: async () => ({
      token: jwt(),
      identity,
      jwks: {
        keys: [
          {
            ...oidcKey.publicKey.export({ format: "jwk" }),
            kid: "fixture-oidc",
            alg: "RS256",
            use: "sig",
          },
        ],
      },
    }),
    readers: Object.fromEntries(
      evidenceKinds.map((kind) => [kind, async () => signedEvidence(kind)])
    ),
    sandboxBundle: async () => rawBundle,
    attestationProcess: () => JSON.stringify(rows()),
    claimIntent: async (request) => {
      const intent = {
        schema: "lyrashield-closed-fleet-intent/1",
        ...request,
        status: "CLAIMED",
        issuedAt: now,
        expiresAt: now + 600,
      }
      const envelope = signedEvidence("intent", intent)
      intents.push(envelope)
      return envelope
    },
    refreshJournal: async (request) => {
      const latest = JSON.parse((await ports.readers.journal()).raw)
      return signedEvidence("journal", {
        schema: "lyrashield-closed-journal-readback/1",
        ...request,
        issuedAt: now,
        expiresAt: now + 600,
        data: latest.data,
      })
    },
    azure: async (args) => {
      calls.push(args)
      return args[0] === "keyvault" ? mockKeyVaultResult(args, managedKey) : null
    },
    trust,
    managedKey,
    clock: () => now,
  }
  return {
    ports,
    calls,
    intents,
    claims,
    jwt,
    identity,
    records,
    signedEvidence,
    managedKey,
    rows,
    data,
  }
}
