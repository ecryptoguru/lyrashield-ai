/* eslint-disable security/detect-non-literal-fs-filename -- Fixed root installation paths, held descriptors, and no caller-selected key. */
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync } from "node:fs"
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"
import { dirname } from "node:path"
import { z } from "zod"
import {
  canonicalJson,
  sha256Hex,
  readInstalledJournalSealControlPolicy,
  executorResourceDescriptorSchema,
  type ExecutorResourceDescriptor,
} from "@lyrashield/runtime-control"
import {
  sandboxToolCapabilitySchema,
  createSandboxToolCapabilityVerifier,
  type SandboxToolCapability,
} from "./sandbox-tool-capability"

const KEY = "/opt/lyrashield/control/sandbox-grant-key.pem"
const AUTHORITY = "/etc/lyrashield/runtime-authority.json"
const ACCEPTANCE = "/etc/lyrashield/control/sandbox-tool-acceptance.json"
const PIN = "/opt/lyrashield/runtime-control/runtime-qualification-key.json"
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const id = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const capabilityNames = [
  "exec",
  "pty",
  "files",
  "ports",
  "network_policy",
  "mounts",
  "exec_constraints",
  "scoped_relay",
] as const
const capabilityEvidence = z
  .object({
    status: z.literal("supported"),
    detail: z.string().min(1).max(1024),
    evidence: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0),
  })
  .strict()
export const sandboxToolAcceptanceSchema = z
  .object({
    schema: z.literal("lyrashield-sandbox-tool-acceptance/1"),
    productRevision: z.string().regex(/^[a-f0-9]{40}$/),
    engineRevision: z.string().regex(/^[a-f0-9]{40}$/),
    sandboxDigest: digest,
    runtimePolicyDigest: digest,
    capabilities: z.record(z.enum(capabilityNames), capabilityEvidence),
  })
  .strict()
const authoritySchema = z
  .object({
    schema: z.literal("lyrashield-installed-runtime-authority/1"),
    purpose: z.literal("launch-qualified-controller"),
    productRevision: z.string().regex(/^[a-f0-9]{40}$/),
    engineRevision: z.string().regex(/^[a-f0-9]{40}$/),
    epochId: id,
    epoch: z.number().int().positive().safe(),
    issuedAt: z.number().int().nonnegative().safe(),
    sandboxDigest: digest,
    runtimePolicyDigest: digest,
    acceptanceDigest: digest,
    toolChannel: z
      .object({ schema: z.literal("lyrashield-sandbox-tool-channel/1"), origin: z.string().url() })
      .strict(),
    sandboxGrantSigner: z
      .object({
        schema: z.literal("lyrashield-sandbox-grant-signer/1"),
        purpose: z.literal("sandbox-tool-grants"),
        algorithm: z.literal("RS256"),
        keyId: id,
        epochId: id,
        epoch: z.number().int().positive().safe(),
        publicKey: z
          .object({ kty: z.literal("RSA"), n: z.string().min(1), e: z.literal("AQAB") })
          .strict(),
        publicKeySha256: digest,
      })
      .strict(),
  })
  .passthrough()
const envelopeSchema = z
  .object({
    raw: z.string(),
    result: z
      .object({
        algorithm: z.literal("RS256"),
        keyId: z.string().min(3).max(2048),
        signature: z.string(),
      })
      .strict(),
  })
  .strict()
function unavailable(): never {
  throw new Error("Root sandbox grant authority unavailable")
}

/** Reads one fixed root-owned inode; neither symlink nor writable ancestors are accepted. */
function heldBytes(path: string, maximum: number, publicFile = false): Buffer {
  if (process.getuid?.() !== 0 || process.platform !== "linux") unavailable()
  let ancestor = dirname(path)
  for (;;) {
    const info = lstatSync(ancestor)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      info.gid !== 0 ||
      (info.mode & 0o022) !== 0
    )
      unavailable()
    if (ancestor === "/") break
    ancestor = dirname(ancestor)
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (
      !before.isFile() ||
      before.uid !== 0 ||
      before.gid !== 0 ||
      before.nlink !== 1 ||
      (publicFile ? (before.mode & 0o222) !== 0 : (before.mode & 0o777) !== 0o400) ||
      before.size > maximum
    )
      unavailable()
    const bytes = readFileSync(fd)
    const after = fstatSync(fd),
      pathInfo = lstatSync(path)
    if (
      bytes.byteLength > maximum ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      pathInfo.dev !== before.dev ||
      pathInfo.ino !== before.ino ||
      pathInfo.isSymbolicLink()
    )
      unavailable()
    return bytes
  } finally {
    closeSync(fd)
  }
}

const disposableFiles = {
  authority: "/opt/lyrashield/control/disposable-native-authority.json",
  pin: "/opt/lyrashield/control/disposable-native-pin.json",
  context: "/opt/lyrashield/control/disposable-native-context.json",
  policy: "/opt/lyrashield/control/disposable-runtime-policy.json",
  key: "/opt/lyrashield/control/disposable-sandbox-grant-key.pem",
} as const

