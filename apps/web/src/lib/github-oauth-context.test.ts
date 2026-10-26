import { expect, it } from "vitest"
import { githubSessionIdentity, matchesGitHubSession } from "./github-oauth-context"
it("binds to both initiating user and hashed browser session", () => {
  const session = { userId: "user", sessionId: "private-session-id" }
  const context = { ...githubSessionIdentity(session), purpose: "github-discover" as const }
  expect(JSON.stringify(context)).not.toContain("private-session-id")
  expect(matchesGitHubSession(context, session)).toBe(true)
  expect(matchesGitHubSession(context, { ...session, userId: "another-user" })).toBe(false)
  expect(matchesGitHubSession(context, { ...session, sessionId: "new-session" })).toBe(false)
})
it.each([{ apiKey: {} }, { oauth: {} }, { sessionId: "" }])(
  "does not mint a browser proof for other credential types",
  (override) => {
    expect(() =>
      githubSessionIdentity({ userId: "user", sessionId: "browser", ...override })
    ).toThrow("FORBIDDEN")
  }
)
