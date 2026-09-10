import { describe, expect, it, vi } from "vitest"
import {
  buildUrlTargetPayload,
  displayStepForPath,
  ensureOnboardingTargetId,
  getOnboardingReviewOptions,
  nextStepForPath,
  onboardingPathForTargetType,
  pathLabel,
  pathNeedsRepo,
  stepModelForPath,
  targetNameFromUrl,
} from "./onboarding-flow.utils"

describe("onboardingPathForTargetType", () => {
  it("restores the onboarding path from an existing target", () => {
    expect(onboardingPathForTargetType("REPO")).toBe("github")
    expect(onboardingPathForTargetType("WEB_APP")).toBe("url")
    expect(onboardingPathForTargetType("API")).toBe("api")
    expect(onboardingPathForTargetType(null)).toBeNull()
  })
})

describe("ensureOnboardingTargetId", () => {
  it("reuses the persisted target when a failed scan is retried", async () => {
    const createTarget = vi.fn().mockResolvedValue("target-1")

    const firstTargetId = await ensureOnboardingTargetId(null, createTarget)
    const retryTargetId = await ensureOnboardingTargetId(firstTargetId, createTarget)

    expect(firstTargetId).toBe("target-1")
    expect(retryTargetId).toBe("target-1")
    expect(createTarget).toHaveBeenCalledOnce()
  })
})

describe("getOnboardingReviewOptions", () => {
  it("uses the canonical repository review choices and modes", () => {
    expect(
      getOnboardingReviewOptions("github").map(({ label, mode }) => ({ label, mode }))
    ).toEqual([
      { label: "Release check", mode: "QUICK" },
      { label: "Code review", mode: "STANDARD" },
      { label: "Deep security review", mode: "DEEP" },
    ])
  })

  it("uses URL-specific safe, standard, and deep choices", () => {
    expect(getOnboardingReviewOptions("url").map(({ label, mode }) => ({ label, mode }))).toEqual([
      { label: "Surface Review", mode: "SAFE" },
      { label: "Expanded Surface Review", mode: "STANDARD" },
      { label: "Behavioral Surface Review", mode: "DEEP" },
    ])
  })

  it("only offers the endpoint review for an API without an OpenAPI document", () => {
    expect(getOnboardingReviewOptions("api").map(({ label, mode }) => ({ label, mode }))).toEqual([
      { label: "Endpoint Review", mode: "SAFE" },
    ])
  })
})

describe("nextStepForPath", () => {
  it("sends GitHub to repo-select (step 2)", () => {
    expect(nextStepForPath("github")).toBe(2)
  })

  it("sends URL and API straight to target details (step 3)", () => {
    expect(nextStepForPath("url")).toBe(3)
    expect(nextStepForPath("api")).toBe(3)
  })

  it("sends skip out of the wizard (no onward step)", () => {
    expect(nextStepForPath("skip")).toBeNull()
  })
})

describe("stepModelForPath (v16 3.1 single source of truth)", () => {
  it("gives the GitHub flow chooser, repo-select, and details", () => {
    expect(stepModelForPath("github").map((entry) => [entry.index, entry.label])).toEqual([
      [1, "Add target"],
      [2, "Select repository"],
      [3, "Target details"],
    ])
  })

  it("gives the URL and API flows chooser and details — no repo-select", () => {
    expect(stepModelForPath("url").map((entry) => [entry.index, entry.label])).toEqual([
      [1, "Add target"],
      [3, "Target details"],
    ])
    expect(stepModelForPath("api").map((entry) => [entry.index, entry.label])).toEqual(
      stepModelForPath("url").map((entry) => [entry.index, entry.label])
    )
  })

  it("falls back to the three-step model while the path is unset", () => {
    // Step 2 is only reachable through the GitHub connect redirect, so the
    // unknown-path list must still contain it (the old "Step 3 of 2" bug).
    expect(stepModelForPath(null)).toHaveLength(3)
    expect(stepModelForPath("skip")).toHaveLength(3)
  })

  it("keeps the onward step inside the rendered list for every flow", () => {
    for (const path of ["github", "url", "api"] as const) {
      const model = stepModelForPath(path)
      const onward = nextStepForPath(path)
      expect(onward).not.toBeNull()
      expect(model.some((entry) => entry.index === onward)).toBe(true)
    }
  })
})

