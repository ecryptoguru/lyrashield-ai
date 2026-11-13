// Managed-sign only an internally constructed held record from real verification.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { readQualificationIssuerToken } from "./paired-runtime-github.mjs"
import { verifyFreshSandboxPublication } from "./verify-sandbox-publication.mjs"
import { verifySandboxCoveragePublication } from "./runtime-qualification-foundation.mjs"
import {
  runtimeQualificationKeyId,
  validateHeldSandboxPublicationRecord,
  verifyRuntimeQualificationSignature,
} from "../../packages/security/src/sandbox-publication-record.ts"

const configuration = JSON.parse(
  // Fixed source-controlled identity configuration, never a workflow input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(new URL("../qualification-issuer-key.json", import.meta.url), "utf8")
)
assert.equal(configuration.keyId, runtimeQualificationKeyId)

function azure(args) {
  try {
    const bytes = execFileSync("az", [...args, "--only-show-errors", "--output", "json"], {
      timeout: 30000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return bytes.length ? JSON.parse(bytes) : null
  } catch {
    throw new Error("Protected sandbox publication signing failed")
  }
}

export async function issueHeldSandboxPublication(
  raw,
  {
    readIdentity = readQualificationIssuerToken,
    verifyPublication = verifySandboxCoveragePublication,
    run = azure,
    verifySignature = verifyRuntimeQualificationSignature,
    when = Date.now(),
  } = {}
) {
  assert.equal(typeof raw, "string")
  assert.ok(Buffer.byteLength(raw) > 0 && Buffer.byteLength(raw) <= 4096)
  const authenticated = await readIdentity()
  const verified = await verifyFreshSandboxPublication(raw, {
    readIdentity: async () => authenticated,
    verify: verifyPublication,
  })
  assert.equal(verified.qualified, false)
  assert.equal(verified.nativeInventoryRechecked, false)
  assert.equal(verified.signedBoundedCoverageVerified, true)
  const { token, identity } = authenticated
  const record = {
    schema: "lyrashield-held-sandbox-publication/1",
    purpose: "publication-evidence-only",
    qualified: false,
    nativeInventoryRechecked: false,
    runtimeAuthorityVerified: false,
    signedBoundedCoverageVerified: true,
    coveragePredicateChecksum: verified.coveragePredicateChecksum,
    publication: {
      sandboxDigest: verified.sandboxDigest,
      engineRevision: verified.engineRevision,
      publicationRevision: verified.publicationRevision,
      publishRunId: verified.publishRunId,
      publishAttempt: verified.publishAttempt,
    },
    nativeManifests: { ...verified.nativeManifests },
    issuer: { owner: identity.owner, source: identity.source },
    issuedAt: new Date(when).toISOString(),
    expiresAt: new Date(when + 24 * 60 * 60 * 1000).toISOString(),
  }
  validateHeldSandboxPublicationRecord(
    record,
    {
      sandboxImage: "ghcr.io/ecryptoguru/lyrashield-sandbox@" + verified.sandboxDigest,
      engineRevision: verified.engineRevision,
    },
    when
  )
  const bytes = JSON.stringify(record)
  try {
    run([
      "login",
      "--service-principal",
      "--username",
      configuration.clientId,
      "--tenant",
      configuration.tenantId,
      "--federated-token",
      token,
      "--allow-no-subscriptions",
    ])
    const result = run([
      "keyvault",
      "key",
      "sign",
      "--id",
      runtimeQualificationKeyId,
      "--algorithm",
      "RS256",
      "--digest",
      createHash("sha256").update(bytes).digest("base64"),
    ])
    verifySignature(bytes, result)
    return Object.freeze({ raw: bytes, result })
  } finally {
    run(["logout"])
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const envelope = await issueHeldSandboxPublication(process.env.FRESH_SANDBOX_PUBLICATION)
    writeFileSync("sandbox-publication-record.json", JSON.stringify(envelope) + "\n", {
      mode: 0o600,
      flag: "wx",
    })
    process.stdout.write(
      "Managed-signed sandbox publication record; native inventory and authority remain held.\n"
    )
  } catch {
    process.stderr.write("Protected sandbox publication issuance failed.\n")
    process.exitCode = 1
  }
}
