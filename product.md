# LyraShield — Product Features & USPs

> **For marketing, sales, and positioning use.** This document maps every feature to a buyer benefit and competitive differentiator.

---

## 1. Product Summary

### What it is

LyraShield is an **agent-native security platform for AI-built software**. It plugs into your repo, app, and coding agent to find verified vulnerabilities, explain them clearly, create fix PRs, and retest automatically.

### One-liner

```txt
Secure AI-built apps before they ship.
```

### Product promise

**For small teams and vibe coders:**

> Connect a GitHub repo or paste an app URL. LyraShield safely scans it, verifies real vulnerabilities, explains the risk, and helps create fix PRs.

**For enterprises:**

> Deploy an autonomous validated AppSec layer across code, apps, APIs, cloud, and infrastructure with SSO, RBAC, policies, audit logs, compliance reports, and private deployment.

### Core product loop

```txt
Target → Scan → Verified Finding → Fix → Retest → Report
```

---

## 2. Target Audiences

### Phase 1 — Vibe Coders, Solopreneurs, Small Teams

| Audience | Pain | What they want |
|----------|------|---------------|
| Vibe coders | Built app with AI, don't know if it's secure | "Is my app safe to launch?" |
| AI app builders | Used Cursor/Bolt/Lovable/v0, no security review | One-click security check |
| Indie hackers & solopreneurs | No security team, need to ship fast | Verified findings + fix PRs |
| Agencies & dev shops | Client asks "is this secure?" | Shareable security report |
| Small SaaS teams | Need continuous monitoring | Weekly scans + alerts |
| Early-stage startups | Investor asks about security | Security report for due diligence |
| Web3 + AI app builders | Smart contract + app security | Specialized skill packs |

### Phase 2 — Enterprise & Regulated Teams

| Audience | Pain | What they want |
|----------|------|---------------|
| AppSec teams | Too many noisy tools, too few verified findings | Verified, deduplicated findings |
| CISOs | Need governance and audit trail | Policies, RBAC, audit logs, compliance |
| Platform engineering teams | Need private deployment | VPC, self-hosted, private workers |
| Regulated SaaS (fintech, healthcare) | Compliance evidence requirements | SOC 2, ISO 27001, OWASP mapping |
| Large engineering orgs | Scale across teams | Multi-workspace, SCIM, SSO |
| MSPs and MSSPs | Multi-client management | Agency mode, white-label reports |

---

## 3. Unique Selling Propositions (USPs)

### USP 1: Verified findings, not noisy alerts

Every finding is exploit-validated by the LyraShield AI engine before it reaches the user. No false-positive firehose. Users see only confirmed vulnerabilities with proof.

**Competitive edge**: Semgrep, Snyk, and GitHub Code Scanning produce high false-positive rates. LyraShield verifies before reporting.

### USP 2: Security inside the AI coding loop

LyraShield's MCP server lets Cursor, Codex, Claude Code, Windsurf, and OpenCode call LyraShield directly. Security checks happen **during coding**, not after push.

**Competitive edge**: Every competitor scans post-push. LyraShield scans pre-merge from inside the AI coding agent.

### USP 3: Plain-language explanations for non-security people

Same finding, five explanation modes:

- **Founder mode**: "This bug lets users access another user's data. Fix before launch."
- **Developer mode**: "The /api/users/:id route trusts the path parameter. Add ownership validation using session.user.id."
- **Security engineer mode**: "Broken object-level authorization. Verified cross-tenant access. Maps to OWASP API1:2023."
- **Enterprise admin mode**: Policy impact, risk score, remediation SLA.
- **Auditor mode**: Verified weakness, evidence redacted, remediation and retest pending.

**Competitive edge**: No AppSec tool speaks to founders, developers, and auditors in their own language.

### USP 4: Fix PR + Retest + Visual Recap

Not just a fix suggestion — a complete review package:

```txt
Patch → Why it works → Files changed → Tests added →
Risk reduced → Retest result → Remaining risk → Reviewer checklist
```

Visual security recap generates a shareable link with diagrams, file maps, and retest results.

**Competitive edge**: Competitors stop at "here's the vulnerability." LyraShield delivers fix + proof + retest + explanation + review package.

