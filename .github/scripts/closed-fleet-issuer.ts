// Closed rehearsal only. No workflow, production qualification or generic signer.
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto"
import { readFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import { verifyQualificationIssuerToken } from "./paired-runtime-github.mjs"
import { verifySandboxAttestationBundle } from "./runtime-qualification-foundation.mjs"
import {
  candidateSchema,
  canonicalJson,
  evidenceHeaderSchema,
  evidenceKinds,
  evidenceSchemas,
  intentSchema,
  journalReadbackSchema,
  issuerIdentitySchema,
  keyPinSchema,
  managedKeySchema,
  signedEnvelopeSchema,
  signatureResultSchema,
  type EvidenceData,
  type EvidenceKind,
  type FleetCandidate,
  type IssuanceIntent,
  type JournalReadback,
  type KeyPin,
  type ManagedKey,
  type SignedEnvelope,
} from "./fleet-qualification-schema.ts"

export function resolveManagedKeyPin(configuration: unknown, runtime: unknown): ManagedKey {
  const issuer = managedKeySchema.omit({ publicKey: true }).parse(configuration)
  const publicPin = managedKeySchema
    .pick({ keyId: true, algorithm: true, publicKey: true })
    .parse(runtime)
  if (issuer.keyId !== publicPin.keyId || issuer.algorithm !== publicPin.algorithm)
    throw new Error("Closed fleet signer public key does not match issuer identity")
  return managedKeySchema.parse({ ...issuer, publicKey: publicPin.publicKey })
}

const managedKey = resolveManagedKeyPin(
  JSON.parse(
    // Source-controlled public configuration, no private key or credential.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFileSync(new URL("../qualification-issuer-key.json", import.meta.url), "utf8")
  ),
  JSON.parse(
    // Shared worker-verification pin; its identity must match the issuer.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFileSync(
      new URL("../../packages/security/src/runtime-qualification-key.json", import.meta.url),
      "utf8"
    )
  )
)
const digest = (raw: string) => "sha256:" + createHash("sha256").update(raw).digest("hex")
function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error("Closed fleet qualification proof unavailable or mismatched")
}
function key(pin: KeyPin, bits: number) {
  for (const encoded of [pin.publicKey.n, pin.publicKey.e]) {
    const bytes = Buffer.from(encoded, "base64url")
    requireProof(bytes.length > 0 && bytes[0] !== 0 && bytes.toString("base64url") === encoded)
  }
  const result = createPublicKey({ key: pin.publicKey, format: "jwk" })
  requireProof(
    result.asymmetricKeyType === "rsa" &&
      result.asymmetricKeyDetails?.modulusLength === bits &&
      result.asymmetricKeyDetails.publicExponent === 65537n
  )
  return result
}
function keyFingerprint(pin: KeyPin, bits: number) {
  // SPKI represents the imported modulus AND exponent, independent of JWK text.
  return createHash("sha256")
    .update(key(pin, bits).export({ type: "spki", format: "der" }))
    .digest("hex")
}
function authenticate(envelope: unknown, pin: KeyPin, bits = 2048): SignedEnvelope {
  const result = signedEnvelopeSchema.parse(envelope)
  requireProof(Buffer.byteLength(result.raw) <= 16384 && result.keyId === pin.keyId)
  const signature = Buffer.from(result.signature, "base64")
  requireProof(signature.toString("base64") === result.signature && signature.length === bits / 8)
  requireProof(verify("RSA-SHA256", Buffer.from(result.raw), key(pin, bits), signature))
  return result
}
function valid(issuedAt: number, expiresAt: number, when: number) {
  requireProof(Number.isSafeInteger(when) && issuedAt <= when && when < expiresAt)
}
async function read<T>(port: () => Promise<T>): Promise<T> {
  try {
    return await port()
  } catch {
    throw new Error("Closed qualification evidence reader unavailable")
  }
}
type Evidence<K extends EvidenceKind> = {
  envelope: SignedEnvelope
  data: EvidenceData<K>
  expiresAt: number
}
function evidence<K extends EvidenceKind>(
  kind: K,
  value: unknown,
  pin: KeyPin,
  owner: string,
  when: number
): Evidence<K> {
  const envelope = authenticate(value, pin)
  const header = evidenceHeaderSchema.parse(JSON.parse(envelope.raw))
  requireProof(header.kind === kind && header.owner === owner)
  valid(header.issuedAt, header.expiresAt, when)
  const data = evidenceSchemas[kind].parse(header.data) as EvidenceData<K>
  requireProof(envelope.raw === canonicalJson({ ...header, data }))
  return { envelope, data, expiresAt: header.expiresAt }
}
export type IssuerPorts = {
  issuer: () => Promise<{ token: string; jwks: { keys: unknown[] }; identity: unknown }>
  readers: { [K in EvidenceKind]: () => Promise<unknown> }
  sandboxBundle: () => Promise<string>
  claimIntent: (
    request: Omit<IssuanceIntent, "schema" | "status" | "issuedAt" | "expiresAt">
  ) => Promise<unknown>
  refreshJournal: (
    request: Omit<JournalReadback, "schema" | "issuedAt" | "expiresAt" | "data">
  ) => Promise<unknown>
  azure: (args: readonly string[]) => Promise<unknown>
  trust: { [K in EvidenceKind | "intent"]: KeyPin }
  managedKey?: ManagedKey
  clock?: () => number
  attestationProcess?: (args: string[]) => string
}

