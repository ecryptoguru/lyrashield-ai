import { existsSync, readFileSync } from "node:fs"
import { renderToString } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { requirePlatformAdminIdentity, getPlatformAdminOverview, notFound } = vi.hoisted(() => ({
  requirePlatformAdminIdentity: vi.fn(),
  getPlatformAdminOverview: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePlatformAdminIdentity: (...args: unknown[]) => requirePlatformAdminIdentity(...args),
}))
vi.mock("@/lib/platform-admin-overview", () => ({
  getPlatformAdminOverview: (...args: unknown[]) => getPlatformAdminOverview(...args),
}))
vi.mock("next/navigation", () => ({ notFound }))

import PlatformAdminPage from "./page"

describe("platform admin overview page", () => {
  beforeEach(() => vi.clearAllMocks())

  it("never starts privileged reads for an unauthorized request", async () => {
    requirePlatformAdminIdentity.mockRejectedValue(new Error("UNAUTHORIZED"))

    await expect(PlatformAdminPage()).rejects.toThrow("NEXT_NOT_FOUND")
    expect(getPlatformAdminOverview).not.toHaveBeenCalled()
  })

  it("renders the growth plan mix with workspace plan labels not raw tokens", async () => {
    requirePlatformAdminIdentity.mockResolvedValue({ userId: "admin-1" })
    getPlatformAdminOverview.mockResolvedValue({
      generatedAt: "2026-09-01T12:00:00.000Z",
      database: { status: "healthy", users: 12, workspaces: 8, targets: 15 },
      scans: { status: "healthy", queued: 0, active: 1, completed: 42, failed: 0 },
      worker: { status: "healthy", available: true },
      queue: { status: "healthy", waiting: 0, active: 0, delayed: 0, failed: 0 },
      billing: { status: "healthy", active: 5, free: 9, deadLetters: 0 },
      affiliates: { status: "healthy", pendingApplications: 0, pendingPayouts: 0 },
      growth: {
        activePaidAccounts: 5,
        paidAccountsInTerm: 5,
        newPaidAccounts30d: 2,
        canceled30d: 1,
        mrrUsd: 1157,
        arrUsd: 13884,
        planMix: { LAUNCH_ASSURANCE: 3, PRO: 2 },
      },
      activation: null,
    })

    const html = renderToString(await PlatformAdminPage())

    expect(html).toContain("Agency 3")
    expect(html).toContain("Pro 2")
    expect(html).not.toContain("LAUNCH_ASSURANCE")
  })

  it("ships a LoadingShell route loading state", () => {
    const loadingPath = new URL("./loading.tsx", import.meta.url)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(existsSync(loadingPath)).toBe(true)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(loadingPath, "utf8")
    expect(source).toContain("LoadingShell")
  })
})
