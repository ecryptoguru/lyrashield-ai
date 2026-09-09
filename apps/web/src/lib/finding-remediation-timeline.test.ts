import { describe, expect, it } from "vitest"
import {
  buildRemediationTimeline,
  type TimelineFinding,
  type TimelineFixProposalInput,
  type TimelineRetestInput,
} from "./finding-remediation-timeline"

const baseFinding: TimelineFinding = {
  status: "OPEN",
  verified: false,
  verificationStatus: "DETECTED",
  lastSeenAt: "2026-09-01T00:00:00.000Z",
}

function proposal(overrides: Partial<TimelineFixProposalInput> = {}): TimelineFixProposalInput {
  return {
    id: "fp-1",
    status: "draft",
    summary: "Escape HTML output",
    createdAt: "2026-09-02T10:00:00.000Z",
    pullRequests: [],
    ...overrides,
  }
}

describe("buildRemediationTimeline (W3-03)", () => {
  it("assembles proposed -> PR opened -> merged -> retest passed -> verified in order", () => {
    const timeline = buildRemediationTimeline(
      {
        ...baseFinding,
        verificationStatus: "VERIFIED",
        verificationMethod: "deterministic_retest",
        verifiedAt: "2026-09-05T09:00:00.000Z",
      },
      [
        proposal({
          status: "pr_merged",
          createdAt: "2026-09-02T10:00:00.000Z",
          pullRequests: [
            {
              id: "pr-1",
              status: "merged",
              prNumber: 12,
              prUrl: "https://github.com/o/r/pull/12",
              branchName: "fix/xss",
              createdAt: "2026-09-03T09:00:00.000Z",
              mergedAt: "2026-09-04T09:00:00.000Z",
              closedAt: null,
            },
          ],
        }),
      ],
      [
        {
          id: "rt-1",
          status: "passed",
          scanId: "scan-retest",
          createdAt: "2026-09-05T09:00:00.000Z",
        },
      ]
    )

    expect(timeline.map((event) => event.kind)).toEqual([
      "PROPOSED",
      "PR_OPENED",
      "PR_MERGED",
      "RETEST_PASSED",
      "VERIFIED",
    ])
  })

  it("never infers applied from PR creation — only a mergedAt receipt produces PR_MERGED", () => {
    const timeline = buildRemediationTimeline(
      baseFinding,
      [
        proposal({
          status: "pr_opened",
          pullRequests: [
            {
              id: "pr-1",
              status: "open",
              prNumber: 12,
              prUrl: null,
              branchName: "fix/xss",
              createdAt: "2026-09-03T09:00:00.000Z",
              mergedAt: null,
              closedAt: null,
            },
          ],
        }),
      ],
      []
    )
    expect(timeline.map((event) => event.kind)).toEqual(["PROPOSED", "PR_OPENED"])
  })

  it("keeps a closed-unmerged PR truthful", () => {
    const timeline = buildRemediationTimeline(
      baseFinding,
      [
        proposal({
          status: "pr_closed",
          pullRequests: [
            {
              id: "pr-1",
              status: "closed",
              prNumber: 12,
              prUrl: null,
              branchName: "fix/xss",
              createdAt: "2026-09-03T09:00:00.000Z",
              mergedAt: null,
              closedAt: "2026-09-06T09:00:00.000Z",
            },
          ],
        }),
      ],
      []
    )
    expect(timeline.map((event) => event.kind)).toEqual([
      "PROPOSED",
      "PR_OPENED",
      "PR_CLOSED_UNMERGED",
    ])
    expect(timeline[2]!.tone).toBe("warning")
  })

  it("keeps failed retests truthful and never derives verification from engine absence", () => {
    const timeline = buildRemediationTimeline(
      baseFinding,
      [],
      [
        {
          id: "rt-1",
          status: "failed",
          scanId: "scan-retest",
          createdAt: "2026-09-05T09:00:00.000Z",
        },
      ]
    )
    expect(timeline.map((event) => event.kind)).toEqual(["RETEST_FAILED"])
    expect(timeline.some((event) => event.kind === "VERIFIED")).toBe(false)
  })

  it("sorts out-of-order stored events by timestamp", () => {
    const timeline = buildRemediationTimeline(
      baseFinding,
      [
        proposal({
          status: "pr_merged",
          createdAt: "2026-09-05T10:00:00.000Z",
          pullRequests: [
            {
              id: "pr-1",
              status: "merged",
              prNumber: 12,
              prUrl: null,
              branchName: "fix/xss",
              createdAt: "2026-09-03T09:00:00.000Z",
              mergedAt: "2026-09-04T09:00:00.000Z",
              closedAt: null,
            },
          ],
        }),
      ],
      []
    )
    expect(timeline.map((event) => event.kind)).toEqual(["PR_OPENED", "PR_MERGED", "PROPOSED"])
  })

  it("shows accepted-risk and false-positive dispositions separately from verification", () => {
    const accepted = buildRemediationTimeline(
      {
        ...baseFinding,
        status: "ACCEPTED_RISK",
        disposition: "ACCEPTED_RISK",
        dispositionReason: "Compensating control",
        dispositionAt: "2026-09-07T00:00:00.000Z",
      },
      [],
      []
    )
    expect(accepted.map((event) => event.kind)).toEqual(["DISPOSITION"])
    expect(accepted[0]!.label).toBe("Risk accepted")

    const falsePositive = buildRemediationTimeline(
      {
        ...baseFinding,
        status: "FALSE_POSITIVE",
        disposition: "FALSE_POSITIVE",
        dispositionAt: "2026-09-07T00:00:00.000Z",
      },
      [],
      []
    )
    expect(falsePositiveLabel(falsePositivePositive(falsePositive))).toBe("Marked false positive")
  })

  it("does not truncate: every stored receipt appears in the timeline", () => {
    const retests: TimelineRetestInput[] = Array.from({ length: 40 }, (_, index) => ({
      id: `rt-${index}`,
      status: index % 2 === 0 ? "passed" : "failed",
      scanId: `scan-${index}`,
      createdAt: new Date(Date.UTC(2026, 8, 1, index)).toISOString(),
    }))
    const timeline = buildRemediationTimeline(baseFinding, [], retests)
    expect(timeline).toHaveLength(40)
  })
})

function falsePositivePositive(events: { label: string }[]) {
  return events[0]!
}
function falsePositiveLabel(event: { label: string }) {
  return event.label
}
