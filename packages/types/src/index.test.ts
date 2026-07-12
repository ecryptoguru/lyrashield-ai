import { describe, it, expect } from "vitest"
import {
  OnboardingStepSchema,
  UpdateOnboardingSchema,
  WorkspaceModeSchema,
  WorkspacePlanSchema,
  MemberRoleSchema,
  TargetTypeSchema,
  TargetEnvironmentSchema,
  ScanGoalSchema,
  ScanModeSchema,
  ScanStatusSchema,
  FindingSeveritySchema,
  FindingStatusSchema,
  IntegrationTypeSchema,
  CreateWorkspaceSchema,
  CreateProjectSchema,
  CreateRepoTargetSchema,
  CreateUrlTargetSchema,
} from "./index"

describe("OnboardingStepSchema", () => {
  it("accepts all 7 valid step values", () => {
    const validSteps = ["WORKSPACE", "TARGET", "GOAL", "PREFLIGHT", "SCAN", "RESULTS", "FIX"]
    for (const step of validSteps) {
      expect(OnboardingStepSchema.safeParse(step).success).toBe(true)
    }
  })

  it("rejects invalid step value", () => {
    expect(OnboardingStepSchema.safeParse("INVALID").success).toBe(false)
  })

  it("rejects empty string", () => {
    expect(OnboardingStepSchema.safeParse("").success).toBe(false)
  })

  it("rejects lowercase", () => {
    expect(OnboardingStepSchema.safeParse("workspace").success).toBe(false)
  })
})

describe("UpdateOnboardingSchema", () => {
  it("accepts empty object (all fields optional)", () => {
    expect(UpdateOnboardingSchema.safeParse({}).success).toBe(true)
  })

  it("accepts valid currentStep in range 0-6", () => {
    for (let i = 0; i <= 6; i++) {
      expect(UpdateOnboardingSchema.safeParse({ currentStep: i }).success).toBe(true)
    }
  })

  it("rejects currentStep < 0", () => {
    expect(UpdateOnboardingSchema.safeParse({ currentStep: -1 }).success).toBe(false)
  })

  it("rejects currentStep > 6", () => {
    expect(UpdateOnboardingSchema.safeParse({ currentStep: 7 }).success).toBe(false)
  })

  it("rejects non-integer currentStep", () => {
    expect(UpdateOnboardingSchema.safeParse({ currentStep: 2.5 }).success).toBe(false)
  })

  it("accepts completed boolean", () => {
    expect(UpdateOnboardingSchema.safeParse({ completed: true }).success).toBe(true)
    expect(UpdateOnboardingSchema.safeParse({ completed: false }).success).toBe(true)
  })

  it("accepts skipped boolean", () => {
    expect(UpdateOnboardingSchema.safeParse({ skipped: true }).success).toBe(true)
    expect(UpdateOnboardingSchema.safeParse({ skipped: false }).success).toBe(true)
  })

  it("accepts workspaceId string", () => {
    expect(UpdateOnboardingSchema.safeParse({ workspaceId: "ws-123" }).success).toBe(true)
  })

  it("accepts workspaceId null", () => {
    expect(UpdateOnboardingSchema.safeParse({ workspaceId: null }).success).toBe(true)
  })

  it("accepts targetId string", () => {
    expect(UpdateOnboardingSchema.safeParse({ targetId: "tgt-456" }).success).toBe(true)
  })

  it("accepts targetId null", () => {
    expect(UpdateOnboardingSchema.safeParse({ targetId: null }).success).toBe(true)
  })

  it("accepts valid selectedGoal", () => {
    const validGoals = [
      "CHECK_PR",
      "TEST_APP",
      "LAUNCH_REVIEW",
      "WEEKLY_MONITOR",
      "FULL_PENTEST",
      "COMPLIANCE_REVIEW",
    ]
    for (const goal of validGoals) {
      expect(UpdateOnboardingSchema.safeParse({ selectedGoal: goal }).success).toBe(true)
    }
  })

  it("accepts selectedGoal null", () => {
    expect(UpdateOnboardingSchema.safeParse({ selectedGoal: null }).success).toBe(true)
  })

  it("rejects invalid selectedGoal", () => {
    expect(UpdateOnboardingSchema.safeParse({ selectedGoal: "INVALID_GOAL" }).success).toBe(false)
  })

  it("accepts full valid update", () => {
    const update = {
      currentStep: 3,
      completed: false,
      skipped: false,
      workspaceId: "ws-abc",
      targetId: "tgt-xyz",
      selectedGoal: "CHECK_PR",
    }
    expect(UpdateOnboardingSchema.safeParse(update).success).toBe(true)
  })

  it("rejects non-boolean completed", () => {
    expect(UpdateOnboardingSchema.safeParse({ completed: "yes" }).success).toBe(false)
  })

  it("rejects non-string workspaceId", () => {
    expect(UpdateOnboardingSchema.safeParse({ workspaceId: 123 }).success).toBe(false)
  })
})

