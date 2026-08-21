# LyraShield AI — Phase 2 and Future Roadmap Archive

> Verbatim extraction from `PRD.md` at commit `69a72afcce5f28df976bbc72b08d7c4d67acfe83`, immediately before the 2026-08-21 consolidation. Wording, status labels, estimates, examples, and historical references below are preserved without summarization; current product and release truth remains in `PRD.md`.

Product phases:

- Phase 1: Vibe coders, solopreneurs, startups, agencies, small teams
- Phase 2: Enterprise, regulated teams, large engineering orgs, security teams

---

This loop must remain the same for both phases.

Phase 1 hides complexity.

Phase 2 adds governance, policy, deployment, and compliance controls without breaking the simple workflow.

## 2.2 Differentiation

Main differentiators:

1. **Explicit evidence states, not inflated verification claims**
2. **Plain-language explanations for vibe coders**
3. **Technical evidence for security teams**
4. **Fix proposals, server-owned retests, and assurance reports**
5. **Safe sandboxed execution**
6. **One-click onboarding**
7. **Enterprise governance later, not upfront**
8. **BYOK/BYOM support in Phase 2**
9. **Private worker deployment for enterprise**
10. **Human-validated pentest add-on later**

# Phase 2: Enterprise and Large Teams

## 3.5 Goal

Add enterprise-grade capabilities around the same core product loop.

The everyday developer still sees:

```txt
New Security Check
Findings
Fixes
Reports
```

Admins see:

```txt
Identity
Policies
Audit Logs
Compliance
Private Workers
Deployment
Data Controls
Integrations
```

## 3.6 Target Users

Primary:

- AppSec teams
- CISOs
- security engineering teams
- platform engineering teams
- regulated SaaS companies
- fintech teams
- healthcare teams
- large engineering orgs
- MSPs and MSSPs

## 3.7 Enterprise Jobs To Be Done

### JTBD 1: “Govern scans across all teams”

Enterprise admin wants to define:

```txt
Who can scan
What can be scanned
When production can be scanned
What blocks release
Who can accept risk
Where evidence is stored
```

### JTBD 2: “Use private deployment”

Enterprise wants private scanning of:

```txt
private repos
internal apps
staging environments
private APIs
cloud infrastructure
```

### JTBD 3: “Generate compliance evidence”

Security team wants:

```txt
SOC 2 evidence
ISO 27001 evidence
OWASP Top 10 mapping
CWE mapping
accepted risk register
retest attestation
audit logs
```

### JTBD 4: “Integrate with enterprise workflows”

Enterprise wants:

```txt
GitHub Enterprise
GitLab self-managed
Azure DevOps
Jira
ServiceNow
Slack
Microsoft Teams
Splunk
Microsoft Sentinel
Datadog
Vanta
Drata
```

## 3.8 Phase 2 Features

Must-have:

- SAML SSO
- OIDC SSO
- SCIM provisioning
- advanced RBAC
- policy engine
- production scan approval
- audit logs
- evidence retention controls
- BYOK
- BYOM
- private worker
- VPC deployment
- self-hosted Helm deployment
- GitHub Enterprise
- GitLab self-managed
- Azure DevOps
- Jira
- Slack
- Microsoft Teams
- ServiceNow
- compliance reports
- SIEM export
- admin dashboard

Should-have:

- cloud account scanning
- IaC scanning
- container scanning dashboard
- ASPM-style risk graph
- data residency controls
- private evidence storage
- human-validated pentest add-on
- MSP multi-client console

---

## 4.2 Phase 2 Metrics

Enterprise:

```txt
Enterprise pilot activation
SSO setup completion
Private worker setup completion
Number of protected targets
Policy adoption rate
Audit export usage
Compliance report generation
MTTR reduction
Renewal intent
Expansion revenue
```

---

There is no separate `apps/api`: Next.js route handlers in `apps/web` provide the product API. Terraform, Helm, and a dedicated infrastructure tree are future deployment work, not current repository structure.

## 6.2 Phase 2 Architecture

```txt
Web App
        |
API Gateway
        |
Core Services
  - Auth / Identity
  - Workspace Service
  - Target Service
  - Scan Orchestrator
  - Findings Service
  - Fix Service
  - Policy Service
  - Reporting Service
  - Integration Service
  - Billing Service
  - Audit Service
        |
PostgreSQL Cluster
Redis / Queue
Object Storage
KMS / Secret Vault
Audit Log Store
        |
Kubernetes Worker Pools
        |
Customer Private Worker / VPC Connector
        |
LyraShield Sandbox Jobs
        |
Customer-approved LLM Providers
```

## 7.3 Phase 2 Auth Requirements

Support:

```txt
SAML SSO
OIDC SSO
SCIM
2FA
passkeys
enterprise session policy
domain verification
IdP group mapping
audit events for auth changes
```

## 7.6 Application Roles

Phase 1 roles:

```txt
OWNER
ADMIN
MEMBER
VIEWER
```

Phase 2 roles:

```txt
ORG_OWNER
SECURITY_ADMIN
APPSEC_MANAGER
DEVELOPER
AUDITOR
BILLING_ADMIN
READ_ONLY
EXTERNAL_PENTESTER
```

## 7.7 Permission Examples

```txt
workspace:create
workspace:update
member:invite
member:remove
target:create
target:update
scan:create
scan:cancel
finding:view
finding:update
finding:accept_risk
finding:false_positive
fix:create
fix:create_pr
report:create
report:download
policy:create
policy:update
audit:view
billing:manage
integration:manage
```

---

# 8. Prisma Data Model

## 8.1 Database

Use PostgreSQL.

Required extensions:

```txt
pgcrypto
uuid-ossp optional
pgvector optional later
```

## 8.2 Prisma Schema Organization

```txt
packages/db/
  prisma/
    schema.prisma
    migrations/
    seed.ts
  src/
    client.ts
    enums.ts
    queries/
```

# 9. API Architecture

## 9.1 API Style

Use REST for Phase 1.

Use typed DTOs with Zod.

Optional Phase 2:

```txt
GraphQL for enterprise dashboards
Public REST API for integrations
Webhooks for events
```

### Get Scan Events

```http
GET /api/scans/:scanId/events
```

Phase 1 implementation:

```txt
Server-sent events or polling.
```

Phase 2 implementation:

```txt
Server-sent events, WebSocket, or event streaming.
```

Event example:

```json
{
  "stage": "testing",
  "level": "info",
  "message": "Testing authentication and account isolation.",
  "createdAt": "2026-06-30T10:30:00.000Z"
}
```

---

## 10.7 Sandbox Requirements

Phase 1:

```txt
Docker-based scan worker
one container per scan
ephemeral workspace
read-only repo mount where possible
no plaintext secret persistence
CPU/memory limits
timeout
budget limit
cleanup on finish/failure
```

Sandbox security requirements:

```txt
Network isolation:
  No unrestricted network access. A containerized worker requires a dedicated internal custom bridge so its control plane can reach the sandbox; `--network none` is valid only when no host-to-sandbox control plane is required.
  Egress proxy required for target-only access.
  Block internal IP ranges: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (AWS metadata).
  Allow DNS resolution only for target domains in allowedDomains.

Resource limits:
  CPU: 2 cores max (--cpus=2)
  Memory: 2GB max (--memory=2g)
  Disk: 5GB max ephemeral storage
  PIDs: 256 max (--pids-limit=256)
  No swap (--memory-swap=0)

Security profiles:
  seccomp profile: default-deny with allowlist for syscalls needed by LyraShield scan engine.
  AppArmor or SELinux profile if available.
  User namespace mapping: run as non-root user (UID 1000).
  No new privileges: --security-opt=no-new-privileges
  Read-only root filesystem: --read-only with tmpfs for /tmp

Egress enforcement:
  HTTP proxy intercepts all outbound traffic.
  Proxy validates destination against policy allowedDomains.
  Proxy blocks requests to internal IP ranges.
  Proxy logs all outbound requests for audit.
```

Phase 2:

```txt
Kubernetes job per scan
dedicated worker node pool
network policies
customer private worker
VPC deployment
self-hosted worker
customer-owned storage
customer-owned KMS
```

---

## 11.2 Phase 2 Navigation Additions

```txt
Policies
Compliance
Audit Logs
Identity
Private Workers
Admin
Deployments
```

## 12.2 Phase 2 Integrations

```txt
GitHub Enterprise
GitLab self-managed
Azure DevOps
Jira
ServiceNow
Slack
Microsoft Teams
Splunk
Datadog
Microsoft Sentinel
Vanta
Drata
AWS
Azure
GCP
```

## 13.2 Phase 2 Plans

### Business

```txt
advanced teams
policies
Jira/Teams
audit logs
compliance report basics
```

### Enterprise SaaS

```txt
SSO
SCIM
advanced RBAC
audit exports
compliance packs
SIEM export
support SLA
```

### Enterprise Private

```txt
VPC deployment
private workers
BYOK
BYOM
private storage
custom retention
```

### Self-Hosted

```txt
Helm chart
license key
offline-friendly option later
support contract
upgrade support
```

## 15.2 Phase 2 Reports

```txt
Executive Risk Report
Technical Pentest Report
SOC 2 Evidence Pack
ISO 27001 Evidence Pack
OWASP Top 10 Report
CWE Report
PCI-style Vulnerability Report
Accepted Risk Register
Remediation SLA Report
Retest Attestation
```

## Sprint 5.5: Security Copilot Sidebar

Status: **Not started**

Duration: 1 week

Goal:

```txt
Add page-aware agent assistant to the dashboard.
```

Tasks:

```txt
Add AgentSidebar to dashboard layout.
Pass current project/target/scan/finding context to agent.
Add suggested prompts per page.
Render structured finding cards.
Render scan timeline summaries.
Add founder/developer/security explanation modes.
```

Acceptance criteria:

```txt
User can ask about current finding.
Agent knows current page context.
Agent can call read-only actions.
Agent cannot create PR without approval.
```

Codex/Hermes prompt:

```txt
Add the Agent-Native security copilot sidebar to the LyraShield dashboard. The sidebar should be page-aware (knows current project/target/scan/finding context), support suggested prompts per page, render structured finding cards and scan timelines, and offer founder/developer/security-engineer explanation modes. Agent can call read-only actions but cannot mutate without approval.
```

---

## Sprint 7.5: Agent Approval Layer

Status: **Complete**

Duration: 3-5 days

Goal:

```txt
Human approval for consequential security actions.
```

Tasks:

```txt
Gate create-fix-pr with needsApproval.
Gate production deep scan with needsApproval predicate.
Gate accept-risk with needsApproval.
Gate send-report with needsApproval.
Gate delete-target with needsApproval.
Add approval UI (Approve/Deny in chat).
Write approval audit logs.
```

Acceptance criteria:

