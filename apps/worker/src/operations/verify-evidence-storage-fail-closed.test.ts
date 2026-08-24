import { beforeEach, describe, expect, it, vi } from "vitest"
import { verifyEvidenceStorageFailsClosed } from "./verify-evidence-storage-fail-closed"

describe("verifyEvidenceStorageFailsClosed", () => {
  beforeEach(() => {
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
      BETTER_AUTH_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      BETTER_AUTH_SECRET: "dummy-ci-only-secret-not-a-real-credential",
      NODE_ENV: "test",
      LYRASHIELD_LOCAL_EVIDENCE_STORAGE: "0",
    })
    delete process.env.S3_ENDPOINT
    delete process.env.S3_BUCKET
    delete process.env.S3_ACCESS_KEY
    delete process.env.S3_SECRET_KEY
    vi.resetModules()
  })

  it("does not mistake missing S3 configuration for missing-KEK proof", async () => {
    await expect(verifyEvidenceStorageFailsClosed()).rejects.toThrow(
      "Evidence storage is not configured"
    )
  })

  it("accepts only the exact missing-KEK failure with complete S3 configuration", async () => {
    Object.assign(process.env, {
      S3_ENDPOINT: "https://s3.example.test",
      S3_BUCKET: "evidence",
      S3_ACCESS_KEY: "test-access",
      S3_SECRET_KEY: "test-secret",
    })

    await expect(verifyEvidenceStorageFailsClosed()).resolves.toBeUndefined()
  })
})
