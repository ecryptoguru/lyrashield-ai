import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}))
vi.mock("./launch-readiness-webmcp", () => ({
  useLaunchReadinessWebMcp: vi.fn(),
}))

import { LaunchReadinessClient, type LaunchReadinessReport } from "./launch-readiness-client"

const COMMIT = "a".repeat(40)
const REPORT: LaunchReadinessReport = {
  state: "READY",
  verdict: "GO",
  score: null,
  triageScore: 100,
  summary: "Ready.",
  blockingFindings: 0,
  totalFindings: 0,
  verifiedFindings: 0,
  bySeverity: {},
  conditions: [],
  recommendations: [],
}

describe("LaunchReadinessClient triage relabel", () => {
  const inconclusive: LaunchReadinessReport = {
    ...REPORT,
    state: "INSUFFICIENT_EVIDENCE",
    verdict: "INCONCLUSIVE",
    triageScore: 100,
    summary: "No completed assessment evidence is available.",
  }

  it("renders a neutral (not green) gauge with zero scans", () => {
    const html = renderToStaticMarkup(
      <LaunchReadinessClient
        workspaceId="ws-1"
        initialReport={{ ...inconclusive, verdict: "NOT_EVALUATED", triageScore: null }}
        targets={[]}
        initialTargetId=""
        initialReleaseRef=""
        initialReleaseCheck={null}
        initialCheckError={null}
        checkNeedsTarget={false}
      />
    )

    // The ring stroke must not use the success colour even when a score is
    // absent, and the centre label reads Triage rather than Pending.
    expect(html).not.toContain('stroke="var(--color-success)"')
    expect(html).toContain("Triage")
    expect(html).not.toContain("Pending")
  })

  it("keeps the ring neutral when a triage score exists under an inconclusive verdict", () => {
    const html = renderToStaticMarkup(
      <LaunchReadinessClient
        workspaceId="ws-1"
        initialReport={inconclusive}
        targets={[{ targetId: "target-1", targetName: "API" }]}
        initialTargetId="target-1"
        initialReleaseRef=""
        initialReleaseCheck={null}
        initialCheckError={null}
        checkNeedsTarget={false}
      />
    )

    expect(html).not.toContain('stroke="var(--color-success)"')
    expect(html).toContain("Triage only — not a readiness score")
    expect(html).toContain("Insufficient current evidence")
    expect(html).not.toContain("Nothing Checked")
    expect(html).toContain("Triage counts open findings; it is not the launch verdict.")
  })

  it("still colours the ring for a conclusive verdict", () => {
    const html = renderToStaticMarkup(
      <LaunchReadinessClient
        workspaceId="ws-1"
        initialReport={REPORT}
        targets={[{ targetId: "target-1", targetName: "API" }]}
        initialTargetId="target-1"
        initialReleaseRef=""
        initialReleaseCheck={null}
        initialCheckError={null}
        checkNeedsTarget={false}
      />
    )

    expect(html).toContain('stroke="var(--color-success)"')
    expect(html).toContain("Triage only — not a readiness score")
  })
})

describe("LaunchReadinessClient release draft", () => {
  beforeEach(() => vi.clearAllMocks())

  it("renders the URL-backed release and auto-selected target in the form", () => {
    const html = renderToStaticMarkup(
      <LaunchReadinessClient
        workspaceId="ws-1"
        initialReport={REPORT}
        targets={[{ targetId: "target-1", targetName: "API" }]}
        initialTargetId="target-1"
        initialReleaseRef={COMMIT}
        initialReleaseCheck={null}
        initialCheckError={null}
        checkNeedsTarget={false}
      />
    )

    expect(html).toContain(`value="${COMMIT}"`)
    expect(html).toContain('<option value="target-1" selected="">API</option>')
  })

  it.each(["The newer scan failed.", "The newer scan is in progress."])(
    "keeps newer-attempt copy neutral when status is %s",
    (message) => {
      const html = renderToStaticMarkup(
        <LaunchReadinessClient
          workspaceId="ws-1"
          initialReport={{
            ...REPORT,
            state: "INSUFFICIENT_EVIDENCE",
            verdict: "INCONCLUSIVE",
            triageScore: null,
            summary: "Insufficient current evidence.",
          }}
          targets={[{ targetId: "target-1", targetName: "API" }]}
          initialTargetId="target-1"
          initialReleaseRef={COMMIT}
          initialReleaseCheck={{
            targetId: "target-1",
            targetName: "API",
            requested: { kind: "COMMIT", value: COMMIT },
            assessed: { kind: "COMMIT", value: COMMIT },
            match: "match",
            historicalState: "READY",
            state: "INSUFFICIENT_EVIDENCE",
            applicable: false,
            blockingFindings: 0,
            reasons: [{ code: "NEWER_ASSESSMENT_ATTEMPT", message }],
          }}
          initialCheckError={null}
          checkNeedsTarget={false}
        />
      )

      expect(html).toContain("previous verdict unavailable for this release")
      expect(html).toContain("Review the newer assessment")
      expect(html).not.toContain("still running")
      expect(html).not.toContain("in-progress assessment")
    }
  )
})