```txt
Agent cannot create PR without approval.
Agent cannot accept risk without approval.
Agent cannot run deep scan on production without approval.
Approval is tied to exact action input.
Audit log records human approval.
```

Codex/Hermes prompt:

```txt
Add human-in-the-loop approval gates to LyraShield Agent-Native actions. Gate create-fix-pr, accept-risk, send-report, delete-target, and production deep scans with needsApproval. Add Approve/Deny UI in the chat sidebar. Write audit logs for every approval decision.
```

---

## Sprint 8.5: Visual Security Plan and Recap

Status: **Not started**

Duration: 1 week

Goal:

```txt
Convert findings and PRs into visual review artifacts.
```

Tasks:

```txt
Create /security-plan skill.
Create /security-recap skill.
Generate attack path diagram.
Generate file-level fix map.
Generate reviewer checklist.
Generate shareable recap link.
```

Acceptance criteria:

```txt
Every fix proposal can produce a visual security plan.
Every fix PR can produce a visual recap.
Report includes security recap.
```

Codex/Hermes prompt:

```txt
Create visual security plan and recap skills for LyraShield. /security-plan generates attack path diagrams, file-level fix maps, and test plans before fixes. /security-recap generates what-changed summaries, retest results, remaining risk, and reviewer checklists after PRs. Both produce shareable links.
```

---

## Sprint 9.5: MCP Server for Coding Agents

Status: **Complete** — stdio package published as `@lyrashield/mcp`, remote Streamable HTTP endpoint live at `/api/mcp`, setup docs cover 24 agents, and the `lyrashield install/init/doctor` CLI commands automate config writing.

Duration: 1-2 weeks

Goal:

```txt
Let external coding agents call LyraShield via MCP.
```

Tasks:

```txt
Expose selected actions over MCP at /api/mcp (remote) and via @lyrashield/mcp stdio.
Add MCP auth token.
Add MCP setup docs for Cursor, Codex, Claude Code, Windsurf, OpenCode, Zed, Gemini CLI, Kilo Code, Cline, and others.
Add tools:
  check-diff
  run-pr-scan
  explain-finding
  generate-fix-plan
  verify-fix
  create-pr-security-recap
  list_workspaces
  list_targets
  get_scan_status
  get_findings
  get_launch_readiness
  create_report
  scan_target
  record_fix_proposal
Add safe default permissions (read-only by default).
Add a CLI installer that detects agents and writes/merges config without leaking secrets into shared-by-convention files.
```

Acceptance criteria:

```txt
Cursor/Codex/Claude Code/Windsurf/Zed/Gemini CLI/OpenCode/Kilo Code can call LyraShield MCP.
Agent can scan a PR.
Agent can explain findings.
Agent cannot create PR without user approval.
MCP setup docs exist for all supported coding agents.
`lyrashield install <agent>` writes valid config for JSON, JSONC, TOML, and YAML agents.
```

Codex/Hermes prompt:

```txt
Expose LyraShield Agent-Native actions as MCP tools. Set up the MCP server at /api/mcp and the @lyrashield/mcp stdio package. Add tools: check-diff, run-pr-scan, explain-finding, generate-fix-plan, verify-fix, create-pr-security-recap, plus workspace/target/scan/finding/readiness helpers. Default to read-only permissions. Write setup docs and a `lyrashield install` CLI for Cursor, Codex, Claude Code, Windsurf, OpenCode, Zed, Gemini CLI, and Kilo Code.
```

---

# Phase 2 — Enterprise Platform

## Sprint 12: Enterprise Identity

Duration: 1–2 weeks

Goal:

```txt
Add enterprise identity controls.
```

Tasks:

```txt
Add SAML SSO.
Add OIDC SSO.
Add domain verification.
Add enterprise auth settings page.
Add SSO audit logs.
Add optional 2FA/passkey policy.
Add IdP metadata storage.
```

Acceptance criteria:

```txt
Enterprise workspace can enable SSO.
SSO users can sign in.
Domain verification works.
SSO changes are audited.
Fallback owner access is defined.
```

Codex/Hermes prompt:

```txt
Implement enterprise identity for LyraShield using Better Auth enterprise capabilities where available. Add SAML/OIDC SSO, domain verification, auth settings UI, audit logging, and safe fallback access.
```

---

## Sprint 13: SCIM and Advanced RBAC

Duration: 1–2 weeks

Goal:

```txt
Add enterprise user provisioning and granular permissions.
```

Tasks:

```txt
Add SCIM endpoints.
Map IdP users to workspace members.
Map IdP groups to roles.
Add advanced roles.
Add permission matrix.
Add RBAC middleware.
Add admin members UI.
Add role change audit logs.
```

Acceptance criteria:

```txt
SCIM can create/update/deactivate users.
Group mapping works.
Role-based route protection works.
Only authorized admins can change roles.
Audit logs capture identity events.
```

Codex/Hermes prompt:

```txt
Build SCIM provisioning and advanced RBAC. Add enterprise roles, permission matrix, group mapping, SCIM user lifecycle, admin UI, and audit logs.
```

---

## Sprint 14: Policy Engine

Duration: 1–2 weeks

Goal:

```txt
Admins can control scan behavior.
```

Tasks:

```txt
Create policy editor.
Add production scan approval.
Add scan windows.
Add blocked paths.
Add allowed domains.
Add max budget.
Add max duration.
Add rate limits.
Add evidence retention.
Add destructive action controls.
Add policy evaluation service.
```

Acceptance criteria:

```txt
Policy blocks unsafe scan.
Production deep scan requires approval.
Scan uses configured budget/duration/rate limits.
Policy changes are audited.
```

Codex/Hermes prompt:

```txt
Implement enterprise policy engine for scan governance. Policies must control scope, approvals, production scans, budgets, duration, blocked paths, allowed domains, rate limits, evidence retention, and destructive test settings.
```

---

## Sprint 15: Audit Logs and Compliance Reports

Duration: 1–2 weeks

Goal:

```txt
Enterprise users can export audit and compliance evidence.
```

Tasks:

```txt
Build audit log page.
Add audit filters.
Add audit export CSV/JSON.
Add compliance report templates.
Add SOC 2 report.
Add ISO 27001 report.
Add OWASP Top 10 report.
Add accepted risk register.
Add retest attestation.
```

Acceptance criteria:

```txt
Admins can view audit logs.
Admins can export audit logs.
Compliance reports generate successfully.
Reports include scope, findings, evidence, fix status, retest status, and approvals.
```

Codex/Hermes prompt:

```txt
Build enterprise audit and compliance reporting. Add audit log viewer, export, SOC 2 evidence report, ISO 27001 report, OWASP Top 10 report, accepted risk register, and retest attestation.
```

---

## Sprint 16: Private Worker

Duration: 2 weeks

Goal:

```txt
Enterprise can scan private systems without exposing them publicly.
```

Tasks:

```txt
Create worker registration.
Create worker token system.
Create private worker heartbeat.
Create job pull model.
Add private worker UI.
Add workspace-level worker selection.
Add private worker docs.
Add network troubleshooting.
```

Acceptance criteria:

```txt
Enterprise admin can register private worker.
Private worker pulls jobs.
Private worker reports status.
Scan can run through private worker.
SaaS control plane does not need direct access to private target.
```

Codex/Hermes prompt:

```txt
Implement private worker architecture. Add worker registration, worker tokens, heartbeat, job pull model, worker selection per scan, admin UI, and docs. Private workers should allow scanning internal apps without exposing them publicly.
```

---

## Sprint 17: Enterprise Integrations

Duration: 2 weeks

Goal:

```txt
Add enterprise remediation and notification workflows.
```

Tasks:

```txt
Add GitHub Enterprise support.
Add GitLab self-managed support.
Add Azure DevOps support.
Add Microsoft Teams.
Add Jira advanced fields.
Add ServiceNow.
Add Splunk webhook.
Add Datadog webhook.
Add Microsoft Sentinel webhook.
```

Acceptance criteria:

```txt
Enterprise users can connect GitHub Enterprise.
Enterprise users can create Jira/ServiceNow tickets.
Teams alerts work.
SIEM webhook export works.
Integration events are audited.
```

Codex/Hermes prompt:

```txt
Implement enterprise integrations: GitHub Enterprise, GitLab self-managed, Azure DevOps, Teams, Jira advanced fields, ServiceNow, Splunk, Datadog, and Microsoft Sentinel webhooks.
```

---

## Sprint 18: BYOK, BYOM, and Data Controls

Duration: 1–2 weeks

Goal:

```txt
Enterprise admins can control model providers, keys, retention, and evidence storage.
```

Tasks:

```txt
Add LLM provider config model.
Add BYOK secret references.
Add BYOM endpoint config.
Add model routing policy.
Add retention settings.
Add evidence storage settings.
Add PII redaction settings.
Add data export/delete workflows.
```

Acceptance criteria:

```txt
Admin can configure provider.
Keys are stored in vault.
Scan uses workspace provider policy.
Evidence retention is enforced.
Redaction is applied.
```

Codex/Hermes prompt:

```txt
Implement BYOK/BYOM and data controls. Add provider configuration, secret references, model routing, retention settings, evidence storage settings, PII redaction controls, and admin UI.
```

---

## Sprint 19: VPC and Self-Hosted Deployment

Duration: 2–4 weeks

Goal:

```txt
Enterprise customers can deploy privately.
```

Tasks:

```txt
Create Docker production images.
Create Helm chart.
Create Terraform module for Azure.
Create Terraform module for AWS optional.
Add license key service.
Add self-hosted config docs.
Add backup/restore docs.
Add upgrade docs.
Add observability stack.
```

Acceptance criteria:

```txt
Helm install works.
Self-hosted app can run scan.
License key validation works.
Upgrade path documented.
Backup/restore documented.
Secrets can be externally managed.
```

Codex/Hermes prompt:

```txt
Build VPC/self-hosted deployment baseline. Add production Docker images, Helm chart, Terraform for Azure, license config, external secret support, backup/restore docs, upgrade docs, and observability setup.
```

---

## Must Not Delay Phase 1

```txt
SSO
SCIM
VPC
self-hosted
cloud scanning
ServiceNow
SIEM
advanced compliance
advanced RBAC
private workers
```

---

## 22.7 New Sprints Added

