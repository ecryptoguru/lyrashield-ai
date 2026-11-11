import assert from "node:assert/strict"
import test from "node:test"
import { createPublicKey } from "node:crypto"
import {
  createClosedFleetIssuer,
  issueRuntimeFleetQualification,
  verifyClosedFleetSignature,
} from "../closed-fleet-issuer.ts"
import { canonicalJson, evidenceKinds } from "../fleet-qualification-schema.ts"
import { fixture, now, rawBundle } from "./fixtures/closed-fleet-fixtures.mjs"

test("trust roles cannot share an RSA key through modulus aliases or relabeled key identities", () => {
  const spki = (jwk) =>
    createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "der" })
  for (const role of ["inventory", "intent"]) {
    const f = fixture()
    const original = f.ports.trust.source.publicKey
    const alias = {
      ...original,
      n: Buffer.concat([Buffer.from([0]), Buffer.from(original.n, "base64url")]).toString(
        "base64url"
      ),
    }
    assert.notEqual(alias.n, original.n)
    assert.deepEqual(spki(alias), spki(original)) // The old string comparison accepted this same-key alias.
    f.ports.trust[role] = { keyId: f.ports.trust[role].keyId, publicKey: alias }
    assert.throws(() => createClosedFleetIssuer(f.ports))
    assert.deepEqual(f.calls, [])

    const relabeled = fixture()
    relabeled.ports.trust[role] = {
      keyId: relabeled.ports.trust[role].keyId,
      publicKey: relabeled.ports.trust.source.publicKey,
    }
    assert.throws(() => createClosedFleetIssuer(relabeled.ports))
    assert.deepEqual(relabeled.calls, [])
  }
})

test("noncanonical RSA integers and malformed key material are rejected before signing", () => {
  const f = fixture(),
    original = f.ports.trust.source.publicKey
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  const last = alphabet.indexOf(original.n.at(-1))
  const trailingBits = original.n.slice(0, -1) + alphabet[last + 1]
  assert.deepEqual(Buffer.from(trailingBits, "base64url"), Buffer.from(original.n, "base64url"))
  for (const change of [
    { n: trailingBits },
    { n: "A" },
    { n: "A".repeat(1025) },
    { e: "AAEAAQ" },
  ]) {
    const changed = fixture()
    changed.ports.trust.source.publicKey = { ...original, ...change }
    assert.throws(() => createClosedFleetIssuer(changed.ports))
    assert.deepEqual(changed.calls, [])
  }
  const managed = fixture()
  managed.ports.managedKey.publicKey.n = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(managed.ports.managedKey.publicKey.n, "base64url"),
  ]).toString("base64url")
  assert.throws(() => createClosedFleetIssuer(managed.ports))
  assert.deepEqual(managed.calls, [])
})

test("complete independently signed inputs produce only a canonical closed candidate and verified managed-RSA signature", async () => {
  const f = fixture()
  const result = await createClosedFleetIssuer(f.ports).issueCandidate({
    arbitrary: "never-signed",
  })
  const candidate = verifyClosedFleetSignature(result.raw, result.result, f.managedKey, now)
  assert.equal(result.raw, canonicalJson(candidate))
  assert.equal(result.qualified, false)
  assert.equal(candidate.productionQualification, false)
  assert.equal(candidate.kind, "closed-fleet-candidate")
  assert.equal(candidate.fleet.scannerDigest, f.data.fleet.scannerDigest)
  assert.deepEqual(candidate.fleet, f.data.fleet)
  assert.deepEqual(candidate.rollback, f.data.rollback)
  assert.deepEqual(candidate.journal, f.data.journal)
  assert.equal(
    candidate.source.publication.publicationRevision,
    f.data.source.publication.publicationRevision
  )
  assert.notEqual(candidate.source.publication.publicationRevision, candidate.fleet.engineRevision)
  assert.equal(candidate.expiresAt, now + 600)
  assert.equal(result.raw.includes("never-signed"), false)
  assert.deepEqual(
    f.calls.map((args) => args[0]),
    ["login", "keyvault", "logout"]
  )
  assert.equal(f.calls[1][f.calls[1].indexOf("--id") + 1], f.managedKey.keyId)
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.result))
  assert.throws(() => verifyClosedFleetSignature(result.raw, result.result)) // Actual managed pin differs.
  assert.throws(() =>
    verifyClosedFleetSignature(result.raw, result.result, f.managedKey, now + 600)
  )
  assert.throws(() =>
    verifyClosedFleetSignature(result.raw + " ", result.result, f.managedKey, now)
  )
  assert.throws(() =>
    verifyClosedFleetSignature(
      result.raw.replace('"productionQualification":false', '"productionQualification":true'),
      result.result,
      f.managedKey,
      now
    )
  )
})

