import { pathToFileURL } from "node:url"
import { getSystemPrisma } from "@lyrashield/db"
import { readEncryptedArtifact } from "@lyrashield/evidence-storage"

interface RetainedEvidenceRecord {
  storageUri: string | null
  checksum: string | null
  encryptionKeyRef: string | null
  finding: { workspaceId: string }
}

export interface RetainedEvidenceVerifierDeps {
  findEvidence(id: string, workspaceId: string): Promise<RetainedEvidenceRecord | null>
  readArtifact(
    storageUri: string,
    workspaceId: string
  ): Promise<{ checksum: string; encryptionKeyRef: string }>
}

const defaultDeps: RetainedEvidenceVerifierDeps = {
  findEvidence: (id, workspaceId) =>
    getSystemPrisma().evidence.findFirst({
      where: { id, finding: { workspaceId } },
      select: {
        storageUri: true,
        checksum: true,
        encryptionKeyRef: true,
        finding: { select: { workspaceId: true } },
      },
    }),
  readArtifact: readEncryptedArtifact,
}

export async function verifyRetainedEvidence(
  expected: {
    evidenceId: string
    workspaceId: string
    encryptionKeyRef: string
    checksum: string
  },
  deps: RetainedEvidenceVerifierDeps = defaultDeps
): Promise<void> {
  if (!expected.evidenceId || !/^[a-zA-Z0-9_-]+$/.test(expected.evidenceId)) {
    throw new Error("--evidence-id must be one exact database evidence ID")
  }
  if (!expected.workspaceId || !/^[a-zA-Z0-9_-]+$/.test(expected.workspaceId)) {
    throw new Error("--workspace-id must be one exact database workspace ID")
  }
  if (!/^envkeystore\/lyrashield-evidence-kek\/v[1-9][0-9]*$/.test(expected.encryptionKeyRef)) {
    throw new Error("--expected-key-ref must be one exact versioned evidence key ref")
  }
  if (!/^[a-f0-9]{64}$/.test(expected.checksum)) {
    throw new Error("--expected-checksum must be one exact lowercase SHA-256 checksum")
  }

  const evidence = await deps.findEvidence(expected.evidenceId, expected.workspaceId)
  if (!evidence) throw new Error("Evidence record was not found")
  if (!evidence.storageUri || !evidence.checksum || !evidence.encryptionKeyRef) {
    throw new Error("Evidence record is missing retained encryption metadata")
  }
  if (evidence.finding.workspaceId !== expected.workspaceId) {
    throw new Error("Evidence workspace does not match operator-bound metadata")
  }
  if (evidence.encryptionKeyRef !== expected.encryptionKeyRef) {
    throw new Error("Evidence key reference does not match operator-bound metadata")
  }
  if (evidence.checksum !== expected.checksum) {
    throw new Error("Evidence checksum does not match operator-bound metadata")
  }

  const read = await deps.readArtifact(evidence.storageUri, expected.workspaceId)
  if (read.checksum !== expected.checksum) {
    throw new Error("Retained evidence checksum does not match immutable metadata")
  }
  if (read.encryptionKeyRef !== expected.encryptionKeyRef) {
    throw new Error("Retained evidence key reference does not match immutable metadata")
  }
}

function expectedEvidenceFromArgs(args: string[]) {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name || !value || !name.startsWith("--") || values.has(name)) {
      throw new Error("Invalid retained-evidence arguments")
    }
    values.set(name, value)
  }
  if (
    values.size !== 4 ||
    !values.get("--evidence-id") ||
    !values.get("--workspace-id") ||
    !values.get("--expected-key-ref") ||
    !values.get("--expected-checksum")
  ) {
    throw new Error(
      "Usage: verify:retained-evidence -- --evidence-id <id> --workspace-id <id> --expected-key-ref <ref> --expected-checksum <sha256>"
    )
  }
  return {
    evidenceId: values.get("--evidence-id")!,
    workspaceId: values.get("--workspace-id")!,
    encryptionKeyRef: values.get("--expected-key-ref")!,
    checksum: values.get("--expected-checksum")!,
  }
}

export async function runRetainedEvidenceCli(
  args: string[],
  deps: RetainedEvidenceVerifierDeps = defaultDeps,
  output: Pick<Console, "log" | "error"> = console
): Promise<number> {
  try {
    await verifyRetainedEvidence(expectedEvidenceFromArgs(args), deps)
    output.log("RETAINED_EVIDENCE_READBACK_OK")
    return 0
  } catch {
    output.error("RETAINED_EVIDENCE_READBACK_FAILED")
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRetainedEvidenceCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