- **Sprint 3.5: Agent Action Layer MVP** ✅ **DONE 2026-07-06** — Expose core operations as typed Agent-Native actions (list-targets, run-scan, get-scan-status, list-findings, get-finding, explain-finding). Permission bridge from Better Auth, workspace scoping, audit mapping. See `codebase.md` §27.
- **Sprint 5.5: Security Copilot Sidebar** — Page-aware agent assistant on dashboard. Suggested prompts per page. Founder/developer/security explanation modes.
- **Sprint 7.5: Agent Approval Layer** ✅ **DONE 2026-07-06** (merged into Sprint 7.6) — Human approval for consequential actions (run-scan DEEP mode). Approval UI + audit logs. `AgentApproval` model with RLS, `agent-approval-service.ts`, approval API routes. Deep code review: 7 fixes (approval verification, audit fault isolation, scan enqueuing, token payload validation, static imports, policy validation, deny docs). See `codebase.md` §27.
- **Sprint 8.5: Visual Security Plan and Recap** — /security-plan and /security-recap skills. Attack path diagrams, file-level fix maps, reviewer checklists, shareable recap links.
- **Sprint 9.5: MCP Server for Coding Agents** ✅ **DONE 2026-07-06** (Sprint 7) — Expose selected actions over MCP. OAuth token, setup docs for Cursor/Codex/Claude Code/Windsurf. Tools: check-diff, run-pr-scan, explain-finding, generate-fix-plan, verify-fix. See `codebase.md` §24.

## 22.8 Key Decisions Summary

- Agent-Native calls LyraShield APIs, not the product database directly
- Agent-Native stores only agent runtime state (threads, runs, approvals)
- Database separation: separate schema (`agent_native.*`) or separate database to avoid Prisma/Drizzle conflicts
- Keep action surface small (10-15 core actions initially)
- Read actions run freely; mutating actions require permission; high-impact actions require approval

## 22.9 Market Positioning Shift

From "AI AppSec scanner" to **"Agent-native security for AI-built apps."**

- **Homepage headline**: Secure AI-built apps before they ship.
- **Subheadline**: LyraShield plugs into your repo, app, and coding agent to find verified vulnerabilities, explain them clearly, create fix PRs, and retest automatically.
- **Developer CTA**: Connect GitHub
- **Vibe coder CTA**: Check if my app is safe to launch
- **Enterprise CTA**: Deploy agent-native AppSec across your engineering org

## 22.10 Five Killer Workflows

```txt
1. Ask: "Is my app safe to launch?"
2. Run verified LyraShield scan
3. Explain findings for founder/developer/security mode
4. Generate fix PR with human approval
5. Retest and generate visual security recap
```

## 22.11 Key Risks

1. **Prisma + Agent-Native DB mismatch** — Don't share ORM ownership; LyraShield Prisma DB remains source of truth; Agent-Native stores only agent runtime state.
2. **Too many agent tools** — Keep only 10-15 core agent tools initially; hide UI-only actions from the model; use broad actions with typed schemas.
3. **Unsafe agent autonomy** — Read actions run freely; mutating actions require permission; high-impact actions require approval; production/deep scans require approval; PR creation requires approval; risk acceptance requires approval.
4. **User confusion** — Use plain-language modes; hide advanced AppSec terminology; offer "Can I launch?" as the primary experience.

---

## B1. Confirmed issues in shipped code (fix now — cheapest while there is no scan/finding data)

**B1.1 SSRF blocklist is bypassable `[P0 · security]`.** `apps/web/src/app/api/targets/route.ts → isSsrfSafe()` string-prefix-matches `URL.hostname` only and never resolves DNS. Confirmed bypasses:

- **Domain → internal IP** (`http://x.attacker.com` resolving to `169.254.169.254`/`10.x`) passes; DNS rebinding possible because the check is at _create_ time, not _fetch_ time.
- **IPv6 brackets:** `new URL("http://[::1]/").hostname === "[::1]"`, so the `"::1"` checks never match → **`[::1]` / `[::ffff:169.254.169.254]` are NOT blocked.**
- **Partial IPv4 ranges:** only exact `0.0.0.0` is blocked, so `0.0.0.1` (and the rest of `0.0.0.0/8`) slips through; CGNAT `100.64.0.0/10` and benchmarking `198.18.0.0/15` are also uncovered.
- Over-broad: `startsWith("10.")` also blocks legitimate hosts like `10.example.com`.
- _Correction (verified against Node):_ decimal/octal/hex IPv4 literals (e.g. `2130706433`) are **not** a bypass here — Node's WHATWG `URL` normalizes them to dotted-decimal for http(s), so the prefix check already catches loopback/private forms. The genuine confirmed gaps are the three above (IPv6-in-brackets, DNS-resolves-to-internal, and partial ranges).
  **Fix:** resolve the hostname and reject if _any_ resolved A/AAAA is in a blocked range; parse IPs properly (strip IPv6 brackets, reject non-standard encodings); allow only `http(s)`. **The real defense is at fetch time in the worker:** resolve→validate→connect-to-that-IP (pin), re-validate every redirect hop, route all scan egress through the allow-listed proxy (see B2.2). Ship before any server-side fetching (Sprint 3/4). **Status: FIXED in PR #2 (`fix/ssrf-hardening`) — new shared helper `apps/web/src/lib/ssrf.ts` with DNS resolution + full CIDR/IPv6 validation + Vitest tests, wired into the targets route.**

**B1.2 RBAC is defined but not enforced at the route layer `[P0 · security]`.** `packages/auth/src/session.ts` exposes `requirePermission()` / `requireWorkspaceAccess()` and `permissions.ts` has a clean 10-role matrix — but `api/targets/route.ts` checks _membership only_, not `target:create`, so a **VIEWER/AUDITOR can create targets**. The `team` route _does_ gate OWNER/ADMIN → enforcement is inconsistent. **Fix:** route every mutating API through `requirePermission(...)`; add a route-handler wrapper so permission checks can't be omitted; audit `projects`/`workspaces`/`team`. **Status: FIXED in PR #3 (`fix/rbac-enforcement`) — `projects`/`targets`/`team` POST now enforce `requirePermission()`; added a shared `authErrorResponse()` 401/403 mapper. (`workspaces` POST intentionally unchanged — no parent workspace to gate.)**

**B1.3 RBAC hierarchy vs. capability mismatch `[P1]`.** In `permissions.ts`, `ADMIN` (rank 80) lacks `audit:view`/`audit:export`/`policy:*` while lower-ranked `SECURITY_ADMIN` (75) has them → an org ADMIN can't view audit logs (likely unintended). Decide whether sets nest by hierarchy; at minimum grant ADMIN `audit:view`. Also derive a union `Permission` type from `PERMISSIONS` (currently `string`, so a typo silently denies). **Status: FIXED in PR #3 — ADMIN granted `audit:view`/`audit:export` + `policy:*`; `Permission` is now a derived union type.**

**B1.4 Auth hardening `[P1]`. — STATUS: NOT STARTED (2026-07-02).** `auth.ts` sets `requireEmailVerification: false` — **enable before scans/billing** (abuse vector, compounds free-tier LLM cost). No env/secret startup validation (PRD §14.1 required `BETTER_AUTH_SECRET`/`DATABASE_URL`) — add a Zod env schema in `packages/config` that fails fast on boot. No rate limiting anywhere (no `middleware.ts`); sign-in/sign-up are live now — **add auth-endpoint rate limiting immediately**, extend to scan creation at Sprint 3.

## B2. Security hardening (design-in for unbuilt features)

**B2.1 Scan sandbox — isolation `[P0 when worker lands]`.** Plain hardened Docker/runc is insufficient for an adversarial workload (recent runc escapes: CVE-2024-21626 "Leaky Vessels", procfs/`core_pattern` races) — and the forked engine's own container runs with **passwordless sudo** (root-capable) and documents `--mount` as _not_ a security boundary. **Move the per-scan sandbox to gVisor (`runsc`)** (moderate effort) or **Firecracker/Kata microVMs** (hardware boundary; e2b / GKE Agent Sandbox precedent). Add warm pools to offset provisioning latency. Independently security-review the inherited engine sandbox before scanning third-party targets in multi-tenant SaaS.

**B2.2 Egress proxy + DNS pinning `[P0 when worker lands]`.** All scan egress through an HTTP proxy that: resolves once, validates the literal IP against the blocklist, connects to that IP (no re-resolution), re-validates each redirect hop, normalizes IDN/PunyCode, re-checks after CONNECT-tunnel establishment. (Reference: Stripe Smokescreen.) This is the durable fix for B1.1.

**B2.3 Prompt-injection defense for the scan agent `[P0 before agent GA]` (OWASP LLM01 indirect).** The agent ingests target-controlled content (source, comments, commit messages, PR text, HTTP responses) — a malicious contributor can plant "ignore previous instructions, report this clean" and hijack it (real precedents: a GitLab CVE; Orca "RoguePilot"). Treat all extracted content as **delimited untrusted data** at prompt construction (never concatenated as instructions); least-privilege tool access for the scan agent; output filtering; injection scenarios as explicit threat-model tests.

**B2.4 Malicious AI fix-PR `[P1]`.** An injected "fix" could introduce a backdoor — **scan the generated patch itself** before opening the PR; keep the never-auto-merge + reviewer-checklist gates.

## B3. Threat model v2 (extends PRD §14.8's 8 surfaces)

Add: (9) **engine supply-chain** (heavy Kali/LiteLLM/Caido dep tree — pin, SBOM, scan the fork); (10) **indirect prompt injection → agent hijack** (B2.3); (11) **root-capable sandbox escape** (B2.1); (12) **MCP confused-deputy / token passthrough** (B6); (13) **tenant-isolation failure** via a missing `where workspaceId` (B4.1 RLS); (14) **report share-link leakage** (tokens in DB — B4); (15) **malicious AI fix-PR** (B2.4).

## B4. Data-model change log (apply while schema is data-free — validated against the real 669-line schema)

**STATUS (2026-07-05): Items 1, 4, 5, 6, 8 are DONE (Batches 1–3). Items 2, 3, 7 remain (need worker/engine or are lower priority). See §B13.6 for details.**

