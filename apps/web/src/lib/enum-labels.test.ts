import { describe, expect, it } from "vitest"
import {
  describeEnum,
  getEnvironmentKindLabel,
  getFindingSeverityLabel,
  getFindingStatusLabel,
  getScanGoalLabel,
  getScanModeLabel,
  getScanStatusLabel,
  getScanTriggerLabel,
  getTargetTypeLabel,
  getVerificationStatusLabel,
  getWorkspacePlanLabel,
} from "./enum-labels"

// One case per enum family (v16 3.2): the label maps are the single place a
// raw SCREAMING_SNAKE value becomes words a user reads, so every family needs
// at least one pinned example — plus the unknown-value fallback each getter
// promises.
describe("enum labels", () => {
  it("labels scan goals with the canonical review nouns", () => {
    expect(getScanGoalLabel("LAUNCH_REVIEW")).toBe("Release check")
    expect(getScanGoalLabel("SECURITY_REVIEW")).toBe("Security review")
    expect(getScanGoalLabel("TEST_APP")).toBe("Code review")
    expect(getScanGoalLabel("NOT_A_GOAL")).toBe("NOT_A_GOAL")
  })

  it("labels scan modes", () => {
    expect(getScanModeLabel("SAFE")).toBe("Safe")
    expect(getScanModeLabel("QUICK")).toBe("Quick")
    expect(getScanModeLabel("STANDARD")).toBe("Standard")
    expect(getScanModeLabel("DEEP")).toBe("Deep")
    expect(getScanModeLabel("CUSTOM")).toBe("Custom")
    expect(getScanModeLabel("NOPE")).toBe("NOPE")
  })

  it("labels scan triggers", () => {
    expect(getScanTriggerLabel("manual")).toBe("Manual")
    expect(getScanTriggerLabel("other")).toBe("other")
  })

  it("labels finding severities and statuses", () => {
    expect(getFindingSeverityLabel("CRITICAL")).toBe("Critical")
    expect(getFindingStatusLabel("FIX_PENDING_TEST")).toBe("FIX PENDING TEST")
    expect(getFindingStatusLabel("FIXED")).toBe("Fixed")
  })

  it("labels verification statuses", () => {
    expect(getVerificationStatusLabel("VERIFIED")).toBe("Independently verified")
    expect(getVerificationStatusLabel("MYSTERY")).toBe("MYSTERY")
  })

  it("labels target types", () => {
    expect(getTargetTypeLabel("WEB_APP")).toBe("Web app")
    expect(getTargetTypeLabel("API")).toBe("API")
    expect(getTargetTypeLabel("REPO")).toBe("Repository")
    expect(getTargetTypeLabel("SATELLITE")).toBe("SATELLITE")
  })

  it("labels every scan status the schema can emit", () => {
    expect(getScanStatusLabel("QUEUED")).toBe("Queued")
    expect(getScanStatusLabel("PREFLIGHT")).toBe("Checking setup")
    expect(getScanStatusLabel("RUNNING")).toBe("Scanning")
    expect(getScanStatusLabel("VERIFYING")).toBe("Verifying evidence")
    expect(getScanStatusLabel("COMPLETED")).toBe("Completed")
    expect(getScanStatusLabel("FAILED")).toBe("Failed")
    expect(getScanStatusLabel("CANCELLED")).toBe("Cancelled")
    expect(getScanStatusLabel("REQUIRES_APPROVAL")).toBe("Approval required")
    expect(getScanStatusLabel("STOPPED_BUDGET")).toBe("Stopped by budget")
    expect(getScanStatusLabel("TIMED_OUT")).toBe("Timed out")
    expect(getScanStatusLabel("UNHEARD_OF")).toBe("UNHEARD OF")
  })

  it("labels environments (TargetEnvironment / EnvironmentKind)", () => {
    expect(getEnvironmentKindLabel("STAGING")).toBe("Staging")
    expect(getEnvironmentKindLabel("PRODUCTION")).toBe("Production")
    expect(getEnvironmentKindLabel("LOCAL")).toBe("Local")
    expect(getEnvironmentKindLabel("PREVIEW")).toBe("Preview")
  })

  it("labels every workspace plan", () => {
    expect(getWorkspacePlanLabel("FREE")).toBe("Free")
    expect(getWorkspacePlanLabel("TRIAL")).toBe("Trial")
    expect(getWorkspacePlanLabel("STARTER")).toBe("Starter")
    expect(getWorkspacePlanLabel("PRO")).toBe("Pro")
    expect(getWorkspacePlanLabel("LAUNCH_ASSURANCE")).toBe("Launch Assurance")
    expect(getWorkspacePlanLabel("ENTERPRISE")).toBe("Enterprise")
  })
})

describe("describeEnum", () => {
  it("resolves a value from any family without the caller knowing the enum", () => {
    expect(describeEnum("WEB_APP")).toBe("Web app")
    expect(describeEnum("DEEP")).toBe("Deep")
    expect(describeEnum("LAUNCH_REVIEW")).toBe("Release check")
    expect(describeEnum("STOPPED_BUDGET")).toBe("Stopped by budget")
    expect(describeEnum("STAGING")).toBe("Staging")
    expect(describeEnum("LAUNCH_ASSURANCE")).toBe("Launch Assurance")
  })

  it("returns undefined for values no family knows", () => {
    expect(describeEnum("TOTALLY_UNKNOWN")).toBeUndefined()
  })
})
