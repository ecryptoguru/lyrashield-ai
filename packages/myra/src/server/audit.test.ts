import { describe, expect, it, vi } from "vitest"
import type { MyraDb } from "./db"
import { auditEvent } from "./audit"

describe("auditEvent metadata", () => {
  it("keeps oversized metadata valid, bounded, and secret-screened", async () => {
    const create = vi.fn(async (_input: { data: { metadata?: Record<string, unknown> } }) => ({
      id: "audit-1",
    }))
    const db = { myraAuditEvent: { create } } as unknown as MyraDb
    const jwt = `${"a".repeat(24)}.${"b".repeat(10)}.${"c".repeat(25)}`

    await auditEvent(
      "system",
      {
        action: "metadata.test",
        resourceType: "test",
        metadata: {
          diagnostic: `auth: ${jwt}`,
          values: Array.from({ length: 25 }, (_, index) => `${index}:${"x".repeat(195)}`),
        },
      },
      db
    )

    expect(create).toHaveBeenCalledOnce()
    const metadata = create.mock.calls[0]?.[0].data.metadata
    expect(metadata).toMatchObject({ truncated: true, diagnostic: "auth: [redacted-secret]" })
    const serialized = JSON.stringify(metadata)
    expect(typeof serialized).toBe("string")
    if (serialized === undefined) throw new Error("Metadata must remain serializable")
    expect(JSON.parse(serialized)).toEqual(metadata)
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(4000)
    expect((metadata?.values as string[]).length).toBeLessThan(25)
    expect((metadata?.values as string[])[0]).toContain("0:")
  })
})