/** Separate fixed finite-fixture installation; no request can select a path. */
export function readHeldDisposableSandboxGrantFile(kind: keyof typeof disposableFiles): Buffer {
  return heldBytes(disposableFiles[kind], kind === "policy" ? 65536 : 16384)
}

export function hasInstalledProductionSandboxAuthority(): boolean {
  if (process.getuid?.() !== 0 || process.platform !== "linux") unavailable()
  try {
    lstatSync(AUTHORITY)
    return true
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false
    return unavailable()
  }
}

/** Cryptographic composition shared by the fixed reader and real RSA regression fixtures. */
export function verifyRootSandboxGrantDelegation(input: {
  pin: unknown
  envelope: unknown
  privateKey: Uint8Array
  source: string
}) {
  const pin = z
    .object({
      algorithm: z.literal("RS256"),
      keyId: z.string().min(3).max(2048),
      publicKey: z
        .object({
          kty: z.literal("RSA"),
          n: z.string().regex(/^[A-Za-z0-9_-]+$/),
          e: z.literal("AQAB"),
        })
        .strict(),
    })
    .passthrough()
    .parse(input.pin)
  const envelope = envelopeSchema.parse(input.envelope),
    root = createPublicKey({ key: pin.publicKey, format: "jwk" })
  const signature = Buffer.from(envelope.result.signature, "base64")
  if (
    root.asymmetricKeyType !== "rsa" ||
    (root.asymmetricKeyDetails?.modulusLength ?? 0) < 3072 ||
    envelope.result.keyId !== pin.keyId ||
    signature.toString("base64") !== envelope.result.signature ||
    !verify("RSA-SHA256", Buffer.from(envelope.raw), root, signature)
  )
    unavailable()
  const authority = authoritySchema.parse(JSON.parse(envelope.raw)),
    key = createPrivateKey(Buffer.from(input.privateKey))
  const publicDer = createPublicKey(key).export({ format: "der", type: "spki" }),
    delegatedDer = createPublicKey({
      key: authority.sandboxGrantSigner.publicKey,
      format: "jwk",
    }).export({ format: "der", type: "spki" })
  if (
    canonicalJson(JSON.parse(envelope.raw)) !== envelope.raw ||
    authority.productRevision !== input.source ||
    authority.issuedAt > Math.floor(Date.now() / 1000) ||
    authority.sandboxGrantSigner.epochId !== authority.epochId ||
    authority.sandboxGrantSigner.epoch !== authority.epoch ||
    authority.sandboxGrantSigner.keyId === pin.keyId ||
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072 ||
    !publicDer.equals(delegatedDer) ||
    publicDer.equals(root.export({ format: "der", type: "spki" })) ||
    `sha256:${createHash("sha256").update(publicDer).digest("hex")}` !==
      authority.sandboxGrantSigner.publicKeySha256
  )
    unavailable()
  return { authority, key, envelope }
}

export class RootSandboxGrantSigner {
  private constructor(
    private readonly key: KeyObject,
    readonly runtimeAuthority: z.infer<typeof envelopeSchema>,
    private readonly authority: z.infer<typeof authoritySchema>,
    private readonly acceptance: z.infer<typeof sandboxToolAcceptanceSchema>
  ) {}

