import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import {
  parseRootPublicationConfiguration,
  readRootPublicationBytes,
  createPublicationRecoverySnapshot,
  observePublishedJournal,
} from "../journal-seal-publication.mjs"
import {
  publishInstalledJournalSeal,
  publishInstalledToolJournalSeal,
} from "../publish-journal-seal.mjs"

const source = "a".repeat(40)
function configuration() {
  const environment = {
    LYRASHIELD_SUPERVISOR_JOURNAL_PATH: "/var/lib/lyrashield/original",
    LYRASHIELD_SUPERVISOR_INDEPENDENT_JOURNAL_PATH: "/var/lib/lyrashield/wrapper",
    LYRASHIELD_SUPERVISOR_SIGNING_SECRET: "o".repeat(48),
    LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET: "w".repeat(48),
    LYRASHIELD_SUPERVISOR_INSTANCE_ID: "supervisor-1",
    LYRASHIELD_SUPERVISOR_CONTROL_TOKEN: "control-token",
    LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON: "{}",
    LYRASHIELD_SCAN_EXECUTION_DATABASE_URL:
      "postgresql://execution_role:secret@localhost/disposable",
    LYRASHIELD_SUPERVISOR_MIRROR_DATABASE_URL:
      "postgresql://journal_mirror_role:secret@localhost/disposable",
    LYRASHIELD_SUPERVISOR_JOURNAL_STORAGE_JSON: "{}",
    LYRASHIELD_AUTHORITY_EPOCH_ID: "epoch-1",
    LYRASHIELD_PRODUCT_REVISION: source,
    LYRASHIELD_RUNTIME_POLICY_DIGEST: `sha256:${"b".repeat(64)}`,
    LYRASHIELD_PROVIDER_GATEWAY_URL: "http://127.0.0.1:8791",
    LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN: "gateway-token",
    LYRASHIELD_SUPERVISOR_CGROUP_ROOT: "/sys/fs/cgroup/lyrashield",
  }
  return {
    schema: "lyrashield-root-journal-seal-publisher/1",
    productRevision: source,
    environment,
    sealDatabaseUrl: "postgresql://root_seal_role:secret@localhost/disposable",
    mirrorDatabaseUrl: "postgresql://seal_mirror_role:secret@localhost/disposable",
  }
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))

describe("root journal publisher boundary", () => {
  it("keeps tool publication on its fixed root stream and rejects caller configuration", async () => {
    expect(() => publishInstalledToolJournalSeal({ source, streamKind: "controller" })).toThrow(
      "Root journal seal publication is unavailable"
    )
    await expect(publishInstalledToolJournalSeal({ source })).rejects.toThrow(
      "Root journal seal publication is unavailable"
    )
    await expect(publishInstalledJournalSeal({ source, streamKind: "caller" })).rejects.toThrow(
      "Root journal seal publication is unavailable"
    )
  })
  it("accepts complete installed configuration with four separate login identities", () => {
    const config = configuration()
    expect(parseRootPublicationConfiguration(bytes(config), source)).toEqual(config)
  })
  it.each([
    (config: ReturnType<typeof configuration>) => {
      config.productRevision = "c".repeat(40)
    },
    (config: ReturnType<typeof configuration>) => {
      config.environment.LYRASHIELD_PRODUCT_REVISION = "c".repeat(40)
    },
    (config: ReturnType<typeof configuration>) => {
      config.mirrorDatabaseUrl = config.environment.LYRASHIELD_SUPERVISOR_MIRROR_DATABASE_URL
    },
    (config: ReturnType<typeof configuration>) => {
      config.sealDatabaseUrl = "postgresql://root_seal_role:secret@other-host/disposable"
    },
    (config: ReturnType<typeof configuration>) => {
      config.mirrorDatabaseUrl = "postgresql://seal_mirror_role:secret@localhost/other-store"
    },
    (config: ReturnType<typeof configuration>) => {
      config.sealDatabaseUrl = "postgresql://postgres:secret@localhost/disposable"
    },
    (config: ReturnType<typeof configuration>) => {
      config.environment.LYRASHIELD_SUPERVISOR_JOURNAL_PATH = "../original"
    },
    (config: ReturnType<typeof configuration>) => {
      config.environment.LYRASHIELD_SUPERVISOR_JOURNAL_PATH = "/var/lib/../original"
    },
    (config: ReturnType<typeof configuration>) => {
      Object.assign(config.environment, { NODE_OPTIONS: "--import evil" })
    },
    (config: ReturnType<typeof configuration>) => {
      delete (config.environment as Record<string, string>).LYRASHIELD_SUPERVISOR_CONTROL_TOKEN
    },
  ])(
    "rejects changed source, credential collapse, path selection and process injection",
    (mutate) => {
      const config = configuration()
      mutate(config)
      expect(() => parseRootPublicationConfiguration(bytes(config), source)).toThrow()
    }
  )
  it("never accepts caller-selected root keys or credential files", () => {
    expect(() => readRootPublicationBytes("/tmp/journal-seal-checkpoint-key.txt")).toThrow()
  })
  it("rejects a callback imitation before reconstructing or signing recovery state", async () => {
    await expect(
      createPublicationRecoverySnapshot(
        { independent: { loadConfirmedRange: async () => true } },
        { lastSequence: 1 },
        () => {}
      )
    ).rejects.toThrow()
    await expect(
      observePublishedJournal({ pin: { withBoundedContinuation: async () => true }, evidence: {} })
    ).rejects.toThrow()
  })
  it("rejects missing original pending selectors before opening provider connections", async () => {
    await expect(
      publishInstalledJournalSeal({ source, resumeSealHash: "invented-success" })
    ).rejects.toThrow()
  })
  it.skipIf(process.platform === "linux" && process.getuid?.() === 0)(
    "fails closed on this uninstalled host without exposing configuration",
    async () => {
      await expect(publishInstalledJournalSeal({ source })).rejects.toThrow(
        "Root journal seal publication is unavailable"
      )
    }
  )
  it("ships a callable CLI retaining UNKNOWN and the actual pending hash only", async () => {
    const execute = promisify(execFile)
    await expect(
      execute(process.execPath, [
        "--import",
        new URL("../../../apps/supervisor/node_modules/tsx/dist/loader.mjs", import.meta.url)
          .pathname,
        new URL("../publish-journal-seal.mjs", import.meta.url).pathname,
        "invalid-source",
      ])
    ).rejects.toMatchObject({ code: 1, stderr: '{"status":"UNKNOWN"}\n' })
  })
})