### USP 5: Agent-native — every feature works everywhere

One action definition powers UI button, copilot chat, MCP tool, CLI command, HTTP API, and A2A protocol. Users interact with LyraShield however they prefer.

**Competitive edge**: No other AppSec tool is agent-native. They're all web-first with bolted-on APIs.

### USP 6: Human approval for high-risk actions

Agent can't create PRs, accept risk, run production deep scans, or delete targets without explicit human approval. The agent pauses, shows the exact action, and waits for Approve/Deny.

**Competitive edge**: Safe autonomy. Enterprise teams get agent speed without losing control.

### USP 7: One product, two depths

Same core loop serves vibe coders and enterprises. Vibe coders see "Is my app safe?" Enterprises see policies, RBAC, audit logs, private deployment, and compliance. No separate products.

**Competitive edge**: Competitors either serve developers OR enterprises. LyraShield serves both with one codebase.

---

## 4. Feature Catalog

### 4.1 Core Security Features

| Feature | Description | Benefit |
|---------|-------------|---------|
| **Repo target scanning** | Connect GitHub repo, scan code for vulnerabilities | Catch security bugs in source code |
| **URL target scanning** | Paste app URL, scan live web app/API | Find runtime vulnerabilities |
| **AI-driven pentest engine** | LyraShield engine (forked from Strix OSS) runs autonomous security agents | Deep, contextual security testing beyond static rules |
| **Verified findings** | Every finding is exploit-validated before reporting | No false-positive noise, only confirmed risks |
| **Evidence packaging** | HTTP req/res, screenshots, attack reproduction | Proof for stakeholders and compliance |
| **CVSS auto-scoring** | Automatic severity scoring with CVSS | Prioritize fixes by risk level |
| **Dedupe key generation** | Deterministic dedupe across scans | No repeated findings across runs |
| **SSRF protection** | URL targets validated against comprehensive blocklist | Prevent scanning of internal/metadata services |
| **Sandboxed execution** | Scan engine runs in isolated Docker sandbox | Safe execution, no blast radius |
| **Policy enforcement** | Network egress, destructive test, duration, approval controls | Enterprise-grade scan governance |

### 4.2 Fix & Remediation Features

| Feature | Description | Benefit |
|---------|-------------|---------|
| **Fix proposal generation** | AI generates minimal safe patch for verified finding | Developer doesn't need to research the fix |
| **GitHub PR creation** | One-click fix PR with human approval | Fix goes through normal code review |
| **Retest after fix** | Automatic re-scan after PR merge | Prove the fix works |
| **Visual security plan** | Attack path diagram, file map, patch plan before fix | Understand the vulnerability before fixing |
| **Visual security recap** | What changed, what was fixed, retest result, remaining risk after PR | Shareable review artifact for stakeholders |
| **Reviewer checklist** | Auto-generated checklist for PR reviewers | Review AI-generated security PRs safely |

### 4.3 Agent-Native Features

| Feature | Description | Benefit |
|---------|-------------|---------|
| **Security Copilot sidebar** | Page-aware agent assistant on every dashboard page | Ask questions about current finding/scan/target in plain English |
| **MCP server for coding agents** | LyraShield tools available in Cursor, Codex, Claude Code, Windsurf, OpenCode | Security checks during coding, not after push |
| **Agent actions** | Every core operation exposed as `defineAction()` | One action powers UI, chat, MCP, CLI, HTTP, A2A |
| **Human approval gates** | `needsApproval` on create-fix-pr, production deep scan, accept-risk, send-report, delete-target | Safe agent autonomy for enterprise |
| **A2A coordination** | Agent-to-agent protocol for enterprise agent ecosystems | LyraShield agent coordinates with other enterprise agents |
| **Security skills** | Reusable skill packs for common stacks (Next.js, Supabase, Firebase, Stripe, etc.) | Catch stack-specific vulnerabilities |
| **Agent audit trail** | Every agent action logged with who/when/surface/thread | Enterprise governance for agent actions |

### 4.4 Dashboard & Workflow Features

