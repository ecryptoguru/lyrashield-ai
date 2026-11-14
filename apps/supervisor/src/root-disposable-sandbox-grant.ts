import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
import { readFileSync } from "node:fs"
import { z } from "zod"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import {
  sandboxToolCapabilitySchema,
  createSandboxToolCapabilityVerifier,
} from "./sandbox-tool-capability"
import {
  confirmNativeSandboxGrantAuthority,
  type NativeSandboxGrantInput,
} from "./root-sandbox-grant-native"
import {
  hasInstalledProductionSandboxAuthority,
  readHeldDisposableSandboxGrantFile,
} from "./root-sandbox-grant"

const purpose = "disposable-linux-native-tests"
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const source = z.string().regex(/^[a-f0-9]{40}$/)
const owner = z.string().regex(/^[1-9][0-9]*:[1-9][0-9]*$/)
const boot = z.string().regex(/^[a-f0-9-]{36}$/)
const id = z.string().regex(/^disposable-[A-Za-z0-9_-]+$/)
const publicKeySchema = z
  .object({ kty: z.literal("RSA"), n: z.string().regex(/^[A-Za-z0-9_-]+$/), e: z.literal("AQAB") })
  .strict()
const contextSchema = z
  .object({
    schema: z.literal("lyrashield-disposable-native-context/1"),
    owner,
    bootId: boot,
    nonce: hash,
    sourceRevision: source,
    sourceTree: source,
  })
  .strict()
const authoritySchema = z
  .object({
    schema: z.literal("lyrashield-disposable-native-authority/1"),
    purpose: z.literal(purpose),
    epochId: z.string().regex(/^disposable-[a-f0-9]{32}$/),
    epoch: z.number().int().positive().safe(),
    owner,
    bootId: boot,
    nonce: hash,
    sourceTree: source,
    issuedAt: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
    productRevision: source,
    engineRevision: source,
    workerDigest: digest,
    sandboxDigest: digest,
    brokerDigest: digest,
    supervisorDigest: digest,
    providerGatewayDigest: digest,
    migrationChecksum: digest,
    runtimePolicyDigest: digest,
    dependencies: z
      .object({
        database: z.object({ name: z.string(), image: z.string() }).strict(),
        redis: z.object({ name: z.string(), image: z.string() }).strict(),
        provider: z.object({ name: z.string(), image: z.string() }).strict(),
      })
      .strict(),
  })
  .strict()
function unavailable(): never {
  throw new Error("Disposable sandbox grant authority unavailable")
}

/** A separate typed fixture proof. Production installation and the engine promotion parser deny it. */
export function loadDisposableSandboxGrantSigningKey(productRevision: string) {
  if (hasInstalledProductionSandboxAuthority()) unavailable()
  const context = contextSchema.parse(
    JSON.parse(readHeldDisposableSandboxGrantFile("context").toString("utf8"))
  )
  const pin = z
    .object({
      purpose: z.literal(purpose),
      algorithm: z.literal("RS256"),
      keyId: id,
      publicKey: publicKeySchema,
    })
    .strict()
    .parse(JSON.parse(readHeldDisposableSandboxGrantFile("pin").toString("utf8")))
  const envelope = z
    .object({
      raw: z.string(),
      result: z
        .object({ algorithm: z.literal("RS256"), keyId: id, signature: z.string() })
        .strict(),
    })
    .strict()
    .parse(JSON.parse(readHeldDisposableSandboxGrantFile("authority").toString("utf8")))
  const authority = authoritySchema.parse(JSON.parse(envelope.raw)),
    publicKey = createPublicKey({ key: pin.publicKey, format: "jwk" })
  const key = createPrivateKey(readHeldDisposableSandboxGrantFile("key")),
    signature = Buffer.from(envelope.result.signature, "base64")
  const expectedDer = publicKey.export({ format: "der", type: "spki" }),
    actualDer = createPublicKey(key).export({ format: "der", type: "spki" })
  const now = Math.floor(Date.now() / 1000)
  if (
    canonicalJson(authority) !== envelope.raw ||
    envelope.result.keyId !== pin.keyId ||
    signature.toString("base64") !== envelope.result.signature ||
    signature.length !== 384 ||
    !verify("RSA-SHA256", Buffer.from(envelope.raw), publicKey, signature) ||
    key.asymmetricKeyType !== "rsa" ||
    key.asymmetricKeyDetails?.modulusLength !== 3072 ||
    !actualDer.equals(expectedDer) ||
    authority.productRevision !== productRevision ||
    context.sourceRevision !== productRevision ||
    authority.owner !== context.owner ||
    authority.nonce !== context.nonce ||
    authority.sourceTree !== context.sourceTree ||
    authority.bootId !== context.bootId ||
    authority.bootId !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() ||
    authority.issuedAt > now ||
    authority.expiresAt <= now ||
    authority.expiresAt <= authority.issuedAt ||
    authority.expiresAt - authority.issuedAt > 3600
  )
    unavailable()
  const policyBytes = readHeldDisposableSandboxGrantFile("policy")
  if (
    `sha256:${createHash("sha256").update(policyBytes).digest("hex")}` !==
    authority.runtimePolicyDigest
  )
    unavailable()
  const policy = z
    .object({
      components: z
        .object({
          supervisor: z.object({ environment: z.record(z.string(), z.string()) }).passthrough(),
        })
        .passthrough(),
    })
    .passthrough()
    .parse(JSON.parse(policyBytes.toString("utf8")))
  const toolUrl = policy.components.supervisor.environment.TOOL_URL
  if (!toolUrl) unavailable()
  const url = new URL(toolUrl)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "lyrashield-supervisor" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.origin !== toolUrl
  )
    unavailable()
  return { key, pin, authority, envelope, toolUrl }
}

