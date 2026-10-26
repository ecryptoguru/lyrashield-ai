import { beforeEach, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createHash } from "node:crypto"
const auth = vi.hoisted(() => ({ getSession: vi.fn(), requirePermission: vi.fn() }))
vi.mock("@lyrashield/config", () => ({
  env: { BETTER_AUTH_SECRET: "synthetic-test-only-secret-at-least-32" },
}))
vi.mock("@lyrashield/auth/server", () => auth)
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`)
  },
}))
import GitHubChooserPage from "./page"
import { createInstallState } from "@/lib/github-install-state"

const session = { userId: "user-1", sessionId: "session-1" }
const state = () =>
  createInstallState("ws-1", "onboarding", Date.now(), undefined, {
    purpose: "github-choose",
    userId: "user-1",
    sessionHash: createHash("sha256").update("session-1").digest("hex"),
    providerUserId: 42,
    candidates: [
      { id: 1, login: "private-account" },
      { id: 2, login: "other-account" },
    ],
  })
beforeEach(() => {
  auth.getSession.mockResolvedValue(session)
  auth.requirePermission.mockResolvedValue({ session })
})
it("only renders signed candidates to the initiating authorized browser session", async () => {
  const html = renderToStaticMarkup(
    await GitHubChooserPage({ searchParams: Promise.resolve({ state: state() }) })
  )
  expect(html).toContain("private-account")
  expect(html).toContain("github=cancelled")
  expect(auth.requirePermission).toHaveBeenCalledWith("ws-1", "integration:manage")
})
it.each(["session", "permission", "tampering"])(
  "does not disclose candidates after %s changes",
  async (change) => {
    let token = state()
    if (change === "session")
      auth.getSession.mockResolvedValue({ ...session, sessionId: "new-session" })
    if (change === "permission")
      auth.requirePermission.mockRejectedValueOnce(new Error("FORBIDDEN"))
    if (change === "tampering") token += "x"
    const html = renderToStaticMarkup(
      await GitHubChooserPage({ searchParams: Promise.resolve({ state: token }) })
    )
    expect(html).toContain("connection expired")
    expect(html).not.toContain("private-account")
    expect(html).not.toContain("select")
  }
)
