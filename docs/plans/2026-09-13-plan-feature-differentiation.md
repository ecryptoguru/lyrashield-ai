# Plan-Feature Differentiation — Entitlement Flag Map (2026-09-13)

Founder-approved follow-up to the #670 repack (separate branch/PR). Prices,
allowances (210/850/4500), packs (15/35/65), trial terms (7d/60min), the meter
definition and overage are frozen and untouched. This document enumerates the
per-tier feature/entitlement flag map as inspected from code at
`main` `5a584266` (before) and after this PR, so the differentiation shipped
here is auditable against the code rather than the marketing page.

## 1. What the code actually gates by plan (before this PR)

Sources: `packages/pricing/src/plans.ts` (catalog),
`packages/billing/src/entitlements.ts` (scan/target admission on the
sponsoring account's `effectivePlan`), `packages/fix/src/scope-policy.ts`
(patch scope), `packages/billing/src/usage/overage.ts` and
`apps/web/src/app/api/billing/spend-limit/route.ts` (overage),
`packages/auth/src/permissions.ts` (RBAC).

| Flag                            | Trial             | Starter          | Pro                | Launch Assurance   | Enterprise         | Where enforced                                                              |
| ------------------------------- | ----------------- | ---------------- | ------------------ | ------------------ | ------------------ | --------------------------------------------------------------------------- |
| agentMinutes                    | 60 one-time       | 210              | 850                | 4,500              | custom             | `entitlements.ts` balance check (frozen)                                    |
| targetCaps                      | 3                 | 5                | 15                 | 50                 | custom             | `assertTargetAllowed` (frozen)                                              |
| deepAllowed (Deep/Custom scans) | No                | No               | Yes                | Yes                | Yes                | `entitlements.ts` → `DEEP_NOT_ALLOWED`                                      |
| Overage + spend limit           | No                | No               | No                 | Yes                | custom             | `entitlements.ts:216-218`, `usage/overage.ts:82`, `spend-limit/route.ts:59` |
| Fix patch scope                 | current-file/100  | current-file/100 | implicated-set/200 | implicated-set/200 | implicated-set/200 | `packages/fix/src/scope-policy.ts`                                          |
| selfServe checkout              | No                | Yes              | Yes                | Yes                | No                 | checkout route enum                                                         |
| Fix-PR creation                 | n/a (needs scans) | Yes              | Yes                | Yes                | Yes                | `resolveAccountBilling` effectivePlan gate in `create-pr/route.ts`          |

## 2. What the code does NOT gate by plan (RBAC only) — the flag map's load-bearing finding

The following features are reachable by every workspace regardless of the
sponsor's plan. There is no entitlement flag for them anywhere in the
resolution path — access is session + workspace RLS + role permissions:

- **CLI** (`npx lyrashield`) — any account with an API key; the package is
  public on npm.
- **GitHub Action** (`ecryptoguru/lyrashield-ai@v2`) — account-less; runs in
  the customer's own runner, diff-scoped gitleaks + risky-pattern +
  local WebMCP checks, emits SARIF, fails the check at severity.
- **MCP server connection / agent connections** — `requireWorkspaceAccess`
  (`api/connections/route.ts`); any workspace member can hold a connection
  grant; per-connection scopes and approval gates still apply.
- **GitHub repo connection (GitHub App install)** — `integration:manage`
  permission (OWNER/ADMIN), not a plan flag (`api/integrations/github/*`).
- **Evidence Vault (`/dashboard/ai-assurance`)** — `aiAssurance:view`
  permission, which every role holds via `OPERATIONAL_PERMISSIONS`
  (`permissions.ts:324-341`). It is a role gate, not a plan gate.
- **WebMCP scanner findings (`finding_class: webmcp_tool_surface`)** — the
  `ai_app_security` scanner runs on every repository scan in every mode
  (QUICK/STANDARD/DEEP), findings persist through `persistFindings` and are
  listed for every plan, including Trial. No tier filter exists.
- **Gate verdict + Launch Readiness APIs and `lyrashield gate --verdict`** —
  `finding:view` / `scan:create` permissions; no plan check.
- **Reports, shared reports, scorecard publish, schedules, retests, API keys** —
  RBAC + sponsor scan admission; no plan check.

## 3. What this PR changes (and does not change)

### Move 1 — agent-native surfaces stated on every paid tier

The surfaces were already reachable on every tier (Section 2); the pricing
catalog now says so instead of implying a premium. Starter's feature list
gains `CLI, GitHub Action and MCP server access`. No enforcement code is
added or removed — adding a Starter gate would have risked taking access
away from accounts that already use these surfaces, which was not the
approved intent. No cost impact: the CLI and Action are free externally and
MCP/connections carry no marginal platform cost.

### Move 2 — WebMCP scanner findings stated on Pro; assurance receipts stay Launch Assurance

Code truth (Section 2): scanner-level WebMCP findings already surface at
every tier, so no entitlement change was needed to make them available on
Pro — the change is the catalog line on Pro
(`Deep scans plus agent-surface review for apps that expose MCP or WebMCP tools.`)
and the explicit Launch Assurance distinction. Launch Assurance keeps the
assurance-grade layer: WebMCP coverage receipts bound into the versioned
verdict (`packages/gate/src/coverage-matrix.ts` requires `ai_app_security`
for REPO/WEB_APP/API targets), the signed report's WebMCP assurance section
(`packages/db/src/report-generator.ts`), the shareable scorecard and the
launch gate. Nothing moved down from Launch Assurance.

Copy constraint honoured: Pro's line says scanner-level detection; it makes
no exclusivity or "only we" claim. The compare pages continue to describe
MCP integration as a capability table row, not a uniqueness claim.

**Open founder decision (not actioned here):** whether Starter/Trial should
STOP seeing scanner-level WebMCP findings (a Pro+ entitlement filter on the
findings list). That would be a downgrade of existing visibility, so it
needs an explicit founder call; this PR does not add that filter.

### Move 3 — /pricing copy fixes

- Launch Assurance `CI gating (SARIF)` becomes `Enforced launch-gate verdict
in CI — merges blocked until the versioned verdict passes, with coverage
receipts.` Verified against behavior: `lyrashield gate --verdict
--commit <sha>` exits 0/1/2 with staleness failing closed, so wiring it as
  a required status check blocks merges until the versioned verdict
  (`lyrashield-gate/1.0.0`) passes; coverage receipts are bound into the
  verdict by the gate's coverage matrix. The free GitHub Action is clarified
  on the page: scan-level SARIF in any repo, free.
- Starter `Evidence Vault access` becomes `Personal evidence records`,
  matching the lighter scope a solo Starter user actually gets (the Vault is
  role-gated workspace evidence; Starter workspaces are typically
  single-member, so the records are personal). Launch Assurance keeps
  `Retained, encrypted evidence for client-grade review`.

## 4. Flag map after this PR

Enforcement is unchanged by this PR (Section 1 rows are identical before and
after; the frozen repack values are untouched). What changed is the catalog
feature lists (`packages/pricing/src/plans.ts`) and the /pricing page copy
that renders them, so the stated tier differentiation now matches the code:

| Feature statement                   | Trial | Starter                   | Pro                     | Launch Assurance                                          |
| ----------------------------------- | ----- | ------------------------- | ----------------------- | --------------------------------------------------------- |
| CLI / GitHub Action / MCP stated    | —     | Yes (new line)            | Yes (new line)          | Yes (new line)                                            |
| WebMCP scanner findings stated      | —     | —                         | Yes (new line)          | Yes (WebMCP Assurance line retained)                      |
| WebMCP coverage receipts in verdict | —     | —                         | —                       | Yes (unchanged)                                           |
| Evidence wording                    | —     | Personal evidence records | Evidence Vault + Retest | Retained, encrypted evidence for client-grade review      |
| CI gating wording                   | —     | —                         | —                       | Enforced launch-gate verdict in CI with coverage receipts |