| Feature | Description | Benefit |
|---------|-------------|---------|
| **Multi-workspace** | Separate workspaces for different teams/clients | Agency and enterprise team isolation |
| **Project organization** | Group targets by project | Organize scanning by product/service |
| **Target management** | Repo and URL targets with environment tagging (local/staging/production) | Scan the right thing at the right time |
| **Team invitations** | Invite members with role-based access | Collaborate on security |
| **RBAC** | 10 roles: Owner, Admin, Security Admin, AppSec Manager, Developer, Member, Viewer, Auditor, Billing Admin, External Pentester | Fine-grained access control |
| **Live scan timeline** | Real-time scan events streamed to UI | Watch the scan progress |
| **Finding detail page** | Severity, status, evidence, CWE, CVSS, fix proposal | Everything about a finding in one place |
| **Scan history** | Historical scan results with trend tracking | Track security posture over time |
| **Dashboard risk score** | Aggregate risk score across targets | Quick security health check |
| **Empty/loading/error states** | Polished UX with retry buttons | Professional experience |

### 4.5 Notification & Monitoring Features

| Feature | Description | Benefit |
|---------|-------------|---------|
| **Email notifications** | Scan complete, critical finding, fix PR created | Stay informed without watching dashboard |
| **Slack notifications** | Real-time alerts in Slack channels | Team-wide visibility |
| **Discord notifications** | Alerts in Discord servers | Community and dev team alerts |
| **Weekly monitoring** | Scheduled recurring scans | Continuous security protection |
| **Security score trends** | Track risk score over time | Show improvement to stakeholders |

### 4.6 Reporting & Compliance Features

| Feature | Description | Benefit |
|---------|-------------|---------|
| **Executive summary reports** | Plain-language security report for non-technical stakeholders | Share with clients, investors, board |
| **Technical reports** | Detailed findings with evidence, CWE, CVSS | For security teams and auditors |
| **Shareable report links** | Public link to security report | Send to clients without an account |
| **PDF export** | Download reports as PDF | Compliance and archival |
| **Interactive report rooms** | Agent Q&A on report findings | Clients ask "What is the highest risk?" and get answers |
| **Compliance mapping** | OWASP Top 10, CWE, SOC 2, ISO 27001 | Map findings to compliance frameworks |
| **Audit logs** | Every action logged with actor, timestamp, surface | Enterprise governance and forensics |

### 4.7 Integration Features

| Feature | Description | Benefit |
|---------|-------------|---------|
| **GitHub App** | Install on org/repo for PR scanning | Automated PR security checks |
| **GitHub OAuth** | Sign in with GitHub | Frictionless onboarding |
| **Google OAuth** | Sign in with Google | Frictionless onboarding |
| **Linear integration** | Create Linear tickets from findings | Track security work in project management |
| **Jira integration** | Create Jira tickets from findings | Enterprise project tracking |
| **Slack integration** | Alerts and notifications | Team-wide security visibility |
| **Microsoft Teams** | Alerts and notifications | Enterprise communication |
| **ServiceNow** | Ticket creation for enterprise ITSM | Enterprise service management |
| **Splunk / Sentinel / Datadog** | SIEM export for security operations | Integrate with existing SOC tooling |
| **Vanta / Drata** | Compliance automation integration | Feed security evidence into compliance platforms |

### 4.8 Enterprise & Governance Features (Phase 2)

| Feature | Description | Benefit |
|---------|-------------|---------|
| **SAML SSO** | Enterprise identity provider integration | Single sign-on for large orgs |
| **OIDC SSO** | OpenID Connect identity provider | Modern SSO standard |
| **SCIM provisioning** | Automated user provisioning/deprovisioning | Manage access at scale |
| **Advanced RBAC** | 10-role hierarchy with permission matrix | Fine-grained access control |
| **Policy engine** | Network egress, destructive tests, duration limits, approval requirements, PII redaction, evidence retention | Govern scanning behavior |
| **Production scan approval** | Require explicit approval for production scans | Prevent risky scans on production |
| **BYOK (Bring Your Own Key)** | Use your own LLM API key | Control costs and data residency |
| **BYOM (Bring Your Own Model)** | Use your own LLM model | Meet data sovereignty requirements |
| **Private worker** | Dedicated scan worker in customer VPC | Scan private repos and internal apps |
| **VPC deployment** | Deploy LyraShield in customer VPC | Data never leaves customer network |
| **Self-hosted (Helm)** | Deploy on Kubernetes with Helm chart | Full infrastructure control |
| **GitHub Enterprise** | Connect to GitHub Enterprise Server | Enterprise repo scanning |
| **GitLab self-managed** | Connect to GitLab self-managed | Enterprise repo scanning |
| **Azure DevOps** | Connect to Azure DevOps repos | Microsoft ecosystem scanning |
| **Evidence retention controls** | Configure how long evidence is stored | Compliance and data minimization |
| **Admin dashboard** | Org-wide view of scans, findings, users, policies | Centralized enterprise management |

