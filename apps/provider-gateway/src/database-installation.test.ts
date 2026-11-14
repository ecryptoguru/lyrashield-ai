import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { loadDatabaseProviderAuthority } from "./database-installation"
import { fixturePolicy } from "./test-fixtures"

const original = "original-controller-key-".repeat(3)
const wrapper = "independent-wrapper-key-".repeat(3)
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const source = {
  streamId: "installed-supervisor-stream",
  authorityEpochId: "installed-authority-epoch",
  supervisorInstanceId: "installed-supervisor-instance",
  originalKeyHash: hash(original),
  wrapperKeyHash: hash(wrapper),
  socketPath: "/run/lyrashield/supervisor/control.sock",
}
const env = () => ({
  LYRASHIELD_SCAN_EXECUTION_DATABASE_URL: "postgresql://controller@127.0.0.1:5432/disposable",
  LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON: JSON.stringify(source),
  LYRASHIELD_SUPERVISOR_SIGNING_SECRET: original,
  LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET: wrapper,
  LYRASHIELD_SUPERVISOR_CONTROL_TOKEN: "private-control-token-".repeat(3),
})
const providers = new Map([
  [
    "azure-ai",
    {
      id: "azure-ai",
      baseUrl: "https://provider.example.test",
      auth: { kind: "authorization" as const, credential: "synthetic-provider-key" },
      allowedPathPrefixes: ["/openai/"],
      requestPolicy: fixturePolicy,
    },
  ],
])

describe("protected database gateway installation", () => {
  it("keeps an uninstalled gateway without a database authority", () => {
    expect(loadDatabaseProviderAuthority(providers, {})).toBeUndefined()
  })
  it("constructs the real grant, publisher and native fence with separate source keys", async () => {
    const authority = loadDatabaseProviderAuthority(providers, env())!
    expect(authority.authorityFence.constructor.name).toBe("PostgresDurableScanAuthorityFence")
    expect(typeof authority.authorizeGrant).toBe("function")
    expect(typeof authority.publishActionIntent).toBe("function")
    await authority.close()
  })
  it.each([
    { ...source, socketPath: "relative.sock" },
    { ...source, url: "https://worker-selected.example" },
    { ...source, originalKeyHash: "f".repeat(64) },
  ])("rejects invalid or mismatched source authority before connecting", (invalid) => {
    expect(() =>
      loadDatabaseProviderAuthority(providers, {
        ...env(),
        LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON: JSON.stringify(invalid),
      })
    ).toThrow()
  })
  it("rejects incomplete provider policies before creating a pool", () => {
    expect(() => loadDatabaseProviderAuthority(new Map(), env())).toThrow(
      "No approved provider policies"
    )
  })
})
