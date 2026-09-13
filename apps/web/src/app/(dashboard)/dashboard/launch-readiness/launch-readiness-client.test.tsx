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
})
