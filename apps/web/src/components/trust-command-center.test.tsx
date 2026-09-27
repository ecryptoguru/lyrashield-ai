import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TrustCommandCenter } from "./trust-command-center"

function render(
  gateState: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE" | null,
  overrides: Partial<React.ComponentProps<typeof TrustCommandCenter>> = {}
) {
  return renderToString(
    <TrustCommandCenter
      productName="Workspace"
      mode={null}
      trustPlanData={null}
      gate={gateState ? { state: gateState, coverageLabel: "0/1 assessed · 1 expired" } : null}
      targetScope="1 active target"
      latestAssessment={null}
      limitations={[]}
      latestScore={null}
      {...overrides}
    />
  )
}

describe("dashboard evidence summary", () => {
  it("shows a first-run posture without inventing an assessment", () => {
    const html = render(null, { targetScope: "No targets yet" })

    expect(html).toContain("Not scored")
    expect(html).toContain("No current assessment")
    expect(html).toContain("Run a scan to capture your first evidence.")
    expect(html).not.toContain("Ready to launch")
  })

  it("shows missing and expired scope without presenting a score", () => {
    const html = render("INSUFFICIENT_EVIDENCE", {
      limitations: ["Web app: the most recent score has expired."],
    })

    expect(html).toContain("Current evidence")
    expect(html).toContain("1 active target")
    expect(html).toContain("0/1 assessed · 1 expired")
    expect(html).toContain("Web app: the most recent score has expired.")
    expect(html).toContain("No evaluated review yet")
    expect(html).not.toContain("Ready to launch")
  })

  it("binds a ready label to the evaluated target and date", () => {
    const html = render("READY", {
      gate: { state: "READY", coverageLabel: "2/2 assessed" },
      targetScope: "2 active targets",
      latestAssessment: { targetName: "Checkout API", completedAtLabel: "Sep 26, 2026" },
      latestScore: {
        score: 91,
        grade: "A",
        targetName: "Checkout API",
        completedAtLabel: "Sep 26, 2026",
      },
    })

    expect(html).toContain("Ready to launch")
    expect(html).toContain("2 active targets")
    expect(html).toContain("Checkout API · Sep 26, 2026")
  })

  it("keeps the review plan as a native disclosure that starts collapsed", () => {
    const html = render("NOT_READY", {
      limitations: ["Checkout API: resolve the blocking findings."],
    })

    expect(html).toContain("<details")
    expect(html).not.toContain("<details open")
    expect(html).toContain("Review plan details")
    expect(html).toContain("Checkout API: resolve the blocking findings.")
  })
})