### 4.9 Billing & Plans

| Feature | Description | Benefit |
|---------|-------------|---------|
| **Free plan** | Limited scans for trying out | Zero barrier to entry |
| **Pro plan** | Individual developer with more scans | Solo founder security |
| **Team plan** | Small team with collaboration | Team-wide security |
| **Agency plan** | Multi-client management | Agency security offering |
| **Business plan** | Growing teams with more targets | Scaling security |
| **Enterprise plan** | SSO, private worker, custom everything | Enterprise-grade security platform |

---

## 5. Competitive Differentiation

### vs. Semgrep

| Dimension | Semgrep | LyraShield |
|-----------|---------|------------|
| Finding quality | Static analysis, noisy | AI-verified, exploit-validated |
| Fix capability | AI Autofix suggestions | Full fix PR + retest + visual recap |
| Agent-native | No | Yes — MCP, copilot sidebar, A2A |
| Coding agent integration | No | Yes — Cursor, Codex, Claude Code, Windsurf |
| Vibe coder UX | Requires security knowledge | Plain-language explanations |
| Enterprise | Strong | SSO, RBAC, policies, private worker, self-hosted |

### vs. Aikido Security

| Dimension | Aikido | LyraShield |
|-----------|--------|------------|
| Finding quality | Aggregated from multiple scanners | AI-verified, deduplicated |
| Agent-native | No | Yes — every feature is agent-callable |
| Coding agent integration | No | Yes — MCP tools inside coding agents |
| Fix workflow | AI AutoFix suggestions | Fix PR + retest + visual recap + reviewer checklist |
| Copilot | No | Page-aware security copilot with 5 explanation modes |
| Market positioning | Unified security platform | Agent-native security for AI-built apps |

### vs. GitHub Security (Code Scanning + Dependabot + Copilot Autofix)

| Dimension | GitHub Security | LyraShield |
|-----------|----------------|------------|
| Finding quality | Static analysis, dependency alerts | AI-driven pentest + exploit validation |
| Scan depth | SAST, SCA, secrets | Full AI pentest (code + app + API + cloud) |
| Agent-native | No | Yes — MCP, copilot, A2A, CLI |
| Outside GitHub | No (GitHub-only) | Yes — GitLab, Azure DevOps, URL targets |
| Fix workflow | Copilot Autofix (inline suggestion) | Fix PR + retest + visual recap + reviewer checklist |
| Vibe coder UX | Developer-focused | Founder/developer/security/auditor modes |
| Enterprise | Strong (GitHub-native) | Private worker, VPC, self-hosted, BYOK/BYOM |

### vs. Snyk

| Dimension | Snyk | LyraShield |
|-----------|------|------------|
| Finding quality | Static analysis, dependency scanning | AI-verified, exploit-validated |
| Fix capability | Fix PR suggestions | Full fix PR + retest + visual recap |
| Agent-native | No | Yes — MCP, copilot, A2A |
| Coding agent integration | No | Yes — inside Cursor, Codex, Claude Code |
| Pentest capability | No | Yes — AI-driven pentest engine |
| Vibe coder UX | Developer-focused | Plain-language for non-security people |

---

## 6. Market Positioning

### Positioning statement

```txt
For AI-built software that needs to ship fast,
LyraShield is the agent-native security platform
that finds verified vulnerabilities, explains them clearly,
creates fix PRs, and retests automatically —
from inside your repo, your app, and your coding agent.
```

