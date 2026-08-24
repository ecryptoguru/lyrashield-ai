import { pathToFileURL } from "node:url"

export async function verifyEvidenceStorageFailsClosed(): Promise<void> {
  process.env.LYRASHIELD_EVIDENCE_KEK = ""
  const { assertEvidenceStorageConfigured, EvidenceEnvelopeError } =
    await import("@lyrashield/evidence-storage")

  try {
    assertEvidenceStorageConfigured()
  } catch (error) {
    if (
      error instanceof EvidenceEnvelopeError &&
      error.message === "LYRASHIELD_EVIDENCE_KEK is not configured"
    ) {
      return
    }
    throw error
  }

  throw new Error("Evidence storage accepted a production configuration without its KEK")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyEvidenceStorageFailsClosed()
    .then(() => console.log("EVIDENCE_STORAGE_FAIL_CLOSED_OK"))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
