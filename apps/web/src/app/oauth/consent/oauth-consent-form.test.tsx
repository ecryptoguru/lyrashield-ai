import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { OAuthConsentForm } from "./oauth-consent-form"

const baseProps = {
  clientName: "Codex",
  clientId: "client-codex",
  oauthQuery: "client_id=client-codex",
  workspaces: [{ id: "ws-1", name: "Workspace" }],
  targets: [{ id: "target-1", name: "App", workspaceId: "ws-1", type: "REPO" }],
}

describe("OAuthConsentForm", () => {
  it("offers one connection action with automatic access and cost disclosure", () => {
    const html = renderToStaticMarkup(
      <OAuthConsentForm {...baseProps} scope="lyrashield.read lyrashield.write" />
    )
    expect(html).toContain("Automatic workspace access")
    expect(html).toContain("current and future targets")
    expect(html).toContain("incur charges")
    expect(html).not.toContain('type="radio"')
    expect(html).not.toContain('type="checkbox"')
    expect(html).toContain("Connect LyraShield")
  })

  it("does not promote a read-only OAuth request to write access", () => {
    const html = renderToStaticMarkup(<OAuthConsentForm {...baseProps} scope="lyrashield.read" />)
    expect(html).toContain("cannot make changes")
    expect(html).not.toContain("Automatic workspace access")
    expect(html).not.toContain('type="radio"')
  })
})
