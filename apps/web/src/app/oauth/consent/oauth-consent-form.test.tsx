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
  it("defaults to least-privilege read access", () => {
    const html = renderToStaticMarkup(
      <OAuthConsentForm {...baseProps} scope="lyrashield.read lyrashield.write" />
    )

    expect(html).toMatch(/<input(?=[^>]*value="read_only")(?=[^>]*checked="")[^>]*\/>/)
    expect(html).not.toContain("Automated Workflows")
  })

  it("does not offer automation when the client requested read scope only", () => {
    const html = renderToStaticMarkup(<OAuthConsentForm {...baseProps} scope="lyrashield.read" />)

    expect(html).toMatch(/<input(?=[^>]*value="automate")(?=[^>]*disabled="")[^>]*\/>/)
    expect(html).toContain("Reconnect with write scope to automate workflows.")
  })
})