describe("displayStepForPath (v16 3.1 progress indicator)", () => {
  it("highlights the right item for every rendered step", () => {
    // GitHub flow: chooser, repo-select, details are items 0, 1, 2.
    expect(displayStepForPath(1, "github")).toBe(0)
    expect(displayStepForPath(2, "github")).toBe(1)
    expect(displayStepForPath(3, "github")).toBe(2)
    // URL/API flow: the details step is the SECOND item — the old code
    // announced "Step 3 of 2" here.
    expect(displayStepForPath(1, "url")).toBe(0)
    expect(displayStepForPath(3, "url")).toBe(1)
    expect(displayStepForPath(3, "api")).toBe(1)
  })

  it("clamps an unknown step into the rendered range instead of pointing past it", () => {
    expect(displayStepForPath(4, "url")).toBe(1)
    expect(displayStepForPath(99, "github")).toBe(2)
    expect(displayStepForPath(0, "github")).toBe(0)
  })
})

describe("pathNeedsRepo", () => {
  it("requires a repo only for the GitHub path", () => {
    expect(pathNeedsRepo("github")).toBe(true)
    expect(pathNeedsRepo("url")).toBe(false)
    expect(pathNeedsRepo("api")).toBe(false)
    expect(pathNeedsRepo("skip")).toBe(false)
    expect(pathNeedsRepo(null)).toBe(false)
  })
})

describe("buildUrlTargetPayload", () => {
  const base = {
    workspaceId: "ws-1",
    name: "Staging Site",
    url: "https://staging.example.com",
    environment: "STAGING",
    ownershipAttested: true,
  }

  it("builds a WEB_APP payload for the url path", () => {
    expect(buildUrlTargetPayload({ ...base, path: "url" })).toEqual({
      workspaceId: "ws-1",
      type: "WEB_APP",
      name: "Staging Site",
      url: "https://staging.example.com",
      environment: "STAGING",
      ownershipAttested: true,
    })
  })

  it("builds an API payload for the api path", () => {
    expect(buildUrlTargetPayload({ ...base, path: "api", name: "Production API" })).toEqual({
      workspaceId: "ws-1",
      type: "API",
      name: "Production API",
      url: "https://staging.example.com",
      environment: "STAGING",
      ownershipAttested: true,
    })
  })

  it("trims name and url", () => {
    const payload = buildUrlTargetPayload({
      ...base,
      path: "url",
      name: "  My App  ",
      url: "  https://app.example.com  ",
    })
    expect(payload?.name).toBe("My App")
    expect(payload?.url).toBe("https://app.example.com")
  })

  it("refuses to build when ownership is not attested (the API rejects it too)", () => {
    expect(buildUrlTargetPayload({ ...base, path: "url", ownershipAttested: false })).toBeNull()
  })

  it("refuses when name or url is blank", () => {
    expect(buildUrlTargetPayload({ ...base, path: "url", name: "  " })).toBeNull()
    expect(buildUrlTargetPayload({ ...base, path: "url", url: "" })).toBeNull()
  })

  it("refuses without a workspace", () => {
    expect(buildUrlTargetPayload({ ...base, path: "url", workspaceId: null })).toBeNull()
  })

  it("never builds a URL target for the github or skip paths", () => {
    expect(buildUrlTargetPayload({ ...base, path: "github" })).toBeNull()
    expect(buildUrlTargetPayload({ ...base, path: "skip" })).toBeNull()
    expect(buildUrlTargetPayload({ ...base, path: null })).toBeNull()
  })
})

describe("pathLabel", () => {
  it("labels each path", () => {
    expect(pathLabel("github")).toBe("GitHub repository")
    expect(pathLabel("url")).toBe("web app")
    expect(pathLabel("api")).toBe("API")
    expect(pathLabel("skip")).toBe("later")
    expect(pathLabel(null)).toBe("target")
  })
})

describe("targetNameFromUrl (W2-02)", () => {
  it("prefills the target name from the parsed host", () => {
    expect(targetNameFromUrl("https://staging.example.com/path")).toBe("staging.example.com")
    expect(targetNameFromUrl("https://www.example.com/app")).toBe("example.com")
    expect(targetNameFromUrl("http://api.example.com/v1")).toBe("api.example.com")
  })

  it("keeps the current name when no sensible prefill exists", () => {
    expect(targetNameFromUrl("not a url")).toBeNull()
    expect(targetNameFromUrl("ftp://example.com")).toBeNull()
    expect(targetNameFromUrl("")).toBeNull()
  })
})