// ── Enum-parity tests (Zod schemas vs Prisma enums) ──────────────────
// These values must match the Prisma schema enums exactly.
// If a migration adds/removes an enum value, this test will catch the drift.

describe("Enum parity (Zod vs Prisma)", () => {
  it("WorkspaceModeSchema matches Prisma enum", () => {
    expect(WorkspaceModeSchema.options).toEqual(["VIBE", "TEAM", "ENTERPRISE"])
  })

  it("WorkspacePlanSchema matches Prisma enum", () => {
    expect(WorkspacePlanSchema.options).toEqual([
      "FREE",
      "PRO",
      "TEAM",
      "AGENCY",
      "BUSINESS",
      "ENTERPRISE",
    ])
  })

  it("MemberRoleSchema matches Prisma enum", () => {
    expect(MemberRoleSchema.options).toEqual([
      "OWNER",
      "ADMIN",
      "MEMBER",
      "VIEWER",
      "SECURITY_ADMIN",
      "APPSEC_MANAGER",
      "DEVELOPER",
      "AUDITOR",
      "BILLING_ADMIN",
      "EXTERNAL_PENTESTER",
    ])
  })

  it("TargetTypeSchema matches Prisma enum", () => {
    expect(TargetTypeSchema.options).toEqual([
      "REPO",
      "WEB_APP",
      "API",
      "CLOUD_ACCOUNT",
      "CONTAINER",
      "IAC",
    ])
  })

  it("TargetEnvironmentSchema matches Prisma enum", () => {
    expect(TargetEnvironmentSchema.options).toEqual(["LOCAL", "PREVIEW", "STAGING", "PRODUCTION"])
  })

  it("ScanGoalSchema matches Prisma enum", () => {
    expect(ScanGoalSchema.options).toEqual([
      "CHECK_PR",
      "TEST_APP",
      "LAUNCH_REVIEW",
      "WEEKLY_MONITOR",
      "FULL_PENTEST",
      "COMPLIANCE_REVIEW",
    ])
  })

  it("ScanModeSchema matches Prisma enum", () => {
    expect(ScanModeSchema.options).toEqual(["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"])
  })

  it("ScanStatusSchema matches Prisma enum", () => {
    expect(ScanStatusSchema.options).toEqual([
      "QUEUED",
      "PREFLIGHT",
      "RUNNING",
      "VERIFYING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "REQUIRES_APPROVAL",
      "STOPPED_BUDGET",
      "TIMED_OUT",
    ])
  })

  it("FindingSeveritySchema matches Prisma enum", () => {
    expect(FindingSeveritySchema.options).toEqual(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"])
  })

  it("FindingStatusSchema matches Prisma enum", () => {
    expect(FindingStatusSchema.options).toEqual([
      "OPEN",
      "FIX_READY",
      "PR_OPENED",
      "TICKET_CREATED",
      "FIXED_PENDING_RETEST",
      "FIXED",
      "ACCEPTED_RISK",
      "FALSE_POSITIVE",
      "DUPLICATE",
    ])
  })

  it("IntegrationTypeSchema matches Prisma enum", () => {
    expect(IntegrationTypeSchema.options).toEqual([
      "GITHUB",
      "GITLAB",
      "AZURE_DEVOPS",
      "SLACK",
      "DISCORD",
      "JIRA",
      "LINEAR",
      "TEAMS",
      "SERVICENOW",
      "SPLUNK",
      "DATADOG",
      "SENTINEL",
      "VANTA",
      "DRATA",
    ])
  })
})

// ── Input validation tests ───────────────────────────────────────────

describe("CreateWorkspaceSchema", () => {
  it("accepts valid input", () => {
    expect(CreateWorkspaceSchema.safeParse({ name: "My Workspace" }).success).toBe(true)
  })

  it("trims whitespace from name", () => {
    const result = CreateWorkspaceSchema.safeParse({ name: "  My Workspace  " })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe("My Workspace")
    }
  })

  it("rejects empty name", () => {
    expect(CreateWorkspaceSchema.safeParse({ name: "" }).success).toBe(false)
  })

  it("rejects name with control characters", () => {
    expect(CreateWorkspaceSchema.safeParse({ name: "test\u0000" }).success).toBe(false)
  })

  it("rejects name over 100 chars", () => {
    expect(CreateWorkspaceSchema.safeParse({ name: "a".repeat(101) }).success).toBe(false)
  })
})