/** Actual native source/START verification is shared; only the signed result's purpose differs. */
export async function issueNativeDisposableSandboxGrant(input: NativeSandboxGrantInput) {
  const confirmed = await confirmNativeSandboxGrantAuthority(input)
  const installed = loadDisposableSandboxGrantSigningKey(input.productRevision)
  const scope = sandboxToolCapabilitySchema.parse({
    ...confirmed.signingInput.scope,
    expiresAt: new Date(
      Math.min(confirmed.signingInput.deadlineAt.getTime(), installed.authority.expiresAt * 1000)
    ).toISOString(),
  })
  if (
    scope.authorityEpochId !== installed.authority.epochId ||
    Date.parse(scope.expiresAt) <= Date.now()
  )
    unavailable()
  const header = Buffer.from(
      canonicalJson({ alg: "RS256", kid: installed.pin.keyId, typ: "JWT" })
    ).toString("base64url"),
    payload = Buffer.from(canonicalJson(scope)).toString("base64url")
  const signingInput = `${header}.${payload}`,
    token = `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), installed.key).toString("base64url")}`
  createSandboxToolCapabilityVerifier({
    publicKeyPem: createPublicKey(installed.key).export({ format: "pem", type: "spki" }).toString(),
    keyId: installed.pin.keyId,
    authorityEpochId: scope.authorityEpochId,
  })(token, scope)
  const raw = canonicalJson({
    schema: "lyrashield-disposable-sandbox-grant/1",
    purpose,
    installed: false,
    owner: installed.authority.owner,
    bootId: installed.authority.bootId,
    nonce: installed.authority.nonce,
    authorityEpochId: scope.authorityEpochId,
    operationId: scope.operationId,
    attemptId: scope.attemptId,
    scanId: scope.scanId,
    sandboxHandle: scope.sandboxHandle,
    imageDigest: confirmed.signingInput.descriptor.imageDigest,
    policyChecksum: confirmed.signingInput.descriptor.hostPolicyChecksum,
    manifestChecksum: sha256Hex(input.manifestInputJson),
    issuedAt: Math.floor(Date.parse(scope.issuedAt) / 1000),
    expiresAt: Math.floor(
      Math.min(Date.parse(scope.expiresAt), Date.parse(scope.issuedAt) + 900000) / 1000
    ),
  })
  confirmed.assertCurrent()
  return {
    grant: {
      raw,
      result: {
        algorithm: "RS256" as const,
        keyId: installed.pin.keyId,
        signature: sign("RSA-SHA256", Buffer.from(raw), installed.key).toString("base64"),
      },
    },
    runtimeAuthority: installed.envelope,
    ownership: scope.ownership,
    env: {
      LYRASHIELD_SUPERVISOR_TOOL_URL: installed.toolUrl,
      LYRASHIELD_SUPERVISOR_TOOL_TOKEN: token,
      LYRASHIELD_SUPERVISOR_ATTEMPT_ID: scope.attemptId,
      LYRASHIELD_SUPERVISOR_OPERATION_ID: scope.operationId,
      LYRASHIELD_SUPERVISOR_AUTHORITY_EPOCH_ID: scope.authorityEpochId,
      LYRASHIELD_SUPERVISOR_SANDBOX_HANDLE: scope.sandboxHandle,
      LYRASHIELD_SUPERVISOR_RUNTIME_AUTHORITY: canonicalJson(installed.envelope),
      LYRASHIELD_SUPERVISOR_MANIFEST_INPUT: input.manifestInputJson,
    },
  }
}
