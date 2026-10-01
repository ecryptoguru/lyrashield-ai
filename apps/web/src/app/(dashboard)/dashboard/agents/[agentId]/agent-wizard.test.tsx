import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { buildAgentWizard } from "@/lib/agent-wizard"
import { AgentWizard } from "./agent-wizard"

describe("agent wizard status display", () => {
  it("renders compatibility evidence and marketplace state as separate claims", () => {
    const data = buildAgentWizard("pi", "https://app.lyrashieldai.com")
    if (!data) throw new Error("Pi wizard data is missing")

    const markup = renderToStaticMarkup(
      <AgentWizard data={data} docsUrl="https://lyrashieldai.com/docs/integrations/pi" />
    )

    expect(markup).toContain("Compatibility evidence")
    expect(markup).toMatch(/Support tier:.*COMPATIBLE/)
    expect(markup).toContain("Distribution channel")
    expect(markup).toContain("Client supports (documented):")
    expect(markup).not.toContain("Native components:")
    expect(markup).toMatch(/State: <span[^>]*>PREPARATION<\/span>/)
    expect(markup).toContain("Distribution status is separate from client compatibility.")
    expect(markup).toContain("A configured file alone does not confirm the client loaded")
  })
})