describe("CreateProjectSchema", () => {
  it("accepts valid input", () => {
    expect(CreateProjectSchema.safeParse({ workspaceId: "ws-1", name: "My Project" }).success).toBe(
      true
    )
  })

  it("rejects empty name", () => {
    expect(CreateProjectSchema.safeParse({ workspaceId: "ws-1", name: "" }).success).toBe(false)
  })

  it("rejects name with control characters", () => {
    expect(CreateProjectSchema.safeParse({ workspaceId: "ws-1", name: "test\u0001" }).success).toBe(
      false
    )
  })
})

describe("CreateRepoTargetSchema", () => {
  it("accepts valid input", () => {
    expect(
      CreateRepoTargetSchema.safeParse({
        workspaceId: "ws-1",
        type: "REPO",
        name: "My Repo",
        repoOwner: "ecryptoguru",
        repoName: "lyrashield-ai",
      }).success
    ).toBe(true)
  })

  it("rejects repoOwner with invalid characters", () => {
    expect(
      CreateRepoTargetSchema.safeParse({
        workspaceId: "ws-1",
        type: "REPO",
        name: "My Repo",
        repoOwner: "invalid owner!",
        repoName: "lyrashield-ai",
      }).success
    ).toBe(false)
  })

  it("rejects repoName with invalid characters", () => {
    expect(
      CreateRepoTargetSchema.safeParse({
        workspaceId: "ws-1",
        type: "REPO",
        name: "My Repo",
        repoOwner: "ecryptoguru",
        repoName: "invalid name!",
      }).success
    ).toBe(false)
  })

  it("accepts branch with max 255 chars", () => {
    expect(
      CreateRepoTargetSchema.safeParse({
        workspaceId: "ws-1",
        type: "REPO",
        name: "My Repo",
        repoOwner: "ecryptoguru",
        repoName: "lyrashield-ai",
        branch: "a".repeat(255),
      }).success
    ).toBe(true)
  })

  it("rejects branch over 255 chars", () => {
    expect(
      CreateRepoTargetSchema.safeParse({
        workspaceId: "ws-1",
        type: "REPO",
        name: "My Repo",
        repoOwner: "ecryptoguru",
        repoName: "lyrashield-ai",
        branch: "a".repeat(256),
      }).success
    ).toBe(false)
  })
})

describe("CreateUrlTargetSchema", () => {
  it("accepts valid WEB_APP input", () => {
    expect(
      CreateUrlTargetSchema.safeParse({
        workspaceId: "ws-1",
        type: "WEB_APP",
        name: "My App",
        url: "https://example.com",
      }).success
    ).toBe(true)
  })

  it("accepts valid API input", () => {
    expect(
      CreateUrlTargetSchema.safeParse({
        workspaceId: "ws-1",
        type: "API",
        name: "My API",
        url: "https://api.example.com",
      }).success
    ).toBe(true)
  })

  it("rejects invalid URL", () => {
    expect(
      CreateUrlTargetSchema.safeParse({
        workspaceId: "ws-1",
        type: "WEB_APP",
        name: "My App",
        url: "not-a-url",
      }).success
    ).toBe(false)
  })

  it("rejects name with control characters", () => {
    expect(
      CreateUrlTargetSchema.safeParse({
        workspaceId: "ws-1",
        type: "WEB_APP",
        name: "test\u007F",
        url: "https://example.com",
      }).success
    ).toBe(false)
  })
})