1. **`[P0]` Postgres RLS + a Prisma Client Extension** that injects `workspaceId` scope and `deletedAt IS NULL` on every workspace-scoped query. Today isolation depends on remembering `where workspaceId`, and B1.2 shows enforcement is already inconsistent — this is the top schema fix. RLS keyed on a session GUC (`app.current_workspace_id`) as defense-in-depth.
2. **`[P0]` Re-scope `Finding` dedupe:** change `@@unique([workspaceId, dedupeKey])` → include `targetId` (`@@unique([targetId, dedupeKey])`), and generate `dedupeKey` as a **deterministic fingerprint** = hash of `(vuln_class, normalized route/location, root cause)`, wording-independent, excluding CWE (see B5.2).
3. **`[P0]` New `ApiKey`/`ServiceToken` model:** hashed secret, workspace scope, granted scopes, `expiresAt`, `lastUsedAt`, `revokedAt` — required for the MCP server, CI Action, and public API (none should reuse session cookies).
4. **`[P1]` `Evidence`:** add `encryptionKeyRef` (KMS); enforce that only `redactedStorageUri` is ever served; keep raw artifacts in a separate access-controlled bucket. (Checksum already present.)
5. **`[P1]` `AuditLog` tamper-evidence:** add `prevHash` hash-chain for verifiable compliance exports.
6. **`[P1]` Standardize soft-delete:** `deletedAt` currently only on Workspace/Target/Finding — extend consistently (or document hard-delete) and enforce via the query extension.
7. **`[P1]` Duplicate-target guard:** `@@unique([workspaceId, repoFullName])` and a partial unique on `[workspaceId, url]`.
8. **`[P1]` `Report.shareToken`:** hash at rest, add `revokedAt`, keep `shareExpiresAt`, rate-limit token access. (Growth-critical too — see product.md PLG loop.)
9. **`[P1]` `UsageRecord.idempotencyKey`** (unique per metered event) before billing, so retried jobs/webhooks don't double-bill; make this ledger the single source of truth reconciled to both Polar and Razorpay.
10. **`[P2]` `Retest` first-class model** (finding + scan + before/after result) instead of only `Scan.riskScoreBefore/After`.
11. **`[P2]` Indexes:** add composites `Finding(workspaceId, status, severity)` and `AuditLog(workspaceId, createdAt)`; drop the redundant `@@index([slug])` on `Workspace` (already `@unique`).
12. **`[P2]` `datasource`:** declare `extensions` (pgcrypto, pgvector) + a `directUrl` for migrations/pooler (PgBouncer) when introduced.
13. **`[P2]` Loose user FKs** (`createdById`/`ownerUserId`/`actorUserId`/`invitedById`) have no DB integrity → define a GDPR delete/anonymize strategy for orphaned rows on user deletion.

## B5. Detection quality, determinism & the "verified" promise

**B5.1 Independent verification layer `[P0]`.** Do **not** trust the engine's `confidence.py` as ground truth (open upstream bugs: fabricated file paths/line numbers in black-box mode; missed findings). Insert a layer between engine output and `Finding` records: verify path/line existence in the cloned repo before showing code locations; re-map severity via a deterministic rubric; drop findings whose PoC can't be re-derived. Add a **budget-gated exploit replay** for HIGH/CRITICAL against a frozen target snapshot.
**B5.2 Deterministic fingerprint, not deterministic scanning `[P0]`.** Market/spec the _dedupe key_ as deterministic (B4.2), not the agentic scan. Demote the LLM-judge dedupe to a secondary cross-fingerprint merge pass. Use Schema-Aligned Parsing (generate→validate→retry) for tool/finding outputs rather than relying on `temperature=0+seed`; self-consistency voting for narrow "is this exploitable?" classification only.

## B6. Agent layer & MCP (reconciles + extends §22 above)

- **Don't adopt BuilderIO/agent-native as the system of record** — MIT but ~4 months old, pre-1.0, single-vendor, Drizzle-only. **Borrow the `defineAction()` pattern** hand-rolled thin over Prisma services; if used at all, confine it to a genuinely separate database (two ORMs on one DB = connection-pool/tx-isolation hazard; the separate-DB plan in §22.5 above is the correct mitigation).
- **MCP server = OAuth 2.1 resource server from day one:** PKCE, RFC 8707 audience binding, RFC 7591 dynamic client registration (Cursor/Claude Code/Windsurf/Codex/OpenCode), **RFC 8693 token exchange for internal calls — never pass the caller's token through** (confused-deputy defense). Evaluate Better Auth's `@better-auth/oauth-provider` (v1.5+) as this server.
- **`needsApproval` on every mutating/destructive tool** by default; bind approval to the exact input and re-validate at execution (TOCTOU). Per-key least-privilege tool scoping + independent rate limiting.
- This supersedes/extends the Agent-Native analysis in §22 above with the current MCP security spec.

## B7. Standards & interchange (new)

