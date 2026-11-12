// Protected read-only issuer step; no candidate bytes are signed here.
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { readQualificationIssuerToken } from "./paired-runtime-github.mjs"
import { verifySandboxCoveragePublication } from "./runtime-qualification-foundation.mjs"

export async function verifyFreshSandboxPublication(
  raw,
  { readIdentity = readQualificationIssuerToken, verify = verifySandboxCoveragePublication } = {}
) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 4096)
    throw new Error("Invalid sandbox publication selector")
  const expected = JSON.parse(raw)
  // Authenticate the protected main reusable job before any candidate reads.
  // The token is never exchanged for Azure credentials or written to artifacts.
  await readIdentity()
  return verify(expected)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyFreshSandboxPublication(process.env.FRESH_SANDBOX_PUBLICATION)
    writeFileSync("sandbox-publication-verification.json", JSON.stringify(result) + "\n", {
      mode: 0o600,
      flag: "wx",
    })
    process.stdout.write(
      "Authenticated sandbox publication; native inventory and runtime issuance remain held.\n"
    )
  } catch {
    // Verifier and registry errors can contain credentials. Emit no raw details.
    process.stderr.write("Protected sandbox publication verification failed.\n")
    process.exitCode = 1
  }
}
