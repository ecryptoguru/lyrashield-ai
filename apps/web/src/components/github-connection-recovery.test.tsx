import { expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { GitHubConnectionRecovery } from "./github-connection-recovery"
import { GitHubInstallationChooser } from "../app/integrations/github/choose/chooser"

it("renders allowlisted outcomes with recovery and does not disclose a foreign workspace", () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionRecovery status="already_claimed" onConnect={vi.fn()} onSkip={vi.fn()} />
  )
  expect(html).toContain("already connected")
  expect(html).toContain("Install on another account")
  expect(html).toContain("Retry connection")
  expect(html).toContain("Skip for now")
  expect(html).not.toContain("href=")
})
it("ignores arbitrary callback text and removes unavailable actions", () => {
  expect(
    renderToStaticMarkup(<GitHubConnectionRecovery status="<script>alert(1)</script>" />)
  ).toBe("")
  const html = renderToStaticMarkup(<GitHubConnectionRecovery status="verification_required" />)
  expect(html).toContain("could not confirm")
  expect(html).not.toContain("button")
  expect(html).not.toContain("href=")
})
it("renders chooser labels escaped with a labelled selection and a local cancel link", () => {
  const html = renderToStaticMarkup(
    <GitHubInstallationChooser
      state="signed"
      workspaceId="ws"
      returnPath="/onboarding"
      candidates={[
        { id: 1, login: "<img src=x onerror=alert(1)>" },
        { id: 2, login: "acme" },
      ]}
    />
  )
  expect(html).toContain("&lt;img")
  expect(html).not.toContain("<img")
  expect(html).toContain("GitHub account")
  expect(html).toContain('href="/onboarding"')
  expect(html).toContain("Continue with GitHub")
})

it("does not offer integration recovery mutations without current manage permission", async () => {
  const { GithubIntegration } =
    await import("../app/(dashboard)/dashboard/integrations/github-integration")
  const html = renderToStaticMarkup(
    <GithubIntegration
      workspaceId="ws"
      connected={false}
      accountLogin={null}
      githubStatus="already_claimed"
      canManage={false}
    />
  )
  expect(html).toContain("already connected")
  expect(html).not.toContain("Retry connection")
  expect(html).not.toContain("Install on another account")
  expect(html).not.toContain(">Connect GitHub<")
})

it("explains an existing workspace binding without offering an ineffective install-new action", () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionRecovery
      status="workspace_already_connected"
      onConnect={vi.fn()}
      onSkip={vi.fn()}
    />
  )
  expect(html).toContain("different active GitHub installation")
  expect(html).toContain("Retry connection")
  expect(html).not.toContain("Install on another account")
  expect(html).toContain("Skip for now")
})