function checkedPorts(ports: IssuerPorts) {
  requireProof(ports && typeof ports === "object")
  for (const port of [
    ports.issuer,
    ports.sandboxBundle,
    ports.claimIntent,
    ports.refreshJournal,
    ports.azure,
  ])
    requireProof(typeof port === "function")
  const trust: IssuerPorts["trust"] = {
    fleet: keyPinSchema.parse(ports.trust?.fleet),
    source: keyPinSchema.parse(ports.trust?.source),
    inventory: keyPinSchema.parse(ports.trust?.inventory),
    migration: keyPinSchema.parse(ports.trust?.migration),
    policy: keyPinSchema.parse(ports.trust?.policy),
    journal: keyPinSchema.parse(ports.trust?.journal),
    rollback: keyPinSchema.parse(ports.trust?.rollback),
    intent: keyPinSchema.parse(ports.trust?.intent),
  }
  for (const kind of [...evidenceKinds, "intent"] as const) {
    if (kind !== "intent") requireProof(typeof ports.readers?.[kind] === "function")
  }
  requireProof(new Set(Object.values(trust).map((pin) => pin.keyId)).size === 8)
  const fingerprints = Object.values(trust).map((pin) => keyFingerprint(pin, 2048))
  requireProof(new Set(fingerprints).size === 8)
  const signer = managedKeySchema.parse(ports.managedKey ?? managedKey)
  const signerFingerprint = keyFingerprint(signer, 3072)
  for (const pin of Object.values(trust)) requireProof(pin.keyId !== signer.keyId)
  requireProof(!fingerprints.includes(signerFingerprint))
  return { trust, signer }
}
function parseCredential(value: Awaited<ReturnType<IssuerPorts["issuer"]>>, when: number) {
  const identity = issuerIdentitySchema.parse(value.identity)
  verifyQualificationIssuerToken(value.token, value.jwks, identity, when)
  const claims = JSON.parse(Buffer.from(value.token.split(".")[1], "base64url").toString("utf8"))
  return { ...value, identity, expiresAt: Number(claims.exp) }
}