- **`[P0]` SARIF 2.1.0 export** → GitHub `upload-sarif` (Security tab + PR annotations) + downstream ASOC/SIEM (DefectDojo, GitLab, Azure DevOps). Include `partialFingerprints`/`primaryLocationLineHash`, `rules` with CWE/OWASP `tags`, consistent repo-relative URIs, and the `fixes[]` array (powers commit-suggestion UX).
- **`[P1]` Dual CVSS v3.1 (default/SLA) + v4.0 (stored field)** from schema design — retrofitting v4.0 later means re-scoring history.
- **`[P1]` OWASP mapping refresh to Top 10:2025** (SSRF folded into Broken Access Control; new Software Supply Chain Failures #3) + API Top 10 (2023) tags + LLM Top 10 (2025) tags. These slot into SARIF `rules.tags`.
- **`[P2]` EPSS + CISA KEV** prioritization — adopt _when_ SCA ships (CVE-scoped).

## B8. Detection-coverage expansion (table stakes)

- **`[v1 — CONFIRMED]` SCA / dependency + malicious-package detection** (OSV/GHSA + Socket-style signals) — deterministic, high-confidence, often the _first_ thing buyers check; unlocks EPSS/KEV. **Founder-confirmed 2026-07-04: ships in v1** (decision #15), not agentic-pentest-only.
- **`[v1 — CONFIRMED]` Secrets scanning** (gitleaks/trufflehog-style, incl. git history). **Ships in v1.**
- **`[P2]` IaC + container-image scanning** (backs the "code + cloud + infra" positioning).
- **`[P2]` Reachability analysis** (noise reduction + prioritization).
- Pair the DAST-strong forked engine with **unmodified** Semgrep (SAST), Nuclei/ZAP (infra), OSV/Trivy (deps) as independent dependencies — do not extend the fork's prompt system to cover these (see B9).

## B9. Fork strategy & license hygiene

> Historical audit recommendation. The current decision in Part C and `codebase.md` §54 supersedes the thin-wrapper proposal below: LyraShield Engine is maintained as a controlled derivative over a pinned upstream substrate.

- **Engine license = Apache-2.0** — commercial closed-source SaaS on a fork is fully permitted; **no AGPL/network-copyleft**. Obligations: ship LICENSE, **mark modified files (§4b)**, add a **NOTICE** crediting LiteLLM/Caido/OpenAI-Agents-SDK/Textual. Verify the fork does these. `[P1]`
- **Switch from in-tree rebrand → thin wrapper:** keep the vendored engine as close to pristine upstream as possible; brand/normalize in the TS worker by consuming unmodified engine output. Cuts monthly merge-conflict debt dramatically. `[P1]`
- **Add a CVE-/security-triggered fast-path merge** separate from the routine monthly feature sync (monthly is too slow for security patches in a security product). Maintain a "files we've diverged in" manifest. `[P1]`
- Trademark-clear the public product name (Apache-2.0 §6 grants no trademark rights). `[P1]`

## B10. LLM cost & unit economics (protects gross-margin-per-scan)

Superlinear token growth with target size is the top margin threat. The earlier audit estimated $38–104 for full-repo and ~$0.02–0.07 for diff-only scans before the current GPT-5.6 routing existed; those figures are historical planning inputs, not current measured unit economics. Levers, in build order:

- **`[P0]` Dollar budget guard — IMPLEMENTED 2026-07-13; current profile updated 2026-08-12:** the worker always passes a positive `--max-budget-usd`; engine usage hooks enforce the dollar ceiling. Ceilings are $1.20 Safe/Quick, $3.20 Standard, and $5 Deep/Custom. A finite positive workspace policy can lower but cannot raise them. Repository wall-clock ceilings are 15 minutes for Safe/Quick/Standard and 45 minutes for Deep/Custom; protected partial-result and accounting states remain explicit.
- **`[P0]` Diff-only / incremental scan mode** as the default (also powers the PR gate).
- **`[P1]` Cost-aware model routing — IMPLEMENTED:** Safe/Quick/Standard use Luna at medium reasoning. Deep/Custom use Terra/medium for root coordination and cross-file judgment while Luna/high handles focused specialists. Per-request receipts retain the actual model, child specialists do not copy the parent conversation unless explicitly needed, child fan-out is root-owned, and stable per-scan prompt-cache keys improve repeated-prefix reuse. **Still open:** evidence-triggered adaptive promotion evaluated against the private corpus.
- **`[P2]` Retrieval-based context shrinking**; reserve full replay for HIGH/CRITICAL.

## B11. Revised roadmap overlay (adjustments to the sprint plan above)

- **Immediate (pre-Sprint-3):** B1 fixes (SSRF, RBAC enforcement, email verification, env validation, rate limiting); B4 schema retrofits (RLS + query extension, dedupe key, ApiKey, dup-target constraints, shareToken hashing) while data-free; B9 license hygiene + thin-wrapper decision; reconcile sprint numbering.
- **Sprint 3/4 (scan queue + engine) — add gates:** B2.1/B2.2 sandbox + egress proxy; B10 budget guard + diff-only + cascade + caching.
- **Sprint 5/6 (engine + findings) — expand:** B5 verification layer + deterministic fingerprint; B7 SARIF + dual CVSS + OWASP 2025.
- **New Sprint ~6.5 (deterministic scanners):** B8 SCA + secrets — pull ahead of some agentic polish.
- **Sprint 7–9 (pull CI forward):** SARIF + GitHub Action + reusable workflow + diff-aware gate + Checks API annotations — this _is_ the pre-merge product.
- **Agent sprints:** B2.3 prompt-injection defense before agent GA; B6 MCP OAuth 2.1 + scoping.
- **Phase 2:** EPSS/KEV (post-SCA), IaC/container, reachability, tamper-evident compliance exports, Better-Auth SSO/SCIM (pilot SCIM), BYOK/BYOM.

## B12. Kept as-is (strong already)

Better-Auth-owns-identity / Prisma-owns-app boundary; webhook idempotency model (`@@unique([provider, externalId])`); secrets-as-vault-refs; human-approval-gate model; definition-of-done incl. a11y/empty/error states; the "one product, two depths" principle. The SSRF _intent_ is good — the _implementation_ needs B1.1.

---

## B13. 2026-07-04 Deep-Audit Findings & Batch 1 (authoritative status)

> A code-grounded deep audit of the repo at `396ca63` (now `ecryptoguru/lyrashield-ai`). This section superseded §B0 at the time; **Part C now supersedes it for current build status**. Retain this section as the audit and remediation history.

### B13.1 Corrected status — what is actually DONE

- **Sprints 0, 1, 2, 2.5, 3 complete.** Auth (email/password + GitHub/Google OAuth), full Prisma schema, 10-role RBAC **enforced** on mutating routes, dashboard/projects/targets/team CRUD, onboarding wizard, GitHub App integration (JWT, installation tokens, repo listing, webhook signature verification), integrations UI.
- **Auth hardening DONE** (§B1.4 was stale): `requireEmailVerification: true` + Brevo + `sendOnSignUp`; Zod env validation in `@lyrashield/config`; rate-limiting middleware (auth 5/min, API 30/min).
- **Schema retrofits DONE** (§B4 was stale): `Finding @@unique([targetId, dedupeKey])`, `ApiKey`, `Retest`, `UsageRecord.idempotencyKey`, `Report.shareTokenHash + revokedAt`, duplicate-target constraints, composite `Finding(workspaceId,status,severity)` + `AuditLog(workspaceId,createdAt)`, soft-delete columns.
- **SSRF DONE and strong** (§B1.1 resolved): `apps/web/src/lib/ssrf.ts` resolves DNS and validates every resolved IP; full CIDR coverage (0.0.0.0/8, 10/8, CGNAT 100.64/10, 127/8, 169.254/16 metadata, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, multicast, reserved); IPv6 incl. bracket/zone-id strip, IPv4-mapped, NAT64, ULA, link-local; fail-closed. Only the **fetch-time** rebinding defense (worker IP-pinning + egress proxy, §B2.2) remains — deferred to the worker (unbuilt).

### B13.2 New issues found in the audit and FIXED (Batch 1, PRs on branches, not yet merged)

- **[P0] Tenant-isolation extension was a latent breach + latent crash** (`packages/db`). The workspace-scoping context was a **module-level mutable global** (`setWorkspaceContext` never called) → cross-request tenant leak if ever activated. **Additionally, both model sets were wrong vs. the schema:** `SOFT_DELETE_MODELS` included `WorkspaceMember`, `CredentialSet`, `AuditLog`, `Retest` (no `deletedAt` column) — so the extension would inject `deletedAt: null` into `getWorkspaceMembership()`'s `findUnique` and **throw on every authenticated request against a real DB**; `WORKSPACE_SCOPED_MODELS` included `ScanEvent`, `Evidence`, `FixProposal`, `PullRequest`, `Ticket` (no `workspaceId` column). **Fixed:** rewrote scoping around `AsyncLocalStorage` (request-safe) in a new `packages/db/src/scoping.ts`; corrected both sets to match real columns (19 soft-delete / 17 workspace-scoped, excluding cross-workspace `WorkspaceMember` + per-user `OnboardingState`); wired auto-activation into the auth guard; added unit + concurrency tests. **Postgres RLS remains the deliberate follow-up** (needs DB validation of the per-request GUC under Prisma pooling — transaction-scoped `SET LOCAL`).
- **[P0] Production rate limiting silently no-oped.** The Upstash client used a hardcoded empty token and the `redis://` `REDIS_URL` (wrong endpoint for the HTTP REST client) → prod fell back to per-instance in-memory limiting. **Fixed:** added `UPSTASH_REDIS_REST_URL`/`_TOKEN`, gated the distributed limiter on them, fail-loud on init error, bounded the in-memory map, env refine requires the token when the URL is set. (`REDIS_URL` reserved for the BullMQ queue.)
- **[P0] GitHub webhook had no idempotency guard.** Retried deliveries hit the `@@unique([provider, externalId])` constraint → 500-loop. **Fixed:** dedupe on `X-GitHub-Delivery` (pre-check + P2002 race guard).
- **[P1] Onboarding PATCH IDOR.** Accepted attacker-controlled `workspaceId`/`targetId` with no ownership check. **Fixed:** verify membership/ownership before persisting.
- **[P1] `installation.deleted` over-broad target disable.** `repoFullName: { contains: login }` matched unrelated repos. **Fixed:** owner-prefix `startsWith`. (Follow-up: store numeric `installationId` on `Target` for exact match.)
- **[P1] GitHub install URL used the numeric app id** (404s). **Fixed:** build from `GITHUB_APP_SLUG`.
- **[P1] CI never ran the test suite.** **Fix prepared** (`ci.yml` adds a `pnpm test` step, aligns pnpm to `packageManager`, adds `NEXT_PUBLIC_APP_URL`) — **blocked** on granting the GitHub App the `Workflows: write` permission.

### B13.3 Verification note

The Next 16 / Prisma 7 / Postgres suite is not runnable in the authoring environment; Batch 1 ships with unit tests in the existing Vitest style and relies on CI as the gate — which is why the CI-runs-tests fix (B13.2, blocked) matters. **The full post-Batch-1 backlog (Batches 2–4) is embedded below in §B13.5, with the sprint mapping in §B13.6 — this PRD is the single source of truth.**

### B13.4 v1 coverage — FINAL

Founder-confirmed 2026-07-04: **v1 = agentic pentest + SCA + secrets + GitHub Action/reusable workflow (diff-aware gate) + SARIF.** Pair the DAST-strong forked engine with **unmodified** independent tools for the deterministic layers (Semgrep-style SAST, OSV/Trivy-style deps, gitleaks/trufflehog-style secrets) rather than extending the fork's prompt system. This resolves decision #15 and pulls §B8's SCA/secrets recommendation into v1 scope (see §B8, and MVP Cutline §18).

## B13.5 Post-Batch-1 backlog (full detail — PRD is the single source of truth)

The complete prioritized backlog from the 2026-07-04 deep audit. Severity **P0/P1/P2**; effort **S** ≤half-day / **M** ~1–2 days / **L** ~3+ days. Honest-positioning guardrails apply (no "only we" claims, no benchmark/accuracy numbers, no public pricing, no naming the forked engine publicly).

### Part A — remaining correctness/security fixes

- **A6 · P1 · No pagination on any list endpoint** (`targets`/`projects`/`team` GET). Unbounded `findMany`; a `PaginatedResponse<T>` type exists but is unused. **Fix (M):** cursor / `take`+`skip` pagination + composite indexes `Target(workspaceId, createdAt)`, `Project(workspaceId, createdAt)`.
- **A7 · P1 · CI never runs the tests** (PREPARED, blocked on GitHub App `Workflows: write`). Adds `pnpm test`, aligns pnpm to `packageManager`, adds `NEXT_PUBLIC_APP_URL`, concurrency-cancel.
- **A8 · P0-UX/P1 · Frontend correctness & a11y** (`apps/web`): ✅ **PARTIALLY RESOLVED 2026-07-05** — keyboard-accessible target rows (`role="link"` + `aria-label`), responsive sidebar drawer with overlay, `aria-hidden` on all decorative icons, `aria-label` on nav elements, dark mode token fixes (gradient/text-shadow utilities), mobile-optimized tables (`hidden sm:table-cell`, `overflow-x-auto`), OWNER badge distinguished from ADMIN, OAuth `setLoading(false)` in `finally` block, onboarding wizard mode selector `grid-cols-2`, all buttons upgraded to `gradient-primary rounded-lg`, `PreflightItem` icon fix. See `codebase.md` §18. **Still open:** nav-404 stubs for `/dashboard/scans|findings|fixes|reports|settings` (coming-soon stubs / disabled nav); onboarding re-entry after skip; `role="alert"`/`aria-live` on error/success banners; `repoProvider` free-text → `z.enum(["github"])`; install POST Zod validation on `workspaceId`.
- **A9 · P2 · Audit-log richness & hygiene**: `ipAddress`/`userAgent`/`prevHash` columns never populated → add `buildAuditContext(request)`; implement the `prevHash` hash-chain (tamper-evident compliance export) or mark reserved; log `error.stack` not `String(error)` and scrub secrets; fix the install-POST catch block that leaks the raw error message and never logs.

### Part B — optimizations (perf, cost, architecture, DX)

- **B1 · P1 · Kill the Server→Client data waterfall.** Dashboard sub-pages (Server Components) hand off to `*-client.tsx` that re-fetch the same data over `/api/*`, and every mutation fires both a client refetch and `router.refresh()`. Pass `initialData`; drop the redundant `router.refresh()`.
- **B2 · P0-perf · Request-level memoization.** Every sub-page re-runs `getSession()` + a membership query already resolved in the layout → wrap in React `cache()`.
- **B3 · P1 · Extract a real component library.** ✅ **RESOLVED 2026-07-05** — `packages/ui` now exports `Button` (cva, 5 variants × 4 sizes), `Card` family, `Badge` (cva, 6 variants), `Input`/`Textarea`/`Select`/`FormField`, `EmptyState`, `Spinner`, `GithubIcon`. All use `forwardRef` + `cn()`, OKLCH design tokens with dark mode variants. See `codebase.md` §18.
- **B4 · P2 · API-response & fetch helpers.** Factor repeated `{success:false,error:{code,message}}` blocks (mirror `authErrorResponse`); add a `useApiResource<T>` hook with `AbortController` (fixes unmount/rapid-filter races).
- **B5 · P1 · Cost & determinism controls.** ✅ Positive dollar caps and deterministic Terra-coordinator/Luna-specialist routing are implemented. Still open: complete step/token/time/tool-count stop handling, **diff-only scan default**, evidence-triggered adaptive promotion, provider prompt caching, deterministic **fingerprint** dedupe (hash of vuln-class + normalized location + root cause), and an independent verification layer.
- **B6 · P1 (design-only) · Fork strategy & standards.** Thin-wrapper engine (consume unmodified upstream output, brand in the TS worker); CVE-triggered fast-path merge; Apache-2.0 §4b file-marking + NOTICE; commit to **SARIF 2.1.0** output + **dual CVSS v3.1 + v4.0** fields on `Finding` before findings data exists.
- **B7 · P2 · Dogfood in CI.** Run the eventual LyraShield Action against this monorepo — real dogfooding alongside the internal Lyrafin-codebase POC.

### Part C — feature additions (differentiated for the ICP)

Every competitor matches _some_ individual feature; the moat is the **combination for an audience nobody built the information-architecture for**. Documented breaches (Lovable CVE-2025-48757, Base44 auth-bypass, RedAccess's 380K exposed assets) cluster at the **deployed-app + backend-config** layer (missing Supabase RLS, exposed `anon_key`, IDOR/broken-auth), not classic SQLi/XSS.

- **Bet 1 — "Can I launch?" as the primary experience:** **C1 · Launch-readiness gate (P1, M)** — one yes/no verdict + 1–3 things to fix, deploy-check style, honest copy. **C2 · Plain-language findings as a hard constraint (P1, M)** — actionable by a non-engineer without googling a term; 5 explanation modes, "founder mode" default, CWE/CVSS behind a disclosure.
- **Bet 2 — Scan the layer competitors ignore (live app + backend config):** **C3 · AI-builder-aware URL scan (P0 for differentiation, L — needs worker)** — tune detectors for Lovable/Bolt/v0/Replit/Base44 defaults (Supabase/Firebase RLS gaps, exposed public keys in client bundles, IDOR, missing webhook verification, apps defaulting public). **C4 · SCA + secrets (P0, v1 — CONFIRMED)** — unmodified Semgrep/OSV/gitleaks as independent deps.
- **Bet 3 — Close the full agent-native loop:** **C5 · MCP server (P1, L)** — detect → exploit-validate → fix-PR → retest across Cursor/Claude Code/Windsurf/Codex/OpenCode; OAuth 2.1 (PKCE, RFC 8707/8693), `needsApproval` on mutating tools re-validated at execution; never "only we have MCP." **C6 · Prompt-injection defense (P0 before agent GA, M)** — treat target-controlled content as delimited untrusted data, least-privilege tools, scan the AI fix patch before opening a PR.
- **Bet 4 — Make the output a shareable trust artifact:** **C7 · Shareable report/badge (P1, M)** — public, revocable mini-SOC2 using `Report.shareTokenHash`+`revokedAt`+`shareExpiresAt` (schema present) + rate-limited token access; PLG viral loop. **C8 · Compliance-lite evidence pack (P2, M)** — auto-generated SOC2/GDPR-flavored evidence; honest claims (evidence, not certification).
- **Table-stakes:** PR comments; Slack/Discord alerts; one-click fix PRs; real free tier; GitHub Action + `workflow_call` reusable workflow with a diff-aware gate + Checks API annotations (this _is_ the pre-merge product — pull forward); AI autotriage/noise-reduction as a headline metric (quantify only once measured + founder-approved).

## B13.6 Backlog → sprint mapping (extends §B11 overlay)

**Batch 2 — DX & UX foundation (interleave with Sprint 3.5/4; mostly pre-worker):**

- **Sprint 2.6 — Shared component library** (B3) ✅ **DONE 2026-07-05**.
- **Sprint 2.7 — Frontend correctness & a11y** (A8) ✅ **DONE 2026-07-05** (keyboard a11y, responsive sidebar, dark mode tokens, mobile tables, aria attrs, nav-404 stubs for findings/fixes/scans/reports/settings; remaining: onboarding re-entry, aria-live banners, Zod enums).
- **Sprint 2.8 — Data-fetch + perf** (B1/B2/A6/B4) ✅ **DONE 2026-07-05** (server-fetched `initialData` + React `cache()` wrappers, cursor-based pagination on projects/targets/team APIs, typed API client helpers `apiGet`/`apiPost`/`apiPatch`/`apiDelete`/`apiGetPaginated` with `ApiError` class, `LoadMore` component with a11y). 6 deep code review fixes applied (api-client network/parse error handling, LoadMore a11y, raw fetch migration in projects/targets clients, cache memoization bug fix, onboarding double-loading flash fix). See `codebase.md` §19.

**Batch 3 — Design-in contracts before the worker (schema/interfaces, cheap now):**

- **Sprint 4.1 — Tenant-isolation hardening**: `Evidence.encryptionKeyRef` enforcement ✅ **DONE 2026-07-05** (`packages/db/src/evidence.ts`); `AuditLog` `prevHash` hash-chain (A9) ✅ **DONE 2026-07-05** (`packages/db/src/audit-hash.ts`, 21 tests); Postgres RLS ✅ **DONE 2026-07-05** — RLS enabled on all 17 workspace-scoped tables with permissive + strict policies, `withWorkspaceRLS(workspaceId, fn)` helper uses `SET LOCAL` inside a transaction (connection-safe with Prisma pooling), 9 tests in `rls.test.ts`, CI validates migration on Postgres 16. See `codebase.md` §19.
- **Sprint 4.2 — Cost/determinism + standards contracts** (B5/B6) ✅ **DONE 2026-07-05** (SARIF 2.1.0 types, dual CVSS v2/v3 score+vector fields on `Finding`, cost estimate + determinism mode fields on `Scan`, types in `packages/types/src/index.ts`). **Runtime update 2026-07-13:** positive dollar caps and mode-level Luna/Terra routing are implemented. Still open: complete multi-dimensional stop handling, diff-only default, within-scan cascade + prompt caching, fingerprint dedupe, and the independent verification layer.

**Sprint 4 — Scan Orchestrator + Queue:** ✅ **DONE 2026-07-05** — BullMQ scan queue (`apps/web/src/lib/queue.ts` producer, `apps/worker/src/queue.ts` consumer), preflight checks (`preflight.job.ts` — target existence, URL/repo config, concurrent scan guard), engine runner (`runner.ts` — child process with 30min timeout, 10MB output truncation, exit code mapping), command builder (`command-builder.ts`), output parser (`output-parser.ts` — vulnerabilities.json + run.json parsing, severity mapping, dedupe key generation), finding persister (`finding-persister.ts` — batch dedupe queries, encrypted evidence URIs), scan job processor (`run-scan.job.ts` — wraps entire job in `runWithWorkspaceContext`, state machine PREFLIGHT→RUNNING→VERIFYING→COMPLETED/FAILED), scan API routes (POST create, GET list with `scan.view` permission, GET by-id, POST cancel), scan detail UI with client-side polling (fetch every 5s, no `router.refresh()`), scan service with state machine transitions (`scan-service.ts`). `ScanJobData`/`ScanJobResult`/`SCAN_QUEUE_NAME` single source of truth in `@lyrashield/types`. `scan.view` permission added for VIEWER/AUDITOR read-only roles. Dockerfile runner stage cleaned up. CSP removed from request headers. 396 tests, 26 files. See `codebase.md` §21.

**Batch 4 — Differentiated build (worker/engine now available; sequence within Sprints 5–9 + the §22 agent sprints):**

- **✅ DONE 2026-07-06:** Fix proposals + GitHub PR creation (DB service, API routes, UI), retests (DB service, API routes), reports (HTML generation with 500-finding limit + truncation notice, download, share tokens), notifications (email/Slack/Discord/in-app channels with 10s timeouts, `createAndSendNotification` shared helper, worker notification functions, API routes, UI with type-colored badges), schedules (CRON-based scan scheduling, DB service, API routes, UI, `Schedule_targetId_fkey` migration), plain-language findings (CWE explanations for 8 common CWEs, severity-based generics, category labels, `technicalDetail` wiring, `explainFinding` function), permissions extended for all new features (MEMBER restricted from `notification.manage`/`schedule.delete`), code review fixes (10 issues: P1×2, P2×4, P3×4). 565 tests, 44 files. See `codebase.md` §22.
- **✅ DONE 2026-07-06 (Sprint 5):** Engine MVP — external `lyrashield-engine` binary already wired via `runner.ts` + `command-builder.ts`. No new code needed.
- **✅ DONE 2026-07-06 (Sprint 6):** Findings normalization — `normalizer.ts` with severity normalization (CRITICAL/HIGH/MEDIUM/LOW/INFO), CWE enrichment (40+ CWE mappings with OWASP categories), CVSS v3.1 score estimation, confidence scoring (0-100 based on PoC, code locations, CVE, technical analysis), false-positive risk assessment (high/medium/low), cross-source deduplication by dedupe key + severity + confidence, finding statistics aggregation. 14 tests. See `codebase.md` §23.
- **✅ DONE 2026-07-06 (Sprint 6.5):** SCA + secrets scanning (C4, v1) — `sca-scanner.ts` parses 7 dependency file formats (`package.json`, `package-lock.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`), queries OSV API with 10s timeout, maps severity from CVSS/database_specific, extracts CVE IDs + fixed versions, deduplicates by vuln ID, injectable `fetchFn` for testability, 5 tests; `secrets-scanner.ts` with 12 secret patterns (AWS keys, GitHub tokens, PEM keys, Slack tokens, Stripe keys, DB URLs, passwords, JWTs, Google API keys, generic API keys), walks repo ignoring `node_modules`/`.git`, redacts matched secrets, false-positive filtering via hint detection, 12 tests; `scanner-orchestrator.ts` runs SCA + secrets in parallel with engine findings, normalizes all findings, filters false positives, merges and sorts by severity, 5 tests; `run-scan.job.ts` updated to call orchestrator after engine run, `finding-persister.ts` accepts both `EngineVulnerability` and `NormalizedFinding` types, 7 updated tests. **653 tests (52 files).** See `codebase.md` §23.
- **✅ DONE 2026-07-06 (Sprint 7 — Tier 2):** AI-builder-aware URL scan (C3) — `url-scanner.ts` with 10 detectors (Supabase anon keys, Firebase config, exposed API keys, missing security headers, CORS misconfiguration, IDOR patterns, missing webhook verification, AI builder defaults, open redirects, repo webhook file check), wired into scanner orchestrator, 11 tests. Launch-readiness gate UI (C1) — dashboard page with score gauge, verdict card, severity breakdown, conditions & recommendations, sidebar nav. Shareable report/badge (C7) — public report page at `/reports/shared/[id]` with security badge (PASS/PASS_WITH_WARNINGS/FAIL), scan summary, findings by severity. MCP server (C5) — tools rewritten to make real API calls via `ToolHandlerContext` (apiBaseUrl, apiKey, injectable fetchFn), stdio JSON-RPC transport entry point, 5 tests. Prompt-injection defense (C6) — 27 patterns + sanitization (already built, 9 tests). GitHub Action diff-gate — `lyrashield-scan.yml` with secret detection, dependency audit, code issue detection, SARIF output, diff-gate decision (already built). **669 tests (54 files).** See `codebase.md` §24.
- **Remaining:** Compliance-lite evidence (C8), dogfood the Action on this repo (B7), billing, Security Copilot sidebar (Sprint 5.5), Visual Security Plan (Sprint 8.5).
- **✅ DONE 2026-07-06 (Sprint 3.5 + 7.6 — Agent Action Layer):** `AgentApproval` model + `ApprovalStatus` enum in Prisma schema with migration + RLS policy (18th RLS table). Agent action types in `@lyrashield/types`. `agent-approval-service.ts` in `@lyrashield/db`. `apps/agent` headless package with signed service token (HMAC-SHA256, 5-min TTL), `ActionRegistry` with permission checking + approval gate + audit logging, 6 actions (list-targets, run-scan, get-scan-status, list-findings, get-finding, explain-finding), inlined plain-language bridge, BullMQ scan queue enqueuing. Agent permissions added to all roles. Approval API routes. Deep code review: 7 fixes (approval actionName + inputHash verification, audit log fault isolation, scan enqueuing with Redis error handling, service token payload validation, static imports, policy validation, deny docs). 35 new tests. **781 tests (62 files).** See `codebase.md` §27.

### C1.6 Growth layer: LyraShield Score, public scorecards, and referrals (2026-07-12)

Implements spec Phases 0–2 of the "LyraShield Score, Shareable Scorecard & Referral System — Engineering Spec v1" (all 7 founder decisions resolved; Phases 3–4 deferred). See `codebase.md` §33 for the full implementation map.

- Deterministic, versioned score (`packages/score`, model `lyrashield-score/1.0.0`): deduction-only weights, grade bands with hard caps (open verified critical → max C, open verified high → max B, active verified secret → max D), ACCEPTED_RISK at 50% weight, 30-day snapshot expiry.
- Immutable `ScoreSnapshot` per completed scan (idempotent), wiring the previously dormant `Scan.riskScoreBefore/After` and `Project.riskScore` fields.
- Public scorecards: frozen allowlisted payload (grade, scope, scan date, model version, resolved-findings count — never open findings/CWEs/target URLs), unguessable slug, instant revocation, supersession notice, public methodology page, OG image endpoint. Share creation is RBAC-gated (OWNER/ADMIN/SECURITY_ADMIN/APPSEC_MANAGER), share-eligibility requires a STANDARD/DEEP scan and ≤25% triage ratio, and create/revoke are audit-logged.
- Referrals: per-user codes, cookie capture on public scorecards, attribution restricted to newly created accounts (no retroactive rewards), activation-gated dual-sided rewards of 30 agent minutes via idempotent `UsageRecord` entries (redeemable at billing GA), all transitions audit-logged.
- Phase 0 waitlist referral ladder on the marketing site (D1 migration `0003`), preserving the non-leaking identical-response contract for duplicate and honeypot submissions.
- Positioning guardrails hold: scorecard copy is scope-qualified, links the public methodology, and states the score "is not a security guarantee."
- Social distribution is merged in PR #52: dynamic scorecard metadata; grade/fix card variants in 1200×630 link-preview, 1080×1080 square, and 1080×1350 feed formats; native sharing plus LinkedIn, X, Bluesky, WhatsApp, Reddit, email, copy, download, and README badge actions; public conversion CTA; dashboard funnel counts; waitlist share actions/position; and client-handoff report copy. Individual cards remain `noindex`; the public methodology is the SEO authority.
- Growth measurement is deliberately narrow: `ScorecardEvent` accepts only `VIEW`/`SHARE` plus allowlisted channel, variant, and source values. It stores a one-way session hash and UTC day bucket, never target/repository/finding data, raw IP, user agent, or user-authored caption. Card/image crawlers are not human views; human events deduplicate by share/event/channel/session/day.
- Referral source survives the public scorecard → sign-up → onboarding claim path in a separate HttpOnly cookie. Attribution remains new-account-only, publisher-specific, no-self-referral, and activation-gated; sharing a scorecard is not itself a rewarded conversion.

### C1.17 Agentic coding-agent integration program: registry, `/api/v1`, CLI, agent rules, remote approval (2026-07-24 to 2026-07-31, PRs #181–#183, #185)

- Closes C5 (MCP server bet) beyond the stdio/remote-HTTP transport that already existed: `@lyrashield/mcp` was published to npm as `@lyrashield/mcp@0.2.0` (2026-07-24) with 14 tools (9 read, 5 write) and a fail-closed human-approval gate. PR #181 added `packages/agent-registry` as the single source of truth for all 24 supported coding agents (config path, format, root key, credential style, install strategy, gotchas, verified source URL), a curated `/api/v1` surface over 18 existing routes with a generated OpenAPI 3.1 spec, `@lyrashield/sdk` extracted from the MCP tool layer's HTTP client, and the `lyrashield` CLI (published unscoped, with `@lyrashield/cli` as an alias) with real one-command installers, a conformance test suite asserting every documented per-agent gotcha, and docs regenerated from the registry.
- PR #182 added `packages/agent-rules`: one canonical security policy rendered per agent family (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.windsurfrules`, `.github/copilot-instructions.md`, `.clinerules`, `skill.md`), written inside checksummed managed blocks so a re-run never clobbers a user's edits. `apps/worker/src/engine/scanners/agent-config-scanner.ts` was extended to scan the additional instruction-file names and paths.
- PR #183 wired the existing `AgentApproval` model to the remote MCP endpoint: a mutating tool call over Streamable HTTP now creates a pending approval with an `inputHash`, returns a non-error "awaiting human" result with an approval URL, and re-validates the hash on resume so an approved benign input cannot be swapped for a different one at execution — the fail-closed default is unchanged, this only adds a way to _get_ approval, not to skip it.
- Independent review (`docs/audits/2026-07-31-agent-integration-deep-review-v10.md`) found and closed two P0s before anything was published: the CLI SDK client double-prefixed every request path (`/api/v1/api/v1/...`, 404 on every API-calling command), and the agent-rules managed-block checksum was self-declared, so a forged block with a correctly-computed hash could hide malicious instructions from the scanner entirely — the checksum-strip was removed rather than hardened, since the underlying rules text already scans clean on its own merits. PR #185 (2026-07-31) also fixed two gaps in the same-day `Target.installationId` GitHub-App work (see AGENTS.md's 2026-07-31 entries): a caller-supplied `installationId` on `POST /api/targets` was trusted verbatim instead of verified against the workspace's own integration, and the `installation.deleted` webhook's exact-match cleanup could never match legacy targets with a `NULL` installationId, so those targets survived an App uninstall and stayed scannable after access was revoked — plus a round of CLI exit-code and web/marketing UX fixes.
- **Founder decisions, 2026-07-31:** claim both `lyrashield` (primary) and `@lyrashield/cli` (alias) on npm; land the registry/API-v1/CLI program as one PR since a registry with no installer is not a shippable unit on its own; defer agent-scoped identity and a per-agent trust record to a fast-follow once real install telemetry exists — no Prisma migration for agent identity landed in this program.
- **Not yet done:** the public npm publish itself is still gated on founder sign-off (names are verified available but unclaimed as of 2026-07-31); a manual install-and-load verification against three real agents beyond the ones already spot-checked (Windsurf, VS Code, OpenAI Codex, per the AGENTS.md entry above) is still open; five of the fifteen registered agents (JetBrains, Amp, PiCode, OpenClaw, Hermes) are `guided-manual` or `vendor-cli` only in the registry and must not be described in docs as having a one-command install.

### C1.23 Sprint 10 — BYOK Local/Desktop app and license server (2026-08-18 to 2026-08-20, Track B)

Sprint 10 Track B is merged to `main`. See `codebase.md` §73 for the full implementation map.

- **LyraShield Local/Desktop.** Tauri v2 desktop app (Rust core + React 19 frontend). One-time 1-year license, BYOK (customer's own AI — zero LLM COGS). All scan depths available (no Cloud-style depth gating — the customer's AI pays). Zero agent-minute metering. Privacy: scans run locally, no code/findings/keys leave the machine except explicit opt-in sync.
- **BYOK providers.** ChatGPT/OpenAI subscription sign-in (OAuth, delegated to engine CLI) + Azure OpenAI subscription (API key + endpoint in OS keychain). Local/self-hosted models deferred (engine requires GPT-5.6 Terra/Luna).
- **License signing.** ed25519 signed licenses with canonical JSON for deterministic signing. Golden-license test vector ensures Rust ↔ JS cross-platform parity. Azure Key Vault integration for production signing via managed identity. Fails closed if vault unreachable.
- **Offline grace + perpetual fallback.** App runs without network using cached signed license. After the 1-year update window, the app keeps running the last eligible build indefinitely; it just stops accepting newer updates. Revoked licenses never ride perpetual fallback.
- **Cloud sync (optional).** Opt-in connect to a LyraShield account → sync findings to the cloud dashboard. Entitlement: sync_addon SKU OR team_subscription OR Cloud plan. Cursor-based monotonicity. Nothing syncs by default.
- **Desktop release pipeline.** macOS universal DMG (Apple Developer ID signing + notarization) + Windows x64 NSIS (code signing). Engine revision pinned with immutability verification. Signed `latest.json` updater manifest on GitHub Releases.
- **Pricing.** Individual: $199 launch / $299 regular (3 machines, $59/seat/yr renewal). Team: $99/seat perpetual + $59/seat/yr renewal, or $149/seat/yr subscription. Cloud-sync add-on: $49/seat/yr. 10% off at 10+ seats. No refunds on Local licenses.

## C2. Phase 1 gaps and release gates

### C2.1 Required before a controlled product pilot

1. **Controlled scan proof:** current production Standard/Luna acceptance completed on 2026-08-21. Scan `cmt35aj1s000001hck9fmguzk` ran the pinned `ecryptoguru/OnboardingAI2` revision through the promoted worker in 11m 42s using Luna/medium only. The private ledger reconciled 184 requests to $0.597148 provider/billed cost under the $3.20 cap; the run retained 24 findings plus coverage/verification receipts and debited 12 agent-minutes. Zero findings were independently verified and the AI App Security layer reached its 200-file bound, so this is bounded runtime/accounting proof, not a security guarantee or universal coverage claim. An approved Deep/Terra run, private evidence-storage proof, monitoring, and capacity evidence remain separate gates.
2. **Transport-level egress control:** deployed 2026-08-21. The worker refresh path loads a Key Vault-backed proxy credential, DNS-pins the proxy into its allowlist, and the proxy accepts ingress only from the worker VM. External proxy health requests are denied. Preserve the separate negative arbitrary-fetch proof before expanding untrusted multi-tenant scanning.
3. **Production infrastructure:** production PostgreSQL, dedicated worker compute, the authenticated application origin, secrets, backup/restore, the worker-only egress proxy, and managed authenticated Upstash TLS TCP for BullMQ are live. The Internet-facing Azure `6379` rule was removed and the legacy Redis container was stopped after the replacement returned `PONG`, the queue was confirmed empty, and the actual worker passed the direct-denied / proxy-public-allowed / proxy-reserved-denied proof. PR #382 also made the DNS-pin refresh restart-safe; its timer remained active throughout the current Standard acceptance without restarting the worker. A literal private-network Redis endpoint remains an enterprise option. Mandatory private S3-compatible evidence proof, monitoring/capacity evidence, and the remaining infrastructure gates stay explicit. Apply every committed migration and replay the complete migration directory on a fresh database; command output and the directory are authoritative rather than copied counts. This includes scorecard events, approvals, evidence/result integrity, accounting, provider uniqueness, finding status reasons, UX state, OAuth/provider binding, API-spec support, and the final child-table RLS sequence. Reconcile legacy duplicate provider bindings before the uniqueness migration; evidence persistence fails closed until the configured `S3_*` endpoint succeeds.

### C2.2 Required before self-serve paid launch

1. **Billing and usage enforcement:** **implemented** (Sprint 10, merged to `main`). Polar + Razorpay dual-gateway, plan definitions, checkout, webhooks, subscription sync, usage metering, scan limits, trial, grace, and billing UI are in `packages/billing`, `packages/pricing`, and `apps/web/src/app/billing/`. Test credentials, maps, webhooks, signed-smoke delivery, and non-charge test objects are configured; live paid activation and live-provider entitlement/usage evidence remain separate.
2. **Abuse and cost controls:** per-scan dollar caps are enforced. Plan-aware scan quotas, concurrency entitlements, aggregate account/workspace budgets, and failure/retry ceilings remain required before offering a free or paid public tier. Trial abuse controls (email verification, disposable-email/proxy/device signals, one trial per user/org) are implemented.
3. **Production observability:** connect the implemented structured request/worker logs and health/readiness routes to actionable monitoring, product analytics, alerts, and incident/runbook ownership.
4. **Launch validation:** run browser, API, migration, backup/restore, queue recovery, worker cancellation, security-header, public-scorecard metadata/card/badge, revocation, referral, and event-deduplication smoke checks against the real deployed environment.

### C2.3 Marketing launch gate

1. **Complete:** `lyrashieldai.com` is the canonical HTTPS marketing domain; trademark clearance remains a founder/legal decision.
2. **Complete:** production Cloudflare D1, Rate Limit, KV, and `WAITLIST_IP_SALT` bindings are provisioned; migrations `0001`–`0003` are applied remotely.
3. **Complete:** Astro's generated Worker configuration is deployed to the apex and `www` custom domains with `PUBLIC_SITE_URL=https://lyrashieldai.com` and `PUBLIC_INDEXABLE=true`. Live waitlist/referral checks, canonical/schema metadata, sitemap/robots/`llms.txt`, headers, internal links, desktop Brave rendering, and representative mobile Lighthouse checks pass.
4. **Complete:** the active permanent `www`-to-apex redirect preserves path and query strings.
5. **Complete for the public marketing and Lite Scanner surface:** homepage, methodology, sample report, resource hub, five browser-local tools, and `/scan` are indexable. The scanner uses a separate protected Azure origin, Turnstile, origin-scoped CORS, rate limits, Supabase, Upstash, and a monitored abuse route. `/terms` remains excluded from the sitemap and individually `noindex`.
6. **Complete for open registration:** the authenticated app origin `https://app.lyrashieldai.com` accepts email and configured OAuth sign-up, and marketing links to sign-up/sign-in. Separately validate scorecard canonical/OG/Twitter metadata, all three image formats, script-free badge response, revoked/expired 404s, referral continuity, and human-event deduplication. Do not treat the live passive scanner as the full worker/engine pipeline or external-platform unfurl proof. Submit the sitemap in selected webmaster accounts once ownership access is available.
7. Publish only founder-approved posts and claims; no public pricing, unsupported metrics, exclusivity claims, or public naming of the upstream engine.
8. The 100-article authority program is live through PR #88. Every future article batch requires the full content/image/link/completeness gate, Worker-backed crawl and browser QA, final local approval, a focused PR, green CI, guarded deployment, and live canonical/sitemap/RSS/tag/image/schema verification.

### C2.4 Known follow-up debt

- Store the numeric GitHub installation ID on each target and use it for exact `installation.deleted` matching instead of repository-owner prefix matching.
- Add a database constraint and input validation requiring `Policy.maxBudgetUsd >= 0` when policy CRUD is exposed.
- Build the user-facing API-key create/list/revoke lifecycle before documenting API-key access as a product capability.
- Complete MCP client setup documentation and expand the tool catalog only when the corresponding approval-aware actions exist.
- Implement provider-backed GitHub installation ownership verification before re-enabling fresh callback binding, and a server-generated immutable patch/evidence pipeline before re-enabling Fix PR creation.
- Replace the current SSE-S3 key reference with a real KMS/Vault key reference when the production storage provider is selected.
- Add compliance-lite evidence packs and deeper IaC/container/reachability coverage after the pilot gates, based on customer demand.
- **Maintain the production Brevo binding while `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=1`.** Both `lyrashield-app` and `lyrashield-scanner` have the `brevo-api-key` secret and explicit `BREVO_API_KEY` secret reference; their readiness checks pass. The deployment workflow now fails before rollout when verification is enabled but either Container App lacks the pre-provisioned secret. Brevo IP security remains disabled at the account level because Azure Container Apps Consumption has a dynamic outbound NAT pool. See `docs/deployment/PRODUCTION_DEPLOYMENT.md` §1.
- **Run `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;` against the production `DATABASE_URL` connection** and confirm both are `false` before the next traffic-growth push. All 30 tenant-scoped tables (21 workspace tables plus 9 child tables) carry fail-closed RLS policies — note the 9 child tables were only actually enforcing them from `20260803000002_child_table_rls_enable`, since the preceding migration set `FORCE` without `ENABLE`, which Postgres treats as a no-op. Separately, `FORCE ROW LEVEL SECURITY` does not bind superusers or `BYPASSRLS` roles, and managed Postgres commonly hands out a superuser by default. See the same doc, §2.

## C3. Current sprint status

| Workstream                   | Status                             | Current truth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sprints 0–3 + 2.5            | Complete                           | Foundation, auth, tenancy, dashboard, onboarding, targets, team, GitHub App, account deletion/anonymization, and browser E2E are implemented.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Sprint 3.5 / 7.5             | Complete                           | Agent actions, service tokens, single-use approval persistence, approval APIs, verification controls, and controlling-terminal MCP approval are implemented.                                                                                                                                                                                                                                                                                                                                                                                             |
| Sprints 4–6.5                | Complete in code                   | Queue, fail-closed admission/reconciliation, bounded worker/scanner lifecycle, controlled engine derivative, normalization, batched SCA, secrets scanning, and idempotent evidence persistence are implemented. Current Standard/Luna production acceptance is complete; Deep/Terra, private evidence-storage, monitoring, and capacity proofs remain.                                                                                                                                                                                                   |
| Model routing and accounting | Complete; Standard proof complete  | Safe/Quick/Standard route to Luna/medium; Deep/Custom use Terra/medium coordination with Luna/high specialists; protected limits reach the engine; actual-model per-request standard/long-context/cache-read/cache-write buckets drive private reconciliation; the dashboard exposes no costs. The 2026-08-21 Standard acceptance used Luna/medium for all 184 requests and independently reconciled to $0.597148. Azure Foundry uses direct JSON function tools unless its explicit programmatic-tool gate passes; Deep/Terra production proof remains. |
| Growth layer                 | Complete                           | Score snapshots, public scorecards, referral attribution/rewards, premium social cards, badges, channel sharing, privacy-safe signed-cookie funnel events, waitlist referrals, and report handoff copy are implemented. Real-domain unfurl and production attribution QA remain release gates.                                                                                                                                                                                                                                                           |
| Sprints 7–9                  | Complete in code                   | Fix proposals, retests, immutable report snapshots, notifications, schedules, pinned URL scanning, aggregate launch readiness, sharing, and the exact-range diff gate are implemented. Fresh GitHub claims and Fix PR creation remain intentionally blocked pending their security proofs.                                                                                                                                                                                                                                                               |
| Sprint 5.5                   | Not started                        | Security Copilot sidebar remains deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Sprint 8.5                   | Not started                        | Visual Security Plan and recap remain deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Sprint 9.5                   | Core complete                      | MCP tools and stdio transport exist; broader client onboarding and tool coverage remain roadmap work.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Sprint 10                    | Complete in code                   | Cloud billing (Polar + Razorpay, trial, plans, metering, entitlements, grace), BYOK Local/Desktop (Tauri v2, ed25519 licenses, Key Vault, cloud sync, release pipeline), and Affiliate program (commission engine, attribution, payouts, dashboard) are implemented and merged to `main`. Production provisioning (provider credentials, webhook verification, payout API credentials) remains. See `codebase.md` §§71–74.                                                                                                                               |
| Sprint 11                    | Partial                            | UX/security hardening, privacy lifecycle, browser E2E, health/readiness, request instrumentation, serialized audit chaining, fail-closed evidence, prompt-injection guard hardening, queue unification, proxy trust, and Deep Review v4 correctness/UX remediation are done. Authenticated-app deployment, current Standard/Luna acceptance, backup/restore, managed TLS Redis, and transport-level egress proof are complete; private evidence-storage proof, failure-injection recovery, monitoring, and capacity evidence remain.                     |
| AI App Security (Release A)  | Partial / release evidence pending | The free deterministic tool and private score foundation exist. AI-03 fail-closed receipts, engine-bound LLM triage, calibration, governance extensions, live safety testing, final UX, and final CI/browser proof remain staged work. No certification, compliance, universal-safety, or “implemented and verified” claim is authorized. See `codebase.md` §70 and `docs/plans/2026-08-13-ai-app-security-scanner.md`.                                                                                                                                  |
| Phase 2                      | Not started                        | Enterprise identity, SCIM, advanced policy, private worker, VPC/self-hosting, BYOK/BYOM, and enterprise integrations remain roadmap work.                                                                                                                                                                                                                                                                                                                                                                                                                |

## C4. Product truth constraints

- A green unit/build gate is not proof of a successful sandbox scan.
- A healthy Docker stack is not proof that model credentials, sandbox image, egress controls, and engine artifacts work end to end.
- A schema model is not an implemented product feature: billing tables existing was once a foundation; billing is now implemented (Sprint 10), but production provider credentials and live webhook verification remain before paid launch.
- An indexable marketing Worker is not proof of the application runtime: app-origin deployment, scanner abuse controls, production scans, analytics interpretation, and external-platform unfurl validation remain separate gates.
- A generated OG image or local share preview is not proof that LinkedIn, X, Bluesky, WhatsApp, or other external caches render the latest card. Validate on the approved public HTTPS origin and use each platform's cache refresh/debug tooling when available.
- Scorecard views mean deduplicated browser sessions that executed the first-party event call. They do not mean impressions, unique people, crawler fetches, or verified referral conversions.
- Public scorecard and analytics payloads are strict disclosure boundaries. Never add target URLs, repository names, findings, IPs, user agents, or captions for attribution convenience.
- Shared reports are evidence summaries, not certifications. Do not claim SOC 2, GDPR, or other compliance certification from generated evidence.
- Do not claim verified-finding accuracy, noise reduction, speed, or exclusivity without measured, founder-approved evidence.

## C5. Ordered next work

1. Complete private S3-compatible evidence proof plus production monitoring and capacity evidence. Managed BullMQ TLS Redis, dedicated sandbox-capable worker compute, authenticated application origin, backup/restore, transport-level egress proof, and current Standard/Luna acceptance are complete.
2. Select and authorize the first controlled Deep/Terra target, then document its pinned-image, routing, cost, receipt, and terminal-state evidence separately from Standard/Luna acceptance.
3. **Sprint 10 is implemented and merged.** Test Polar/Razorpay credentials, product/price maps, webhook secrets, signed smoke delivery, and non-charge objects are configured. Remaining provisioning: live-provider entitlement/usage evidence, Azure Key Vault license-signing keypair deployment, RazorpayX/Payoneer payout API credentials, and tax-form verification workflow. Live paid activation remains founder-controlled.
4. Complete worker cancellation and queue recovery under production failure injection, then connect readiness/logging to actionable alerts and incident ownership.
5. Complete the separate app-origin scorecard/unfurl/referral gate on the approved public domains and submit the sitemap through selected webmaster accounts.
6. After pilot evidence, prioritize Security Copilot, visual plans, compliance-lite evidence, and Phase 2 features from real customer demand.
7. Build a private LyraShield engine evaluation corpus before changing agent architecture or making result-quality claims; measure expected findings/non-findings, evidence correctness, duplicate stability, control coverage, runtime, and token use separately for Luna and Terra.
8. Local/self-hosted model support for the BYOK desktop app is deferred pending engine work (the engine currently requires GPT-5.6 Terra/Luna).
