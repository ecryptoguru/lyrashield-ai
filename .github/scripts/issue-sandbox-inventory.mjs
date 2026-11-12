// Signs only authenticated, bounded inventory evidence; never runtime authority.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { readQualificationIssuerToken } from "./paired-runtime-github.mjs"
import { verifyIndependentSandboxInventory } from "./independent-sandbox-inventory.mjs"
import {
  runtimeQualificationKeyId,
  verifyRuntimeQualificationSignature,
} from "../../packages/security/src/sandbox-publication-record.ts"

const configuration = JSON.parse(
  // Fixed source-controlled configuration; never a workflow input.
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
    throw new Error("Protected inventory signing failed")
  }
}
export async function issueHeldInventoryEvidence(
  raw,
  {
    readIdentity = readQualificationIssuerToken,
    verifyInventory = verifyIndependentSandboxInventory,
    run = azure,
    verifySignature = verifyRuntimeQualificationSignature,
    when = Date.now(),
  } = {}
) {
  assert.equal(typeof raw, "string")
  assert.ok(Buffer.byteLength(raw) > 0 && Buffer.byteLength(raw) <= 4096)
  const selector = JSON.parse(raw)
  const authenticated = await readIdentity()
  const verified = await verifyInventory(selector)
  assert.equal(verified.qualified, false)
  assert.equal(verified.nativeInventoryRechecked, true)
  assert.equal(verified.runtimeAuthorityVerified, false)
  for (const [key, value] of Object.entries(selector)) assert.equal(verified[key], value)
  for (const key of ["coveragePredicateChecksum", "inventoryPredicateChecksum"])
    assert.match(verified[key], /^[a-f0-9]{64}$/)
  for (const arch of ["amd64", "arm64"])
    assert.match(verified.nativeManifests?.[arch], /^sha256:[a-f0-9]{64}$/)
  assert.notEqual(verified.nativeManifests.amd64, verified.nativeManifests.arm64)
  assert.ok(Number.isSafeInteger(when) && when > 0)
  assert.match(authenticated.identity.owner, /^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/)
  assert.match(authenticated.identity.source, /^[a-f0-9]{40}$/)
  const record = {
    schema: "lyrashield-held-sandbox-inventory/1",
    purpose: "bounded-inventory-evidence-only",
    qualified: false,
    nativeInventoryRechecked: true,
    runtimeAuthorityVerified: false,
    coveragePredicateChecksum: verified.coveragePredicateChecksum,
    inventoryPredicateChecksum: verified.inventoryPredicateChecksum,
    publication: Object.fromEntries(
      [
        "sandboxDigest",
        "engineRevision",
        "publicationRevision",
        "publishRunId",
        "publishAttempt",
      ].map((key) => [key, verified[key]])
    ),
    verifier: Object.fromEntries(
      ["verifierRevision", "verifierRunId", "verifierAttempt"].map((key) => [key, verified[key]])
    ),
    nativeManifests: { ...verified.nativeManifests },
    issuer: { owner: authenticated.identity.owner, source: authenticated.identity.source },
    issuedAt: new Date(when).toISOString(),
    expiresAt: new Date(when + 24 * 60 * 60 * 1000).toISOString(),
  }
  const bytes = JSON.stringify(record)
  assert.ok(Buffer.byteLength(bytes) <= 4096)
  try {
    run([
      "login",
      "--service-principal",
      "--username",
      configuration.clientId,
      "--tenant",
      configuration.tenantId,
      "--federated-token",
      authenticated.token,
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
    const envelope = await issueHeldInventoryEvidence(process.env.FRESH_SANDBOX_INVENTORY)
    writeFileSync("sandbox-inventory-record.json", JSON.stringify(envelope) + "\n", {
      mode: 0o600,
      flag: "wx",
    })
    process.stdout.write(
      "Managed-signed bounded inventory evidence; runtime authority remains held.\n"
    )
  } catch {
    process.stderr.write("Protected sandbox inventory issuance failed.\n")
    process.exitCode = 1
  }
}
