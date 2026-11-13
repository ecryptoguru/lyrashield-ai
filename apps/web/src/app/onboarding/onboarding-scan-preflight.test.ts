import { describe, expect, it, vi } from "vitest"
import { urlTargetFieldError } from "./onboarding-flow.utils"
import { preflightScanStart } from "./onboarding-scan-preflight"
import type { Repo } from "./onboarding-step-views"
import type { OnboardingData } from "./onboarding-wizard-model"

const emptyAccount: OnboardingData = {
  currentStep: 3,
  completed: false,
  skipped: false,
  workspaceId: null,
  targetId: null,
  selectedGoal: null,
}

function context(overrides: {
  data?: Partial<OnboardingData>
  path?: "github" | "url" | "api" | "skip" | null
  selectedRepo?: Repo | null
  productName?: string
  url?: string
  ownershipAttested?: boolean
  persistedTargetReusable?: boolean
  ensureWorkspace?: () => Promise<string>
}) {
  return {
    data: { ...emptyAccount, ...(overrides.data ?? {}) },
    path: overrides.path ?? "url",
    selectedRepo: overrides.selectedRepo ?? null,
    productName: overrides.productName ?? "example.com",
    urlForm: {
      url: overrides.url ?? "https://example.com",
      ownershipAttested: overrides.ownershipAttested ?? true,
    },
    persistedTargetReusable: overrides.persistedTargetReusable ?? false,
    ensureWorkspace: overrides.ensureWorkspace ?? (async () => "ws-new"),
  }
}

const repo: Repo = {
  id: 42,
  fullName: "acme/app",
  name: "app",
  owner: "acme",
  defaultBranch: "main",
  private: false,
  htmlUrl: "https://github.com/acme/app",
  installationId: "inst-1",
}

describe("urlTargetFieldError", () => {
  it("asks for a name and URL before attestation", () => {
    expect(
      urlTargetFieldError({
        path: "url",
        name: "  ",
        url: "https://example.com",
        ownershipAttested: false,
      })
    ).toBe("Enter a name and a valid URL to continue.")
    expect(
      urlTargetFieldError({
        path: "api",
        name: "Production API",
        url: "",
        ownershipAttested: false,
      })
    ).toBe("Enter a name and a valid URL to continue.")
  })

  it("asks for attestation when the source is complete", () => {
    expect(
      urlTargetFieldError({
        path: "url",
        name: "example.com",
        url: "https://example.com",
        ownershipAttested: false,
      })
    ).toBe("Confirm you own or are authorized to scan this target.")
  })

  it("accepts a complete, attested URL or API form", () => {
    expect(
      urlTargetFieldError({
        path: "url",
        name: "example.com",
        url: "https://example.com",
        ownershipAttested: true,
      })
    ).toBeNull()
    expect(
      urlTargetFieldError({
        path: "api",
        name: "Production API",
        url: "https://api.example.com",
        ownershipAttested: true,
      })
    ).toBeNull()
  })

  it("abstains for the repository and skip paths", () => {
    for (const path of ["github", "skip", null] as const) {
      expect(urlTargetFieldError({ path, name: "", url: "", ownershipAttested: false })).toBeNull()
    }
  })
})

describe("preflightScanStart (P1-1: validate before creating a workspace)", () => {
  it("creates no workspace when the URL form is incomplete", async () => {
    const ensureWorkspace = vi.fn(async () => "ws-new")
    const result = await preflightScanStart(context({ productName: "", ensureWorkspace }))

    expect(result).toEqual({ ok: false, error: "Enter a name and a valid URL to continue." })
    expect(ensureWorkspace).not.toHaveBeenCalled()
  })

  it("creates no workspace when ownership is not attested", async () => {
    const ensureWorkspace = vi.fn(async () => "ws-new")
    const result = await preflightScanStart(context({ ownershipAttested: false, ensureWorkspace }))

    expect(result).toEqual({
      ok: false,
      error: "Confirm you own or are authorized to scan this target.",
    })
    expect(ensureWorkspace).not.toHaveBeenCalled()
  })

  it("creates no workspace when the repository path has no repository", async () => {
    const ensureWorkspace = vi.fn(async () => "ws-new")
    const result = await preflightScanStart(
      context({
        path: "github",
        productName: "",
        url: "",
        ownershipAttested: false,
        ensureWorkspace,
      })
    )

    expect(result).toEqual({ ok: false, error: "Workspace and repository are required." })
    expect(ensureWorkspace).not.toHaveBeenCalled()
  })

  it("resolves the workspace for a valid URL form", async () => {
    const result = await preflightScanStart(context({}))

    expect(result).toEqual({
      ok: true,
      workspaceId: "ws-new",
      hasExistingTarget: false,
      needsRepo: false,
    })
  })

  it("skips the source checks when the persisted target is still reusable", async () => {
    const result = await preflightScanStart(
      context({
        data: { targetId: "target-1", targetType: "WEB_APP" },
        productName: "",
        url: "",
        ownershipAttested: false,
        persistedTargetReusable: true,
      })
    )

    expect(result).toEqual({
      ok: true,
      workspaceId: "ws-new",
      hasExistingTarget: true,
      needsRepo: false,
    })
  })

  it("treats a selected repository as repository evidence without the GitHub path", async () => {
    const result = await preflightScanStart(
      context({
        path: null,
        selectedRepo: repo,
        url: "",
        ownershipAttested: false,
      })
    )

    expect(result).toEqual({
      ok: true,
      workspaceId: "ws-new",
      hasExistingTarget: false,
      needsRepo: true,
    })
  })

  it("asks for the target name when a repository is selected without one", async () => {
    const result = await preflightScanStart(
      context({
        path: null,
        selectedRepo: repo,
        productName: "",
        url: "",
        ownershipAttested: false,
      })
    )

    expect(result).toEqual({ ok: false, error: "Name your target to continue." })
  })

  it("reports the workspace failure instead of throwing", async () => {
    const result = await preflightScanStart(
      context({
        ensureWorkspace: async () => {
          throw new Error("Could not prepare your workspace.")
        },
      })
    )

    expect(result).toEqual({ ok: false, error: "Could not prepare your workspace." })
  })

  it("reuses the persisted workspace without creating another one", async () => {
    const ensureWorkspace = vi.fn(async () => "ws-second")
    const result = await preflightScanStart(
      context({ data: { workspaceId: "ws-first" }, ensureWorkspace })
    )

    expect(result).toMatchObject({ ok: true, workspaceId: "ws-first" })
    expect(ensureWorkspace).not.toHaveBeenCalled()
  })
})
