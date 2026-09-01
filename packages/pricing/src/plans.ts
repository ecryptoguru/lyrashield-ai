/**
 * Cloud plan definitions for LyraShield AI.
 *
 * Plans are ordered by tier: TRIAL < STARTER < PRO < LAUNCH_ASSURANCE < ENTERPRISE.
 * The three self-serve lines (STARTER, PRO, LAUNCH_ASSURANCE) form two product
 * lines: SCAN (Starter, Pro) and LAUNCH ASSURANCE (the premium evidence/verdict
 * line). ENTERPRISE is contact-led (no self-serve checkout).
 *
 * All prices are in USD and INR. Monthly and annual prices are listed
 * separately so the billing layer can compute prorations and upgrades
 * without floating-point arithmetic.
 */

export type CloudPlanId = "TRIAL" | "STARTER" | "PRO" | "LAUNCH_ASSURANCE" | "ENTERPRISE"

export interface PlanPrice {
  /** Monthly price in major currency units (e.g. 29 = $29). */
  monthly: number
  /** Annual price in major currency units (e.g. 295 = $295/yr). */
  annual: number
}

export interface RegionalPrice {
  usd: PlanPrice
  inr: PlanPrice
}

export interface CloudPlan {
  id: CloudPlanId
  name: string
  /** Included agent-minutes per month. */
  agentMinutes: number
  /** Maximum protected targets; 0 represents a custom Enterprise limit. */
  targetCaps: number
  /** Whether Deep/Custom scans are allowed on this plan. */
  deepAllowed: boolean
  /** Whether this plan has a self-serve checkout flow. */
  selfServe: boolean
  /** Price by region. */
  price: RegionalPrice
  /** Human-readable feature list for marketing/checkout. */
  features: string[]
}

export const CLOUD_PLANS: readonly CloudPlan[] = [
  {
    id: "TRIAL",
    name: "Trial",
    agentMinutes: 100,
    targetCaps: 3,
    deepAllowed: false,
    selfServe: false,
    price: {
      usd: { monthly: 0, annual: 0 },
      inr: { monthly: 0, annual: 0 },
    },
    features: [
      "100 agent-minutes (one-time)",
      "Up to 3 targets",
      "Safe / Quick / Standard scans",
      "Community support",
    ],
  },
  {
    id: "STARTER",
    name: "Starter",
    agentMinutes: 300,
    targetCaps: 5,
    deepAllowed: false,
    selfServe: true,
    price: {
      usd: { monthly: 29, annual: 295 },
      inr: { monthly: 2900, annual: 29500 },
    },
    features: [
      "300 agent-minutes / month",
      "Up to 5 targets",
      "Safe / Quick / Standard scans",
      "Email support",
      "Evidence Vault access",
    ],
  },
  {
    id: "PRO",
    name: "Pro",
    agentMinutes: 1200,
    targetCaps: 15,
    deepAllowed: true,
    selfServe: true,
    price: {
      usd: { monthly: 99, annual: 950 },
      inr: { monthly: 9900, annual: 95000 },
    },
    features: [
      "1,200 agent-minutes / month",
      "Up to 15 targets",
      "Deep / Custom scans enabled",
      "Integrations (GitHub, Slack, Jira)",
      "Priority email support",
      "Evidence Vault + Retest",
      "Scheduled scans",
    ],
  },
  {
    id: "LAUNCH_ASSURANCE",
    name: "Launch Assurance",
    agentMinutes: 6000,
    targetCaps: 50,
    deepAllowed: true,
    selfServe: true,
    price: {
      usd: { monthly: 499, annual: 4188 },
      inr: { monthly: 49900, annual: 418800 },
    },
    features: [
      "Continuous launch gate with a versioned verdict",
      "6,000 agent-minutes / month",
      "Up to 50 targets",
      "Deep / Custom scans enabled",
      "Verified evidence + coverage receipts",
      "WebMCP Assurance (agent surfaces)",
      "CI gating (SARIF)",
      "Shareable, revocable scorecard",
      "Retained encrypted evidence",
      "Integrations (GitHub, Slack, Jira)",
      "Role-based access control",
      "Shared reports",
      "Priority support",
    ],
  },
  {
    id: "ENTERPRISE",
    name: "Enterprise",
    agentMinutes: 0,
    targetCaps: 0,
    deepAllowed: true,
    selfServe: false,
    price: {
      usd: { monthly: 1500, annual: 0 },
      inr: { monthly: 150000, annual: 0 },
    },
    features: [
      "Custom agent-minute pool",
      "Custom target limits",
      "Deep / Custom scans enabled",
      "Everything in Launch Assurance",
      "Custom integrations",
      "SSO / SAML — on request",
      "Multi-workspace management — on request",
      "Dedicated support with SLA — on request",
    ],
  },
] as const

/** Map of plan id → CloudPlan for O(1) lookup. */
export const CLOUD_PLAN_MAP: Readonly<Record<CloudPlanId, CloudPlan>> = Object.fromEntries(
  CLOUD_PLANS.map((p) => [p.id, p])
) as Readonly<Record<CloudPlanId, CloudPlan>>
