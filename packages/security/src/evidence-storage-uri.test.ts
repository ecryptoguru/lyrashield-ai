import { describe, expect, it } from "vitest"
import { pathToFileURL } from "node:url"
import { isEvidenceStorageUriForWorkspace } from "./evidence-storage-uri"

const options = {
  workspaceId: "ws-1",
  s3Bucket: "evidence-bucket",
  localEvidenceRoot: "/tmp/lyrashield-evidence",
}

describe("isEvidenceStorageUriForWorkspace", () => {
  it("accepts only bucket-bound S3 objects under the exact workspace prefix", () => {
    expect(
      isEvidenceStorageUriForWorkspace({
        ...options,
        storageUri: "s3://evidence-bucket/evidence/ws-1/integrations/secret.enc",
      })
    ).toBe(true)
    for (const storageUri of [
      "s3://other-bucket/evidence/ws-1/secret.enc",
      "s3://evidence-bucket/evidence/ws-10/secret.enc",
      "vault://legacy/secret",
      "s3://evidence-bucket/evidence/ws-1",
    ]) {
      expect(isEvidenceStorageUriForWorkspace({ ...options, storageUri })).toBe(false)
    }
  })

  it("accepts local encrypted objects under the configured workspace directory", () => {
    const storageUri = pathToFileURL(
      "/tmp/lyrashield-evidence/evidence/ws-1/integrations/secret.enc"
    ).toString()
    expect(isEvidenceStorageUriForWorkspace({ ...options, storageUri })).toBe(true)
    expect(
      isEvidenceStorageUriForWorkspace({
        ...options,
        storageUri: pathToFileURL("/tmp/elsewhere/evidence/ws-1/secret.enc").toString(),
      })
    ).toBe(false)
  })
})