### Category

```txt
Agent-native AppSec
```

### Taglines

```txt
Primary:    Secure AI-built apps before they ship.
Alt 1:      The security copilot for vibe coding and autonomous engineering teams.
Alt 2:      Verified security findings. Fix PRs. Retest. Done.
Alt 3:      Security that lives inside your AI coding loop.
Alt 4:      Ship AI-built apps without security debt.
```

### Category alternatives (for SEO and positioning)

```txt
AI AppSec platform
AI vulnerability scanner
AI pentest tool
Security copilot for developers
Agent-native security
Vibe coding security gate
AI code security
```

---

## 7. Messaging by Audience

### For vibe coders

```txt
Headline: Is your AI-built app safe to launch?
Subhead: Connect your repo. LyraShield scans it, explains risks in plain English, and creates fix PRs.
CTA: Check if my app is safe to launch
```

Key messages:
- No security knowledge needed
- Plain-language explanations
- One-click fix PRs
- "Can I launch?" as the primary question

### For developers

```txt
Headline: Security checks inside your coding agent.
Subhead: LyraShield plugs into Cursor, Codex, and Claude Code. Scan diffs, explain risks, generate fixes — without leaving your editor.
CTA: Install LyraShield MCP
```

Key messages:
- MCP tools for coding agents
- Pre-merge security checks
- Fix PRs with retest
- No context switching

### For agencies & dev shops

```txt
Headline: Give your clients a security report they'll trust.
Subhead: Scan client apps, get verified findings, generate shareable reports with evidence and retest results.
CTA: Start scanning client apps
```

Key messages:
- Multi-workspace for multi-client
- Shareable report links
- White-label ready
- Verified findings with evidence

### For enterprise security teams

```txt
Headline: Agent-native AppSec across your engineering org.
Subhead: Verified findings, fix PRs, audit trails, policies, and private deployment. LyraShield wraps your existing workflow with agent-native security.
CTA: Deploy agent-native AppSec across your engineering org
```

Key messages:
- SSO, RBAC, SCIM
- Policy engine and audit logs
- Private worker and VPC deployment
- Compliance reports (SOC 2, ISO 27001, OWASP)
- BYOK/BYOM for data sovereignty

### For CISOs

```txt
Headline: Govern AI security agents without losing control.
Subhead: Human approval gates on every consequential action. Full audit trail. Policy enforcement. Private deployment.
CTA: Book enterprise demo
```

Key messages:
- Human-in-the-loop approval for high-risk actions
- Agent audit trail (who, when, which surface, which agent)
- Policy-controlled action permissions
- SIEM export for SOC integration

---

## 8. Key Workflows to Showcase

### Workflow 1: "Is my app safe to launch?"

```txt
Connect GitHub repo
  → Run Launch Safety Check
  → Get 3 outputs:
    1. Can I launch? (Yes/No)
    2. What must I fix first? (Prioritized list)
    3. Create fix PR (One click)
  → Fix PRs merged
  → Retest
  → Visual security recap
  → Share with stakeholders
```

### Workflow 2: Security inside Cursor

```txt
Developer writes feature with AI coding agent
  → Agent calls LyraShield MCP: check-diff
  → LyraShield finds insecure auth pattern
  → Agent calls: explain-finding
  → Agent calls: generate-fix-plan
  → Agent applies patch
  → Agent calls: verify-fix
  → PR created with security recap
```

### Workflow 3: Enterprise production scan with approval

```txt
Security admin creates production scan policy
  → Agent attempts DEEP scan on production target
  → needsApproval gate triggers → pauses
  → Admin clicks Approve in dashboard
  → Scan runs → findings normalized
  → Report generated with compliance mapping
  → Audit log records entire flow
```

### Workflow 4: Client security report for agency

```txt
Agency connects client repo
  → Runs full pentest scan
  → Findings verified and deduplicated
  → Generates executive summary report
  → Shareable link sent to client
  → Client asks "What's the highest risk?" in interactive report room
  → Agency creates fix PRs
  → Retest → updated report
```

---

## 9. Security Skills Marketplace (Roadmap)

