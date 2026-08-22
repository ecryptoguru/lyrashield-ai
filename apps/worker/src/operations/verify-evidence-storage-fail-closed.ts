export async function verifyEvidenceStorageFailsClosed(): Promise<void> {
  process.env.LYRASHIELD_EVIDENCE_KEK = ""
  const { assertEvidenceStorageConfigured, EvidenceStorageConfigurationError } =
    await import("@lyrashield/evidence-storage")

  try {
    assertEvidenceStorageConfigured()
  } catch (error) {
    if (error instanceof EvidenceStorageConfigurationError || error instanceof Error) return
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
import { pathToFileURL } from "node:url"
