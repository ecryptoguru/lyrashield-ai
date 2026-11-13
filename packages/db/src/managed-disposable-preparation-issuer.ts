import { createHash, createPublicKey } from "node:crypto"
import { readFileSync } from "node:fs"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import type { ScanPreparationCommandAuthority } from "./scan-dispatch-command-descriptor"
import {
  buildPreparationStagingRecord,
  preparationProofFailure,
  trustedPreparationHostPolicySchema,
  verifyPreparationStagingRecord,
} from "./trusted-preparation-proof"
// @ts-expect-error -- shared descriptor-safe release reader is JavaScript without a declaration file
import { readPrivateRecord } from "../../../.github/scripts/private-record.mjs"

const pin = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed source-owned managed public key, never a caller-selected key
  readFileSync(
    new URL("../../security/src/runtime-qualification-key.json", import.meta.url),
    "utf8"
  )
)
const publicKey = createPublicKey({ key: pin.publicKey, format: "jwk" })
const pem = publicKey.export({ type: "spki", format: "pem" }).toString()
const keyHash = createHash("sha256")
  .update(publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")
import {
  observeDisposableExecutionContext,
  inspectDisposablePreparationImage,
  readDisposableSourceReceipt,
  disposableObservationCommand,
  type DisposablePreparationFixture,
} from "./disposable-preparation-observations"
export { observeDisposableExecutionContext } from "./disposable-preparation-observations"
export type { DisposablePreparationFixture } from "./disposable-preparation-observations"

type IssuerOptions = {
  hostPolicy: unknown
  fixture: DisposablePreparationFixture
  sourceHostPath: string
  egressDirectory: string
  egressFile: string
}
class ManagedDisposablePreparationIssuer {
  private readonly policy
  private readonly fixture
  private readonly installed
  private signingAttempted = false
  private retained: { raw: string; result: unknown } | undefined
  constructor(options: IssuerOptions) {
    this.policy = trustedPreparationHostPolicySchema.parse(options.hostPolicy)
    this.fixture = Object.freeze({ ...options.fixture })
    this.installed = Object.freeze({
      sourceHostPath: options.sourceHostPath,
      egressDirectory: options.egressDirectory,
      egressFile: options.egressFile,
    })
    if (
      this.policy.issuerKeyId !== pin.keyId ||
      this.policy.issuerKeyHash !== keyHash ||
      this.policy.provider.providerId !== "test-provider" ||
      process.env.GITHUB_ACTIONS
    )
      preparationProofFailure()
  }
  private read(authority: ScanPreparationCommandAuthority) {
    if (
      authority.target.type !== "REPO" ||
      authority.attachments.length ||
      !authority.executionPlan.source?.revision
    )
      preparationProofFailure()
    const context = observeDisposableExecutionContext(this.fixture)
    if (canonicalJson(context.context) !== canonicalJson(this.policy.executionContext))
      preparationProofFailure()
    const source = readDisposableSourceReceipt(
      this.installed.sourceHostPath,
      authority.executionPlan.source.revision
    )
    const egressRaw = readPrivateRecord(
      this.installed.egressDirectory,
      this.installed.egressFile,
      65536
    )
    const egress = JSON.parse(egressRaw)
    if (
      canonicalJson(egress) !== egressRaw ||
      !Array.isArray(egress.authorizedHosts) ||
      egress.authorizedHosts.length ||
      egress.relayRequired !== false ||
      sha256Hex(egressRaw) !== this.policy.isolation.networkPolicyChecksum
    )
      preparationProofFailure()
    const inventory = {
      engine: inspectDisposablePreparationImage(
        this.policy.engineImage,
        [],
        this.policy.productRevision,
        "https://github.com/ecryptoguru/lyrashield-ai"
      ),
      sandbox: inspectDisposablePreparationImage(
        this.policy.sandboxImage,
        ["docker-entrypoint.sh"],
        this.policy.engineRevision,
        "https://github.com/ecryptoguru/lyrashield-engine"
      ),
    }
    return { context, source, egressRaw, inventory }
  }
  private build(
    authority: ScanPreparationCommandAuthority,
    before: ReturnType<ManagedDisposablePreparationIssuer["read"]>
  ) {
    const resources = {
      source: {
        grantId: "source:" + sha256Hex(authority.attempt.operationId).slice(0, 40),
        root: "/workspace/source" as const,
        revision: before.source.revision,
        stagedTreeDigest: before.source.stagedTreeDigest,
        readOnly: true as const,
      },
      attachments: null,
      relay: null,
      egress: {
        grantId: "egress:" + sha256Hex(authority.attempt.operationId).slice(0, 40),
        policyPath: "/run/lyrashield-egress/policy.json" as const,
        policyChecksum: sha256Hex(before.egressRaw),
        authorizedHosts: [],
        relayRequired: false,
        readOnly: true as const,
      },
    }
    const observed = {
      inventoryReceiptChecksum: sha256Hex(canonicalJson(before.inventory)),
      runtimeReceiptChecksum: sha256Hex(canonicalJson(before.context.evidence.evidence)),
      inputReceiptChecksum: sha256Hex(
        canonicalJson({ source: before.source, egressRaw: before.egressRaw })
      ),
      engineEntrypoint: [] as [],
      sandboxEntrypoint: ["docker-entrypoint.sh"] as ["docker-entrypoint.sh"],
    }
    return buildPreparationStagingRecord(
      authority,
      this.policy,
      resources,
      observed,
      before.context.context
    )
  }
  async readStagingRecord(authority: ScanPreparationCommandAuthority) {
    const before = this.read(authority)
    if (this.retained) {
      const previous = JSON.parse(this.retained.raw)
      if (
        previous.resources.source.stagedTreeDigest !== before.source.stagedTreeDigest ||
        previous.resources.egress.policyChecksum !== sha256Hex(before.egressRaw) ||
        previous.observed.inventoryReceiptChecksum !== sha256Hex(canonicalJson(before.inventory)) ||
        previous.observed.runtimeReceiptChecksum !==
          sha256Hex(canonicalJson(before.context.evidence.evidence))
      )
        preparationProofFailure()
      verifyPreparationStagingRecord(
        this.retained,
        authority,
        this.policy,
        pem,
        before.context.context
      )
      return this.retained
    }
    if (this.signingAttempted) preparationProofFailure()
    const identity = JSON.parse(
      disposableObservationCommand("az", [
        "account",
        "show",
        "--only-show-errors",
        "--output",
        "json",
      ])
    )
    if (
      identity.tenantId !== "06f052f9-f03f-46c4-8e81-4c3d46871e8b" ||
      identity.user?.type !== "user"
    )
      preparationProofFailure()
    const record = this.build(authority, before)
    const raw = canonicalJson(record)
    this.signingAttempted = true
    const result = JSON.parse(
      disposableObservationCommand("az", [
        "keyvault",
        "key",
        "sign",
        "--id",
        pin.keyId,
        "--algorithm",
        "RS256",
        "--digest",
        createHash("sha256").update(raw).digest("base64"),
        "--only-show-errors",
        "--output",
        "json",
      ])
    )
    const after = this.read(authority)
    if (
      canonicalJson({
        ...after,
        context: { context: after.context.context, evidence: after.context.evidence.evidence },
      }) !==
      canonicalJson({
        ...before,
        context: { context: before.context.context, evidence: before.context.evidence.evidence },
      })
    )
      preparationProofFailure()
    const envelope = { raw, result }
    verifyPreparationStagingRecord(envelope, authority, this.policy, pem, after.context.context)
    this.retained = Object.freeze({ raw, result: Object.freeze(result) })
    return this.retained
  }
  async readExecutionContext() {
    return observeDisposableExecutionContext(this.fixture).context
  }
}
/** One founder-authenticated disposable proof; no host signing role or production qualification. */
export function createManagedDisposablePreparationIssuer(options: IssuerOptions) {
  const issuer = new ManagedDisposablePreparationIssuer(options)
  return Object.freeze({
    readStagingRecord: issuer.readStagingRecord.bind(issuer),
    readExecutionContext: issuer.readExecutionContext.bind(issuer),
    issuerPublicKey: pem,
  })
}