  /** The existing native observer verifies the installed root signature, source and policy first. */
  static load(source: string): RootSandboxGrantSigner {
    const policy = readInstalledJournalSealControlPolicy(source)
    const bytes = heldBytes(AUTHORITY, 128 * 1024)
    if (`sha256:${sha256Hex(bytes.toString("utf8"))}` !== policy.authorityDigest) unavailable()
    const { envelope, authority, key } = verifyRootSandboxGrantDelegation({
      pin: JSON.parse(heldBytes(PIN, 8192, true).toString("utf8")),
      envelope: JSON.parse(bytes.toString("utf8")),
      privateKey: heldBytes(KEY, 8192),
      source,
    })
    if (
      canonicalJson(JSON.parse(envelope.raw)) !== envelope.raw ||
      authority.productRevision !== source ||
      authority.epochId !== policy.epochId ||
      authority.epoch !== policy.epoch ||
      authority.runtimePolicyDigest !== policy.runtimePolicyDigest
    )
      unavailable()
    const origin = new URL(authority.toolChannel.origin)
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.origin !== authority.toolChannel.origin
    )
      unavailable()
    const acceptanceBytes = heldBytes(ACCEPTANCE, 64 * 1024)
    if (`sha256:${sha256Hex(acceptanceBytes.toString("utf8"))}` !== authority.acceptanceDigest)
      unavailable()
    const acceptance = sandboxToolAcceptanceSchema.parse(
      JSON.parse(acceptanceBytes.toString("utf8"))
    )
    if (
      canonicalJson(acceptance) !== acceptanceBytes.toString("utf8") ||
      acceptance.productRevision !== source ||
      acceptance.engineRevision !== authority.engineRevision ||
      acceptance.sandboxDigest !== authority.sandboxDigest ||
      acceptance.runtimePolicyDigest !== authority.runtimePolicyDigest ||
      authority.sandboxGrantSigner.epochId !== authority.epochId ||
      authority.sandboxGrantSigner.epoch !== authority.epoch
    )
      unavailable()
    return new RootSandboxGrantSigner(key, envelope, authority, acceptance)
  }

  /** Native composition supplies only independently authenticated ownership and the exact staged SDK manifest. */
  issue(input: {
    scope: SandboxToolCapability
    descriptor: ExecutorResourceDescriptor
    manifestInputJson: string
    exposedPorts: number[]
    deadlineAt: Date
  }) {
    if (process.getuid?.() !== 0) unavailable()
    const current = RootSandboxGrantSigner.load(this.authority.productRevision)
    if (
      canonicalJson(current.runtimeAuthority) !== canonicalJson(this.runtimeAuthority) ||
      canonicalJson(current.acceptance) !== canonicalJson(this.acceptance)
    )
      unavailable()
    const scope = sandboxToolCapabilitySchema.parse(input.scope),
      descriptor = executorResourceDescriptorSchema.parse(input.descriptor)
    const now = Date.now(),
      issued = Date.parse(scope.issuedAt),
      expires = Date.parse(scope.expiresAt)
    const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(input.manifestInputJson))
    const environment = z
      .object({ value: z.record(z.string(), z.string()) })
      .passthrough()
      .parse(manifest.environment)
    if (
      canonicalJson(manifest) !== input.manifestInputJson ||
      manifest.root !== descriptor.workspaceRoot ||
      environment.value.STRIX_RUN_ID !== scope.scanId ||
      scope.authorityEpochId !== this.authority.epochId ||
      descriptor.imageDigest !== this.authority.sandboxDigest ||
      `sha256:${descriptor.hostPolicyChecksum}` !== this.authority.runtimePolicyDigest ||
      issued > now ||
      expires <= now ||
      expires <= issued ||
      expires - issued > 45 * 60_000 ||
      expires > input.deadlineAt.getTime() ||
      Math.floor(issued / 1000) < this.authority.issuedAt
    )
      unavailable()
    const ports = z.array(z.number().int().min(1).max(65535)).max(16).parse(input.exposedPorts)
    if (new Set(ports).size !== ports.length) unavailable()
    const required = [
      ...capabilityNames.filter((name) => name !== "scoped_relay"),
      ...(descriptor.egress.relayRequired ? ["scoped_relay" as const] : []),
    ]
    for (const name of required) if (!this.acceptance.capabilities[name]) unavailable()
    const header = Buffer.from(
      canonicalJson({ alg: "RS256", kid: this.authority.sandboxGrantSigner.keyId, typ: "JWT" })
    ).toString("base64url")
    const payload = Buffer.from(canonicalJson(scope)).toString("base64url")
    const signingInput = `${header}.${payload}`,
      token = `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), this.key).toString("base64url")}`
    createSandboxToolCapabilityVerifier({
      publicKeyPem: createPublicKey(this.key).export({ format: "pem", type: "spki" }).toString(),
      keyId: this.authority.sandboxGrantSigner.keyId,
      authorityEpochId: this.authority.epochId,
    })(token, scope)
    const raw = canonicalJson({
      schema: "lyrashield-runtime-sandbox-grant/v1",
      installed: true,
      attemptId: scope.attemptId,
      operationId: scope.operationId,
      authorityEpochId: scope.authorityEpochId,
      sandboxHandle: scope.sandboxHandle,
      scanId: scope.scanId,
      issuedAt: Math.floor(issued / 1000),
      expiresAt: Math.floor(Math.min(expires, issued + 900_000) / 1000),
      manifestChecksum: sha256Hex(input.manifestInputJson),
      policyChecksum: descriptor.hostPolicyChecksum,
      imageDigest: descriptor.imageDigest,
      workspaceRoot: descriptor.workspaceRoot,
      relayRequired: descriptor.egress.relayRequired,
      authorizedHosts: descriptor.egress.authorizedHosts,
      exposedPorts: ports,
      capabilities: this.acceptance.capabilities,
      source: descriptor.source,
    })
    return {
      grant: {
        raw,
        result: {
          algorithm: "RS256" as const,
          keyId: this.authority.sandboxGrantSigner.keyId,
          signature: sign("RSA-SHA256", Buffer.from(raw), this.key).toString("base64"),
        },
      },
      runtimeAuthority: this.runtimeAuthority,
      ownership: scope.ownership,
      env: {
        LYRASHIELD_SUPERVISOR_TOOL_URL: this.authority.toolChannel.origin,
        LYRASHIELD_SUPERVISOR_TOOL_TOKEN: token,
        LYRASHIELD_SUPERVISOR_ATTEMPT_ID: scope.attemptId,
        LYRASHIELD_SUPERVISOR_OPERATION_ID: scope.operationId,
        LYRASHIELD_SUPERVISOR_AUTHORITY_EPOCH_ID: scope.authorityEpochId,
        LYRASHIELD_SUPERVISOR_SANDBOX_HANDLE: scope.sandboxHandle,
        LYRASHIELD_SUPERVISOR_RUNTIME_AUTHORITY: canonicalJson(this.runtimeAuthority),
        LYRASHIELD_SUPERVISOR_MANIFEST_INPUT: input.manifestInputJson,
      },
    }
  }
}
