import { expect, it, vi } from "vitest"
import { sign } from "node:crypto"

const keys = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import("node:crypto")
  return generateKeyPairSync("rsa", { modulusLength: 3072 })
})
const io = vi.hoisted(() => ({
  read: vi.fn(),
  legacy: vi.fn(() => {
    throw Error("legacy coverage unavailable")
  }),
}))
vi.mock("@lyrashield/config", () => ({ env: {} }))
vi.mock("./workspace-path", () => ({ ENGINE_TEMP_ROOT: "/tmp/unused-test-root" }))
vi.mock("./sandbox-sbom-coverage", () => ({
  readJsonEvidence: io.read,
  assertSandboxSbomCoverageVerified: io.legacy,
}))
vi.mock(
  "../../../../packages/security/src/runtime-qualification-key.json",
  async (importOriginal) => {
    const original = await importOriginal<{ default: { keyId: string } }>()
    return { default: { ...original.default, publicKey: keys.publicKey.export({ format: "jwk" }) } }
  }
)
import { runtimeQualificationKeyId } from "@lyrashield/security/sandbox-publication-record"
import { assertRepositoryScanRuntimeConfigured } from "./runner-config"

const path = "/etc/lyrashield/sandbox-publication-record.json"
const runtime = {
  NODE_ENV: "production",
  LYRASHIELD_SOL_LLM: "gpt-6-sol",
  LYRASHIELD_LUNA_LLM: "gpt-6-luna",
  LLM_API_KEY: "synthetic-fixture",
  LYRASHIELD_ENGINE_SANDBOX_NETWORK: "restricted-fixture",
  DOCKER_HOST: "ssh://fixture",
  LYRASHIELD_ENGINE_REVISION: "a".repeat(40),
  LYRASHIELD_IMAGE: "ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:" + "c".repeat(64),
  LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH: path,
}
const record = () => ({
  schema: "lyrashield-held-sandbox-publication/1",
  purpose: "publication-evidence-only",
  qualified: false,
  nativeInventoryRechecked: false,
  runtimeAuthorityVerified: false,
  signedBoundedCoverageVerified: true,
  coveragePredicateChecksum: "d".repeat(64),
  publication: {
    sandboxDigest: "sha256:" + "c".repeat(64),
    engineRevision: "a".repeat(40),
    publicationRevision: "b".repeat(40),
    publishRunId: "42",
    publishAttempt: "1",
  },
  nativeManifests: { amd64: "sha256:" + "e".repeat(64), arm64: "sha256:" + "f".repeat(64) },
  issuer: { owner: "99:2", source: "1".repeat(40) },
  issuedAt: new Date(Date.now() - 1000).toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
})
function serve(value: unknown) {
  const raw = JSON.stringify(value)
  io.read.mockReset().mockReturnValue({
    raw,
    result: {
      algorithm: "RS256",
      keyId: runtimeQualificationKeyId,
      signature: sign("RSA-SHA256", Buffer.from(raw), keys.privateKey).toString("base64"),
    },
  })
  io.legacy.mockClear()
}

it("authenticates the mounted runtime record and still rejects admission for missing inventory and authority", () => {
  serve(record())
  expect(() => assertRepositoryScanRuntimeConfigured(runtime)).toThrow(
    "independent native inventory and runtime authority are unavailable"
  )
  expect(io.read).toHaveBeenCalledWith(path, "signed publication record", 0)
  expect(io.legacy).not.toHaveBeenCalled()
})
it("rejects signed image/engine mismatch, expiration, hold upgrades and tampering before admission", () => {
  for (const kind of ["image", "engine", "expired", "upgrade", "signature"]) {
    const value = record()
    if (kind === "expired") value.expiresAt = new Date(Date.now() - 1).toISOString()
    if (kind === "upgrade") value.qualified = true
    serve(value)
    if (kind === "signature")
      io.read.mockReturnValue({
        raw: JSON.stringify(value),
        result: {
          algorithm: "RS256",
          keyId: runtimeQualificationKeyId,
          signature: "A".repeat(512),
        },
      })
    expect(() =>
      assertRepositoryScanRuntimeConfigured({
        ...runtime,
        ...(kind === "image"
          ? { LYRASHIELD_IMAGE: runtime.LYRASHIELD_IMAGE.slice(0, -64) + "e".repeat(64) }
          : {}),
        ...(kind === "engine" ? { LYRASHIELD_ENGINE_REVISION: "f".repeat(40) } : {}),
      })
    ).toThrow()
    expect(io.legacy).not.toHaveBeenCalled()
  }
})
it("rejects arbitrary record paths and preserves the legacy missing-coverage hold", () => {
  serve(record())
  expect(() =>
    assertRepositoryScanRuntimeConfigured({
      ...runtime,
      LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH: "/tmp/untrusted.json",
    })
  ).toThrow("protected runtime path")
  expect(io.read).not.toHaveBeenCalled()
  expect(() =>
    assertRepositoryScanRuntimeConfigured({
      ...runtime,
      LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH: undefined,
    })
  ).toThrow("legacy coverage unavailable")
})