test("every missing, unavailable, unsigned, mismatched or ambiguous evidence port prevents Key Vault access", async () => {
  for (const kind of evidenceKinds) {
    let f = fixture()
    delete f.ports.readers[kind]
    assert.throws(() => createClosedFleetIssuer(f.ports), kind)
    assert.deepEqual(f.calls, [])
    for (const value of [
      null,
      { passed: true },
      [],
      { ...f.signedEvidence(kind), signature: "foreign" },
    ]) {
      f = fixture()
      f.ports.readers[kind] = async () => value
      await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate(), kind)
      assert.deepEqual(f.calls, [])
    }
    f = fixture()
    f.ports.readers[kind] = async () => {
      throw new Error("private reader credentials")
    }
    await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate(), /reader unavailable/)
    assert.deepEqual(f.calls, [])
  }
  for (const kind of [...evidenceKinds, "intent"]) {
    const f = fixture()
    delete f.ports.trust[kind]
    assert.throws(() => createClosedFleetIssuer(f.ports))
    assert.deepEqual(f.calls, [])
  }
  const f = fixture()
  f.ports.trust.inventory = f.ports.trust.journal
  assert.throws(() => createClosedFleetIssuer(f.ports))
  assert.deepEqual(f.calls, [])
  for (const port of ["issuer", "sandboxBundle", "claimIntent", "refreshJournal", "azure"]) {
    const missing = fixture()
    delete missing.ports[port]
    assert.throws(() => createClosedFleetIssuer(missing.ports))
    assert.deepEqual(missing.calls, [])
  }
})

test("authenticated evidence remains bound to exact tuple, request owner, epoch, validity and native inventory", async () => {
  const changes = [
    (f) => {
      f.records.inventory.data.amd64.coveredCount--
    },
    (f) => {
      f.records.inventory.data.arm64.packageCount = 10001
    },
    (f) => {
      f.records.inventory.data.amd64.scope = "CLAIMED"
    },
    (f) => {
      f.records.inventory.data.provenanceBundleDigest = "sha256:" + "f".repeat(64)
    },
    (f) => {
      f.records.source.data.engineRevision = "b".repeat(40)
    },
    (f) => {
      f.records.source.data.engineRepositoryId = "1"
    },
    (f) => {
      f.records.source.data.repositoryOwnerId = "1"
    },
    (f) => {
      f.records.source.data.engineWorkflow = ".github/workflows/foreign.yml"
    },
    (f) => {
      f.records.source.data.productRevision = "b".repeat(40)
    },
    (f) => {
      f.records.source.data.publication.sandboxDigest = "sha256:" + "a".repeat(64)
    },
    (f) => {
      f.records.policy.data.digest = "sha256:" + "a".repeat(64)
    },
    (f) => {
      f.records.migration.data.checksum = "sha256:" + "a".repeat(64)
    },
    (f) => {
      f.records.journal.data.independentHeadDigest = "sha256:" + "f".repeat(64)
    },
    (f) => {
      f.records.journal.data.postgresHeadDigest = "sha256:" + "f".repeat(64)
    },
    (f) => {
      f.records.rollback.data.fleet.engineRevision = "f".repeat(40)
    },
    (f) => {
      f.records.rollback.data.fleet.migrationChecksum = "sha256:" + "f".repeat(64)
    },
    (f) => {
      f.records.rollback.data.fleet = f.data.fleet
    },
    (f) => {
      f.records.rollback.data.admission = "open"
    },
  ]
  for (const change of changes) {
    const f = fixture()
    change(f)
    await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate())
    assert.deepEqual(f.calls, [])
  }
  for (const kind of evidenceKinds)
    for (const [field, value] of Object.entries({
      owner: "43:2",
      epoch: 4,
      bindingDigest: "sha256:" + "e".repeat(64),
      expiresAt: now,
      issuedAt: now + 1,
    })) {
      const f = fixture()
      f.records[kind][field] = value
      await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate(), kind + "/" + field)
      assert.deepEqual(f.calls, [])
    }
  const f = fixture()
  f.records.inventory.expiresAt = now + 900 // 901 seconds from its signed issue time.
  await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate())
  assert.deepEqual(f.calls, [])
  const stale = fixture(),
    refresh = stale.ports.refreshJournal
  stale.ports.refreshJournal = async (request) => {
    const body = JSON.parse((await refresh(request)).raw)
    body.nonce = "00000000-0000-4000-8000-000000000001"
    return stale.signedEvidence("journal", body)
  }
  await assert.rejects(createClosedFleetIssuer(stale.ports).issueCandidate())
  assert.deepEqual(stale.calls, [])
})

