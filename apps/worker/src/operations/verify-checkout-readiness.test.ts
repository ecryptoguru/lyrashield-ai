import { describe, expect, it } from "vitest"
import { checkCheckoutReadiness } from "./verify-checkout-readiness"

const fullPolar = JSON.stringify({
  starter_monthly: "prod_sm",
  starter_annual: "prod_sa",
  pro_monthly: "prod_pm",
  pro_annual: "prod_pa",
  launch_assurance_monthly: "prod_am",
  launch_assurance_annual: "prod_aa",
  pack_100: "prod_p100",
  pack_250: "prod_p250",
  pack_500: "prod_p500",
})
const fullRazorpay = JSON.stringify({
  starter_monthly: "plan_sm",
  starter_annual: "plan_sa",
  pro_monthly: "plan_pm",
  pro_annual: "plan_pa",
  launch_assurance_monthly: "plan_am",
  launch_assurance_annual: "plan_aa",
})

const READY_ENV = {
  POLAR_BILLING_ADMISSION: "canary",
  RAZORPAY_BILLING_ADMISSION: "public",
  BILLING_CANARY_WORKSPACE_IDS: "ws_1",
  POLAR_ACCESS_TOKEN: "tok",
  POLAR_ENVIRONMENT: "production",
  POLAR_PRODUCT_IDS: fullPolar,
  POLAR_LOCAL_PRODUCT_IDS: JSON.stringify({ individual_launch: "prod_local" }),
  POLAR_WEBHOOK_SECRET: "whsec",
  RAZORPAY_KEY_ID: "rzp_key",
  RAZORPAY_KEY_SECRET: "rzp_secret",
  RAZORPAY_PLAN_IDS: fullRazorpay,
  RAZORPAY_WEBHOOK_SECRET: "rzp_wh",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
} as const

describe("checkCheckoutReadiness", () => {
  it("reports every check ok on a complete configuration", () => {
    const report = checkCheckoutReadiness(READY_ENV)
    expect(report.ok).toBe(true)
    expect(report.checks.every((c) => c.ok)).toBe(true)
  })

  it("fails when a plan×interval product id is missing from the Polar catalog", () => {
    const partial = JSON.stringify({ ...JSON.parse(fullPolar), pro_annual: undefined })
    const report = checkCheckoutReadiness({ ...READY_ENV, POLAR_PRODUCT_IDS: partial })
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.name === "polar_catalog")?.missing).toContain("pro_annual")
  })

  it("fails when admissions are enabled but provider credentials are absent", () => {
    const report = checkCheckoutReadiness({
      ...READY_ENV,
      POLAR_ACCESS_TOKEN: "",
      POLAR_WEBHOOK_SECRET: "",
    })
    expect(report.ok).toBe(false)
    const creds = report.checks.find((c) => c.name === "polar_credentials")
    expect(creds?.ok).toBe(false)
  })

  it("accepts admission=off with empty catalogs as a safe posture", () => {
    const report = checkCheckoutReadiness({
      ...READY_ENV,
      POLAR_BILLING_ADMISSION: "off",
      RAZORPAY_BILLING_ADMISSION: "off",
    })
    const admission = report.checks.find((c) => c.name === "admission_posture")
    expect(admission?.ok).toBe(true)
    expect(admission?.detail).toContain("off")
  })

  it("fails when canary is enabled without a workspace allowlist", () => {
    const report = checkCheckoutReadiness({
      ...READY_ENV,
      POLAR_BILLING_ADMISSION: "canary",
      BILLING_CANARY_WORKSPACE_IDS: "",
    })
    const admission = report.checks.find((c) => c.name === "admission_posture")
    expect(admission?.ok).toBe(false)
  })

  it("rejects malformed canary lists and Local-only missing credentials", () => {
    expect(
      checkCheckoutReadiness({
        ...READY_ENV,
        BILLING_CANARY_WORKSPACE_IDS: "ws_1,,ws_2",
      }).checks.find((c) => c.name === "admission_posture")?.ok
    ).toBe(false)
    const localOnly = checkCheckoutReadiness({
      ...READY_ENV,
      POLAR_BILLING_ADMISSION: "off",
      RAZORPAY_BILLING_ADMISSION: "off",
      POLAR_LOCAL_BILLING_ADMISSION: "public",
      RAZORPAY_LOCAL_BILLING_ADMISSION: "public",
      POLAR_ACCESS_TOKEN: "",
      RAZORPAY_KEY_ID: "",
    })
    expect(localOnly.checks.find((c) => c.name === "polar_credentials")?.ok).toBe(false)
    expect(localOnly.checks.find((c) => c.name === "razorpay_credentials")?.ok).toBe(false)
  })

  it("rejects a sandbox Polar environment with enabled live admission", () => {
    expect(
      checkCheckoutReadiness({ ...READY_ENV, POLAR_ENVIRONMENT: "sandbox" }).checks.find(
        (c) => c.name === "polar_live_environment"
      )?.ok
    ).toBe(false)
  })

  it("fails when Razorpay catalog is missing keys under an enabled admission", () => {
    const partial = JSON.stringify({
      ...JSON.parse(fullRazorpay),
      launch_assurance_annual: undefined,
    })
    const report = checkCheckoutReadiness({
      ...READY_ENV,
      RAZORPAY_PLAN_IDS: partial,
    })
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.name === "razorpay_catalog")?.missing).toContain(
      "launch_assurance_annual"
    )
  })
})
