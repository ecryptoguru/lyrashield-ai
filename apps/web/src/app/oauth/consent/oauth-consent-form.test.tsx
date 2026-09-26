import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { OAuthConsentForm } from "./oauth-consent-form"

const baseProps = {
  clientName: "Codex",
  clientId: "client-codex",
  oauthQuery: "client_id=client-codex",
  consentState: "signed-consent-state",
  workspaces: [{ id: "ws-1", name: "Workspace" }],
  targets: [{ id: "target-1", name: "App", workspaceId: "ws-1", type: "REPO" }],
}

describe("OAuthConsentForm", () => {
  it("offers automatic access and keeps scan cancellation opt-in", () => {
    const html = renderToStaticMarkup(
      <OAuthConsentForm {...baseProps} scope="lyrashield.read lyrashield.write" />
    )
    expect(html).toContain("Automatic workspace access")
    expect(html).toContain("current and future targets")
    expect(html).toContain("incur charges")
    expect(html).not.toContain('type="radio"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain("cancel running scans")
    expect(html).toContain("off by default")
    expect(html).toContain("supporting scan attachments")
    expect(html).toContain("Connect LyraShield")
  })

  it("does not promote a read-only OAuth request to write access", () => {
    const html = renderToStaticMarkup(<OAuthConsentForm {...baseProps} scope="lyrashield.read" />)
    expect(html).toContain("cannot make changes")
    expect(html).not.toContain("Automatic workspace access")
    expect(html).not.toContain('type="radio"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain("does not allow uploads, deletion or scan work")
  })
})