async function construct(ports: IssuerPorts, trust: IssuerPorts["trust"], clock: () => number) {
  const credential = parseCredential(await read(ports.issuer), clock())
  const owner = credential.identity.owner
  const fleet = evidence("fleet", await read(ports.readers.fleet), trust.fleet, owner, clock())
  const source = evidence("source", await read(ports.readers.source), trust.source, owner, clock())
  const inventory = evidence(
    "inventory",
    await read(ports.readers.inventory),
    trust.inventory,
    owner,
    clock()
  )
  const migration = evidence(
    "migration",
    await read(ports.readers.migration),
    trust.migration,
    owner,
    clock()
  )
  const policy = evidence("policy", await read(ports.readers.policy), trust.policy, owner, clock())
  const journal = evidence(
    "journal",
    await read(ports.readers.journal),
    trust.journal,
    owner,
    clock()
  )
  const rollback = evidence(
    "rollback",
    await read(ports.readers.rollback),
    trust.rollback,
    owner,
    clock()
  )
  const receipts = { fleet, source, inventory, migration, policy, journal, rollback }
  const bindingDigest = digest(canonicalJson(fleet.data))
  const epoch = journal.data.epoch
  for (const receipt of Object.values(receipts)) {
    const header = evidenceHeaderSchema.parse(JSON.parse(receipt.envelope.raw))
    requireProof(header.bindingDigest === bindingDigest && header.epoch === epoch)
  }
  requireProof(
    credential.identity.source === fleet.data.productRevision &&
      source.data.productRevision === fleet.data.productRevision &&
      source.data.engineRevision === fleet.data.engineRevision &&
      source.data.publication.sandboxDigest === fleet.data.sandboxDigest &&
      migration.data.checksum === fleet.data.migrationChecksum &&
      policy.data.digest === fleet.data.runtimePolicyDigest
  )
  requireProof(
    rollback.data.fleet.engineRevision === fleet.data.engineRevision &&
      rollback.data.fleet.migrationChecksum === fleet.data.migrationChecksum &&
      rollback.data.fleet.productRevision !== fleet.data.productRevision &&
      rollback.data.fleet.workerDigest !== fleet.data.workerDigest
  )
  const bundle = await read(ports.sandboxBundle)
  const provenance = verifySandboxAttestationBundle(bundle, source.data.publication, {
    when: clock() * 1000,
    ...(ports.attestationProcess ? { run: ports.attestationProcess } : {}),
  })
  requireProof(inventory.data.provenanceBundleDigest === "sha256:" + provenance.bundleChecksum)
  const evidenceDigests = Object.fromEntries(
    Object.entries(receipts).map(([kind, value]) => [kind, digest(canonicalJson(value.envelope))])
  )
  const when = clock()
  const candidate = candidateSchema.parse({
    schema: "lyrashield-closed-fleet-candidate/1",
    kind: "closed-fleet-candidate",
    productionQualification: false,
    issuer: credential.identity,
    fleet: fleet.data,
    source: source.data,
    inventory: inventory.data,
    journal: journal.data,
    rollback: rollback.data,
    evidence: evidenceDigests,
    nonce: randomUUID(),
    issuedAt: when,
    expiresAt: Math.min(
      when + 900,
      credential.expiresAt,
      ...Object.values(receipts).map((v) => v.expiresAt)
    ),
  })
  const raw = canonicalJson(candidate)
  requireProof(Buffer.byteLength(raw) <= 16384)
  return { candidate, raw, credential } as const
}

export function verifyClosedFleetSignature(
  raw: string,
  result: unknown,
  pin: KeyPin = managedKey,
  when = Math.floor(Date.now() / 1000)
): FleetCandidate {
  requireProof(typeof raw === "string" && Buffer.byteLength(raw) <= 16384)
  const candidate = candidateSchema.parse(JSON.parse(raw))
  requireProof(raw === canonicalJson(candidate))
  const signed = signatureResultSchema.parse(result)
  authenticate(
    { ...signed, raw },
    keyPinSchema.parse({ keyId: pin.keyId, publicKey: pin.publicKey }),
    3072
  )
  valid(candidate.issuedAt, candidate.expiresAt, when)
  requireProof(
    candidate.issuer.source === candidate.fleet.productRevision &&
      candidate.source.productRevision === candidate.fleet.productRevision &&
      candidate.source.engineRevision === candidate.fleet.engineRevision &&
      candidate.source.publication.sandboxDigest === candidate.fleet.sandboxDigest &&
      candidate.rollback.fleet.engineRevision === candidate.fleet.engineRevision &&
      candidate.rollback.fleet.migrationChecksum === candidate.fleet.migrationChecksum &&
      candidate.rollback.fleet.productRevision !== candidate.fleet.productRevision &&
      candidate.rollback.fleet.workerDigest !== candidate.fleet.workerDigest
  )
  return candidate
}

