import { describe, expect, it } from "vitest"
import { installedJournalMirrorRole } from "./installed-journal-connections"

const execution = "postgresql://native_execution:fixture@database:5432/authority"
const mirror = "postgresql://journal_mirror:fixture@database/authority"
const receipt = "postgresql://receipt_consumer:fixture@database:5432/authority"
const unavailable = "Protected independent supervisor journal is unavailable"

describe("installed journal connection boundaries", () => {
  it("accepts separate roles in the same database and publication without a receipt role", () => {
    expect(installedJournalMirrorRole(mirror, execution, receipt)).toBe("journal_mirror")
    expect(installedJournalMirrorRole(mirror, execution)).toBe("journal_mirror")
  })

  it.each(["native_execution", "postgres", "service_role", "app_runtime_prod", "app_system_prod"])(
    "rejects the privileged or reused mirror role %s",
    (role) => {
      expect(() =>
        installedJournalMirrorRole(mirror.replace("journal_mirror", role), execution, receipt)
      ).toThrow(unavailable)
    }
  )

  it.each(["journal_mirror", "native_execution", "postgres"])(
    "rejects a receipt role shared with another authority: %s",
    (role) => {
      expect(() =>
        installedJournalMirrorRole(mirror, execution, receipt.replace("receipt_consumer", role))
      ).toThrow(unavailable)
    }
  )

  it.each([
    "postgresql://journal_mirror:fixture@another/authority",
    "postgresql://journal_mirror:fixture@database:5433/authority",
    "postgresql://journal_mirror:fixture@database/another",
    "https://journal_mirror:fixture@database/authority",
    "postgresql://%zz:fixture@database/authority",
  ])("rejects a foreign or malformed mirror identity without exposing its URL", (url) => {
    expect(() => installedJournalMirrorRole(url, execution, receipt)).toThrow(unavailable)
  })

  it("rejects a receipt in a different database", () => {
    expect(() =>
      installedJournalMirrorRole(mirror, execution, receipt.replace("/authority", "/another"))
    ).toThrow(unavailable)
  })
})
