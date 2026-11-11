// Exercises the protected signing boundary without issuing runtime authority.
import assert from "node:assert/strict"
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { readQualificationIssuerToken } from "./paired-runtime-github.mjs"

const configuration = JSON.parse(
  // Fixed source-controlled public-key path, never supplied by a caller.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(new URL("../qualification-issuer-key.json", import.meta.url), "utf8")
)
const keyId = configuration.keyId

function azure(args) {
  try {
    const output = execFileSync("az", [...args, "--only-show-errors", "--output", "json"], {
      timeout: 30000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return output.length ? JSON.parse(output) : null
  } catch {
    // Azure errors can contain authentication material. Do not forward them.
    throw new Error("Protected qualification signer check failed")
  }
}

export function verifyHealthSignature(raw, result) {
  assert.equal(typeof raw, "string")
  assert.ok(Buffer.byteLength(raw) <= 4096)
  assert.deepEqual(Object.keys(result).sort(), ["algorithm", "keyId", "signature"])
  assert.equal(result.algorithm, "RS256")
  assert.equal(result.keyId, keyId)
  assert.match(result.signature, /^[A-Za-z0-9+/]{512}$/)
  const signature = Buffer.from(result.signature, "base64")
  assert.equal(signature.toString("base64"), result.signature)
  const publicKey = createPublicKey({ key: configuration.publicKey, format: "jwk" })
  assert.equal(publicKey.asymmetricKeyDetails.modulusLength, 3072)
  assert.ok(verify("RSA-SHA256", Buffer.from(raw), publicKey, signature))
}

export async function checkIssuerHealth({
  readIdentity = readQualificationIssuerToken,
  run = azure,
} = {}) {
  // Authenticate exact main source, run, attempt, repository and reusable job
  // before exchanging a credential. No caller supplies bytes to be signed.
  const { token, identity } = await readIdentity()
  const raw = JSON.stringify({
    schema: "lyrashield-qualification-key-health/1",
    purpose: "signing-primitive-check-only",
    productionQualification: false,
    keyId,
    owner: identity.owner,
    source: identity.source,
    nonce: randomUUID(),
    checkedAt: new Date().toISOString(),
  })
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
      keyId,
      "--algorithm",
      "RS256",
      "--digest",
      createHash("sha256").update(raw).digest("base64"),
    ])
    verifyHealthSignature(raw, result)
    return { raw, result, signatureVerified: true, qualified: false }
  } finally {
    run(["logout"])
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const receipt = await checkIssuerHealth()
    writeFileSync("qualification-issuer-health.json", JSON.stringify(receipt) + "\n", {
      mode: 0o600,
    })
    process.stdout.write("Protected managed signer verified; no runtime qualification issued.\n")
  } catch {
    process.stderr.write("Protected qualification signer check failed.\n")
    process.exitCode = 1
  }
}