test("raw bundle verification cannot be replaced by saved JSON, tampered output or an unavailable verifier", async () => {
  for (const bundle of [JSON.stringify(fixture().rows()), "{", "{}"]) {
    const f = fixture()
    f.ports.sandboxBundle = async () => bundle
    await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate())
    assert.deepEqual(f.calls, [])
  }
  const f = fixture()
  f.ports.attestationProcess = () => {
    throw new Error("tampered bundle rejected")
  }
  await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate())
  assert.deepEqual(f.calls, [])
  assert.equal(await fixture().ports.sandboxBundle(), rawBundle)
})

test("real OIDC signature rejects issuer, fork, hosted-runner and reusable-workflow substitutions before signing", async () => {
  for (const [field, value] of Object.entries({
    iss: "https://foreign.example",
    repository: "fork/lyrashield-ai",
    repository_id: "1",
    repository_owner_id: "1",
    ref: "refs/heads/fork",
    sha: "b".repeat(40),
    run_id: "43",
    run_attempt: "1",
    runner_environment: "self-hosted",
    workflow_ref: "foreign",
    job_workflow_ref: "foreign",
    job_workflow_sha: "b".repeat(40),
    exp: now,
  })) {
    const f = fixture(),
      original = f.ports.issuer
    f.ports.issuer = async () => ({
      ...(await original()),
      token: f.jwt({ ...f.claims, [field]: value }),
    })
    await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate(), field)
    assert.deepEqual(f.calls, [])
  }
  const f = fixture(),
    original = f.ports.issuer
  const parts = f.jwt().split(".")
  parts[1] = Buffer.from(JSON.stringify({ ...f.claims, extra: "tamper" })).toString("base64url")
  f.ports.issuer = async () => ({ ...(await original()), token: parts.join(".") })
  await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate())
  assert.deepEqual(f.calls, [])
})

test("signed create-once intent, journal refresh and run freshness are mandatory before credential exchange", async () => {
  const mutations = [
    (intent) => {
      intent.status = "EXISTING"
    },
    (intent) => {
      intent.candidateDigest = "sha256:" + "f".repeat(64)
    },
    (intent) => {
      intent.nonce = "00000000-0000-4000-8000-000000000001"
    },
    (intent) => {
      intent.owner = "43:2"
    },
    (intent) => {
      intent.epoch++
    },
    (intent) => {
      intent.expiresAt = now
    },
  ]
  for (const change of mutations) {
    const f = fixture(),
      claim = f.ports.claimIntent
    f.ports.claimIntent = async (request) => {
      const intent = JSON.parse((await claim(request)).raw)
      change(intent)
      return f.signedEvidence("intent", intent)
    }
    await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate())
    assert.deepEqual(f.calls, [])
  }
  const f = fixture(),
    journal = f.ports.readers.journal
  let reads = 0
  f.ports.readers.journal = async () => {
    if (++reads > 1) f.records.journal.data.sequence++
    return journal()
  }
  await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate())
  assert.deepEqual(f.calls, [])
})

test("lost intent acknowledgement stays closed; repeated or replayed issuance cannot sign", async () => {
  const f = fixture()
  f.ports.claimIntent = async () => {
    throw new Error("lost acknowledgement")
  }
  const issuer = createClosedFleetIssuer(f.ports)
  await assert.rejects(issuer.issueCandidate())
  await assert.rejects(issuer.issueCandidate())
  assert.deepEqual(f.calls, [])
  const first = fixture()
  await createClosedFleetIssuer(first.ports).issueCandidate()
  const replay = fixture()
  replay.ports.claimIntent = async () => first.intents[0]
  await assert.rejects(createClosedFleetIssuer(replay.ports).issueCandidate())
  assert.deepEqual(replay.calls, [])
})

test("managed signature tampering, wrong key, algorithm or expiry cannot return a signed candidate", async () => {
  for (const field of ["signature", "keyId", "algorithm"]) {
    const f = fixture(),
      azure = f.ports.azure
    f.ports.azure = async (args) => {
      const result = await azure(args)
      return args[0] === "keyvault" ? { ...result, [field]: "foreign" } : result
    }
    await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate(), field)
    assert.equal(f.calls.at(-1)[0], "logout")
  }
  const f = fixture(),
    azure = f.ports.azure
  let seconds = now
  f.ports.clock = () => seconds
  f.ports.azure = async (args) => {
    const result = await azure(args)
    if (args[0] === "login") seconds += 600
    return result
  }
  await assert.rejects(createClosedFleetIssuer(f.ports).issueCandidate())
  assert.deepEqual(
    f.calls.map((args) => args[0]),
    ["login", "logout"]
  )
})

test("production issuance remains unavailable and no generic signing payload is exposed", () => {
  for (const input of [
    undefined,
    "arbitrary bytes",
    { qualified: true, azure: () => assert.fail("cloud access") },
  ])
    assert.throws(() => issueRuntimeFleetQualification(input), /not wired/)
})
