import { describe, expect, it } from "vitest"
import {
  appendDigestLine,
  buildRoutineDigest,
  classifyNotificationPriority,
  isCriticalNotification,
  routineGroupDedupeKey,
} from "./notification-grouping"

describe("notification grouping policy (W3-06)", () => {
  it("classifies critical actionable signals as critical", () => {
    expect(classifyNotificationPriority("scan.failed")).toBe("critical")
    expect(classifyNotificationPriority("finding.critical")).toBe("critical")
    expect(classifyNotificationPriority("connection.failed")).toBe("critical")
    expect(classifyNotificationPriority("automation.blocked")).toBe("critical")
    expect(isCriticalNotification("budget.exhausted")).toBe(true)
  })

  it("classifies routine completions as groupable", () => {
    expect(classifyNotificationPriority("scan.completed")).toBe("routine")
    expect(isCriticalNotification("scan.completed")).toBe(false)
  })

  it("never classifies unknown types as critical", () => {
    expect(classifyNotificationPriority("something.new")).toBe("routine")
  })

  it("builds a bounded digest with an explicit overflow note", () => {
    const digest = buildRoutineDigest({
      groupType: "scan completions",
      windowLabel: "Recent scan completions",
      items: Array.from({ length: 14 }, (_, index) => ({
        title: `Scan Completed — ${index}`,
        detail: `scan-${index}`,
      })),
      maxEntries: 10,
    })
    const lines = digest.body.split("\n").filter((line) => line.startsWith("• "))
    expect(lines).toHaveLength(10)
    expect(digest.body).toContain("…and 4 more in this window")
    expect(digest.title).toContain("14 updates")
  })

  it("appends receipts without erasing earlier events and ignores duplicate retries", () => {
    const first = buildRoutineDigest({
      groupType: "scan completions",
      windowLabel: "Recent scan completions",
      items: [{ title: "Scan Completed — 3 findings", detail: "scan-a" }],
    })
    const second = appendDigestLine(first.body, "• Scan Completed — 0 findings — scan-b")
    expect(second).toContain("scan-a")
    expect(second).toContain("scan-b")

    // Webhook/worker retry of the same event: no duplicate line, no growth.
    const retried = appendDigestLine(second, "• Scan Completed — 0 findings — scan-b")
    expect(retried).toBe(second)
  })

  it("keeps the digest entry list bounded as events accumulate", () => {
    let body = buildRoutineDigest({
      groupType: "scan completions",
      windowLabel: "Recent scan completions",
      items: [{ title: "Scan Completed — 1 finding", detail: "scan-0" }],
    }).body
    for (let index = 1; index <= 15; index++) {
      body = appendDigestLine(body, `• Scan Completed — scan-${index}`)
    }
    const entries = body.split("\n").filter((line) => line.startsWith("• "))
    expect(entries.length).toBeLessThanOrEqual(10)
    expect(body).toContain("…and ")
  })

  it("derives stable group dedupe keys per workspace+group+window", () => {
    const key = routineGroupDedupeKey({
      workspaceId: "ws-1",
      groupType: "scan completions",
      windowKey: "2026-09-09T07",
    })
    expect(key).toBe(
      routineGroupDedupeKey({
        workspaceId: "ws-1",
        groupType: "scan completions",
        windowKey: "2026-09-09T07",
      })
    )
    expect(key).not.toBe(
      routineGroupDedupeKey({
        workspaceId: "ws-1",
        groupType: "scan completions",
        windowKey: "2026-09-09T08",
      })
    )
    expect(key).not.toBe(
      routineGroupDedupeKey({
        workspaceId: "ws-2",
        groupType: "scan completions",
        windowKey: "2026-09-09T07",
      })
    )
  })
})
