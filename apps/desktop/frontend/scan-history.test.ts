import { beforeEach, describe, expect, it, vi } from "vitest"

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))

import { appendScanHistory } from "./src/lib/scan-history"
import { listScanPage } from "./src/lib/tauri"

const nativeScan = (scanId: string) => ({
  scan_id: scanId,
  target: "local",
  mode: "standard",
  workflow: "REVIEW_TARGET",
  backend: "local",
  contract_version: null,
  diff_base: null,
  diff_head: null,
  status: "completed",
  started_at: "2026-09-30T12:00:00Z",
  completed_at: "2026-09-30T12:01:00Z",
  finding_count: 1,
})

describe("desktop scan history pagination", () => {
  beforeEach(() => invoke.mockReset())

  it("maps the keyset cursor and appends pages without duplicate scans", async () => {
    invoke.mockResolvedValue({
      scans: [nativeScan("scan-1001")],
      nextCursor: { startedAt: "2026-09-30T12:00:00Z", scanId: "scan-1001" },
    })

    const cursor = { startedAt: "2026-09-30T12:00:00Z", scanId: "scan-1050" }
    const page = await listScanPage(cursor, 75)

    expect(invoke).toHaveBeenCalledWith("list_scan_page", { cursor, limit: 75 })
    expect(page.scans[0]).toMatchObject({ scanId: "scan-1001", startedAt: cursor.startedAt })
    expect(page.nextCursor).toEqual({ startedAt: cursor.startedAt, scanId: "scan-1001" })
    expect(
      appendScanHistory(page.scans, [page.scans[0], { ...page.scans[0], scanId: "scan-1000" }])
    ).toHaveLength(2)
  })
})