Stack-specific security skill packs that catch common mistakes in popular frameworks:

| Skill | What it catches |
|-------|----------------|
| Next.js Security | Middleware bypass, SSRF in API routes, unsafe server actions |
| Supabase RLS | Missing row-level security policies, public table access |
| Firebase Rules | Insecure Firestore rules, wildcard access |
| Better Auth Security | Session misconfiguration, missing email verification |
| Clerk Security | Missing route protection, insecure middleware |
| Stripe/Razorpay Payments | Webhook signature verification bypass, payment manipulation |
| Webhook Security | Missing signature verification, replay attacks |
| OpenAI App Security | API key leakage, prompt injection, SSRF via tools |
| Prompt Injection | System prompt bypass, tool injection, data exfiltration |
| File Upload Security | Unrestricted file type, path traversal, stored XSS |
| Web3 Smart Contract | Reentrancy, access control, integer overflow |
| Multi-Tenant SaaS | Tenant isolation bypass, IDOR, cross-tenant data access |
| Healthcare Compliance | PHI exposure, missing audit logging, insecure data handling |
| Fintech Compliance | PCI DSS violations, sensitive data in logs, missing encryption |

---

## 10. Pricing Strategy Summary

| Plan | Target | Key features | Price point |
|------|--------|-------------|-------------|
| Free | Trying out | 1 workspace, 3 scans/month, basic findings | $0 |
| Pro | Solo founders | 1 workspace, 50 scans/month, fix PRs, reports | ~$29/mo |
| Team | Small teams | 3 members, 200 scans/month, Slack alerts, team roles | ~$99/mo |
| Agency | Dev shops | 10 workspaces, 500 scans/month, white-label reports | ~$299/mo |
| Business | Growing teams | 25 members, unlimited scans, Jira/Linear, scheduled scans | ~$599/mo |
| Enterprise | Large orgs | SSO, SCIM, private worker, VPC, BYOK, policies, audit | Custom |

---

## 11. Technical Trust Signals

- **Open-source foundation**: Built on Strix OSS (AI pentesting CLI), forked and rebranded
- **Sandboxed execution**: Scan engine runs in isolated Docker containers
- **SSRF protection**: Comprehensive blocklist with IPv6, metadata service, and trailing-dot checks
- **RBAC with 10 roles**: Fine-grained permission matrix
- **Audit logging**: Every sensitive action logged with actor, timestamp, and surface
- **Human approval gates**: High-risk actions require explicit human approval
- **BYOK/BYOM**: Enterprise controls LLM keys and models
- **Private deployment**: VPC and self-hosted Helm chart for data sovereignty
- **Type-safe end-to-end**: Zod schemas validate every input across UI, API, agent, and MCP
- **Multi-tenant isolation**: Workspace-scoped data access enforced at database query level

---

## 12. Roadmap Highlights

### Shipped (Sprint 0-2)

- Monorepo foundation (Next.js 16, TypeScript 6, Prisma 7, Better Auth)
- Full Prisma schema with 20+ models
- Auth with email/password + GitHub OAuth + Google OAuth
- Dashboard with sidebar and workspace switcher
- Project, target, and team management
- SSRF-validated URL target creation
- Audit logging for all operations
- RBAC with 10 roles and permission matrix

### Next up (Sprint 3-5)

- GitHub App integration for PR scanning
- Scan orchestrator with Redis/BullMQ queue
- LyraShield scan engine MVP (structured JSON findings, exit codes, event streaming)

### Agent-Native layer (Sprint 3.5-9.5)

- Agent action layer (every core operation as `defineAction()`)
- Security Copilot sidebar with page-aware context
- Human approval gates for high-risk actions
- Visual security plans and recaps
- MCP server for Cursor, Codex, Claude Code, Windsurf, OpenCode

### Enterprise (Sprint 12-19)

- SAML/OIDC SSO, SCIM provisioning
- Policy engine with production scan approval
- Audit logs and compliance reports
- Private worker and VPC deployment
- Self-hosted Helm chart
- BYOK/BYOM
- Enterprise integrations (Jira, ServiceNow, Splunk, Sentinel, Vanta, Drata)
