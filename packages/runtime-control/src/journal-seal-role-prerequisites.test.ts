import { describe, expect, it, vi } from "vitest"
import type { AuthoritySqlConnection } from "./postgres-mirror"
import { assertScanJournalSealRolePrerequisites } from "./journal-seal-role-prerequisites"
function connection(rows: Record<string, unknown>[]) {
  return {
    query: vi.fn<AuthoritySqlConnection["query"]>().mockResolvedValue({ rows }),
    release: vi.fn(),
  }
}
describe("protected journal seal role prerequisite", () => {
  it("requires the distinct direct login and permits only fixed updatedAt row-lock grants", async () => {
    const c = connection([{ safe: true }])
    await assertScanJournalSealRolePrerequisites(c, "journal_pin_controller")
    expect(c.query.mock.calls[0][1]).toEqual(["journal_pin_controller"])
    expect(c.query.mock.calls[0][0]).toContain("session_user=$1 AND current_user=$1")
    expect(c.query.mock.calls[0][0]).toContain("pg_has_role(current_user,reachable.oid,'SET')")
    expect(c.query.mock.calls[0][0]).toContain("a.attname='updatedAt'")
  })
  it.each([
    "postgres",
    "app_runtime_prod",
    "service_role",
    "unsafe-role",
    "bad role",
    "owner';SELECT1",
  ])("rejects unsafe identity %s before querying", async (role) => {
    const c = connection([{ safe: true }])
    await expect(assertScanJournalSealRolePrerequisites(c, role)).rejects.toThrow()
    expect(c.query).not.toHaveBeenCalled()
  })
  it("fails closed on denied, missing or ambiguous catalog readback", async () => {
    for (const rows of [[], [{ safe: false }], [{ safe: true }, { safe: true }]])
      await expect(
        assertScanJournalSealRolePrerequisites(connection(rows), "journal_pin_controller")
      ).rejects.toThrow()
  })
})