export function createClosedFleetIssuer(ports: IssuerPorts) {
  const { trust, signer } = checkedPorts(ports)
  const clock = ports.clock ?? (() => Math.floor(Date.now() / 1000))
  let attempted = false
  async function azure(args: string[]) {
    try {
      return await ports.azure(args)
    } catch {
      throw new Error("Closed managed signer operation failed")
    }
  }
  return Object.freeze({
    async issueCandidate() {
      requireProof(!attempted)
      attempted = true // One-shot after uncertainty; never retry an ambiguous intent.
      const prepared = await construct(ports, trust, clock)
      const { candidate, raw, credential } = prepared
      valid(candidate.issuedAt, candidate.expiresAt, clock())
      const intentEnvelope = authenticate(
        await read(() =>
          ports.claimIntent({
            owner: candidate.issuer.owner,
            epoch: candidate.journal.epoch,
            candidateDigest: digest(raw),
            nonce: candidate.nonce,
          })
        ),
        trust.intent
      )
      const intent = intentSchema.parse(JSON.parse(intentEnvelope.raw))
      requireProof(
        intentEnvelope.raw === canonicalJson(intent) &&
          intent.owner === candidate.issuer.owner &&
          intent.epoch === candidate.journal.epoch &&
          intent.candidateDigest === digest(raw) &&
          intent.nonce === candidate.nonce &&
          intent.expiresAt >= candidate.expiresAt
      )
      valid(intent.issuedAt, intent.expiresAt, clock())
      const refreshedEnvelope = authenticate(
        await read(() =>
          ports.refreshJournal({
            owner: candidate.issuer.owner,
            epoch: candidate.journal.epoch,
            candidateDigest: digest(raw),
            bindingDigest: digest(canonicalJson(candidate.fleet)),
            nonce: candidate.nonce,
          })
        ),
        trust.journal
      )
      const refreshed = journalReadbackSchema.parse(JSON.parse(refreshedEnvelope.raw))
      requireProof(
        refreshedEnvelope.raw === canonicalJson(refreshed) &&
          refreshed.owner === candidate.issuer.owner &&
          refreshed.epoch === candidate.journal.epoch &&
          refreshed.candidateDigest === digest(raw) &&
          refreshed.nonce === candidate.nonce &&
          refreshed.bindingDigest === digest(canonicalJson(candidate.fleet)) &&
          refreshed.issuedAt >= candidate.issuedAt &&
          refreshed.expiresAt >= candidate.expiresAt &&
          isDeepStrictEqual(refreshed.data, candidate.journal)
      )
      valid(refreshed.issuedAt, refreshed.expiresAt, clock())
      const refreshedCredential = parseCredential(await read(ports.issuer), clock())
      requireProof(isDeepStrictEqual(refreshedCredential.identity, credential.identity))
      const recheck = () => {
        const when = clock()
        valid(candidate.issuedAt, candidate.expiresAt, when)
        verifyQualificationIssuerToken(credential.token, credential.jwks, credential.identity, when)
      }
      recheck()
      let succeeded = false
      try {
        await azure([
          "login",
          "--service-principal",
          "--username",
          signer.clientId,
          "--tenant",
          signer.tenantId,
          "--federated-token",
          credential.token,
          "--allow-no-subscriptions",
        ])
        recheck()
        const result = await azure([
          "keyvault",
          "key",
          "sign",
          "--id",
          signer.keyId,
          "--algorithm",
          "RS256",
          "--digest",
          createHash("sha256").update(raw).digest("base64"),
        ])
        verifyClosedFleetSignature(raw, result, signer, clock())
        recheck()
        const signed = signatureResultSchema.parse(result)
        const immutableResult = Object.freeze({
          algorithm: signed.algorithm,
          keyId: signed.keyId,
          signature: signed.signature,
        })
        const signedCandidate = Object.freeze({
          raw,
          result: immutableResult,
          intentDigest: digest(canonicalJson(intentEnvelope)),
          signatureVerified: true,
          qualified: false,
        })
        succeeded = true
        return signedCandidate
      } finally {
        await azure(["logout"])
        if (succeeded) valid(candidate.issuedAt, candidate.expiresAt, clock())
      }
    },
  })
}

export function issueRuntimeFleetQualification(): never {
  throw new Error(
    "Production fleet issuance unavailable: authenticated inventory, journal, rollback and intent readers not wired"
  )
}
