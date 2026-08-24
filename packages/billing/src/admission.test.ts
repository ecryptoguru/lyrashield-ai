import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  deploymentEnvironment: "production",
  stagingAdmission: "off",
  stagingAccessToken: "s".repeat(32),
  appUrl: "https://lyrashield-billing-staging.examplehash.centralindia.azurecontainerapps.io",
  polarEnvironment: "sandbox",
  razorpayKeyId: "rzp_test_example",
}))

vi.mock("@lyrashield/config", () => ({
  billingStagingConfigError: (value: Record<string, string>) => {
    if (value.BILLING_STAGING_ADMISSION === "off") return null
    if (value.LYRASHIELD_DEPLOYMENT_ENVIRONMENT !== "billing-staging") return "wrong environment"
    return null
  },
  env: {
    POLAR_BILLING_ADMISSION: "off",
    RAZORPAY_BILLING_ADMISSION: "off",
    BILLING_CANARY_WORKSPACE_IDS: "",
    POLAR_LOCAL_BILLING_ADMISSION: "off",
    RAZORPAY_LOCAL_BILLING_ADMISSION: "off",
    NODE_ENV: "production",
    get LYRASHIELD_DEPLOYMENT_ENVIRONMENT() {
      return mocks.deploymentEnvironment
    },
    get BILLING_STAGING_ADMISSION() {
      return mocks.stagingAdmission
    },
    get BILLING_STAGING_ACCESS_TOKEN() {
      return mocks.stagingAccessToken
    },
    get NEXT_PUBLIC_APP_URL() {
      return mocks.appUrl
    },
    get POLAR_ENVIRONMENT() {
      return mocks.polarEnvironment
    },
    get RAZORPAY_KEY_ID() {
      return mocks.razorpayKeyId
    },
  },
}))

import {
  evaluateBillingAdmission,
  getBillingAdmission,
  getLocalBillingAdmission,
} from "./admission"

describe("billing admission", () => {
  beforeEach(() => {
    mocks.deploymentEnvironment = "production"
    mocks.stagingAdmission = "off"
    mocks.stagingAccessToken = "s".repeat(32)
    mocks.polarEnvironment = "sandbox"
    mocks.razorpayKeyId = "rzp_test_example"
  })

  it("fails closed when a provider is off", () => {
    expect(
      evaluateBillingAdmission({
        mode: "off",
        workspaceId: "workspace-a",
        canaryWorkspaceIds: "workspace-a",
      })
    ).toEqual({ allowed: false, mode: "off", reason: "provider_off" })
  })

  it("admits only exact canary workspace IDs", () => {
    const input = { mode: "canary" as const, canaryWorkspaceIds: "workspace-a,workspace-b" }
    expect(evaluateBillingAdmission({ ...input, workspaceId: "workspace-a" }).allowed).toBe(true)
    expect(evaluateBillingAdmission({ ...input, workspaceId: "workspace" }).allowed).toBe(false)
  })

  it("fails closed on malformed canary input", () => {
    for (const canaryWorkspaceIds of ["workspace-a,,workspace-b", "workspace!a", ","]) {
      expect(
        evaluateBillingAdmission({ mode: "canary", workspaceId: "workspace-a", canaryWorkspaceIds })
      ).toEqual({ allowed: false, mode: "canary", reason: "invalid_allowlist" })
    }
  })

  it("admits authenticated workspaces only when explicitly public", () => {
    expect(
      evaluateBillingAdmission({
        mode: "public",
        workspaceId: "workspace-a",
        canaryWorkspaceIds: "malformed!",
      })
    ).toEqual({ allowed: true, mode: "public", reason: "public" })
  })

  it("admits Cloud and Local test checkout only through the restricted staging contract", () => {
    mocks.deploymentEnvironment = "billing-staging"
    mocks.stagingAdmission = "restricted"

    expect(getBillingAdmission("polar", "workspace-a", true)).toEqual({
      allowed: true,
      mode: "off",
      reason: "restricted_staging",
    })
    expect(getLocalBillingAdmission("razorpay", true).allowed).toBe(true)
  })

  it("keeps production and unmarked staging requests fail-closed", () => {
    mocks.stagingAdmission = "restricted"
    expect(getBillingAdmission("polar", "workspace-a", true).allowed).toBe(false)

    mocks.deploymentEnvironment = "billing-staging"
    expect(getBillingAdmission("polar", "workspace-a").allowed).toBe(false)
    expect(getLocalBillingAdmission("polar").allowed).toBe(false)
  })
})
