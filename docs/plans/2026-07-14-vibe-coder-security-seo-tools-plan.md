# Vibe-Coder Security SEO, AEO, GEO, and Free-Tools Plan

Date: 2026-07-14
Status: free-tool foundation implemented locally; editorial plan remains draft-only and no page is approved for publication
Owner: founder + marketing + engineering
Primary audience: AI-assisted solo builders, small SaaS teams, and agencies shipping AI-built apps

## 1. Outcome

Build one durable authority page, 99 supporting articles, and a product-led `/tools` surface with five useful free tools. The system should capture search demand around securing AI-generated applications, answer questions clearly enough to be cited by AI search engines, and move qualified builders from a free diagnosis into LyraShield AI's implemented workflow:

`Target -> Scan -> Verified Finding -> Fix PR -> Retest -> Report`

This plan does not promise pricing, a free product tier, benchmark results, customers, or a production-ready controlled scan. The five browser-local tools are implemented and locally browser-tested; they remain noindex until the public-domain launch gate passes. Every article remains `draft: true` until the founder approves it, the public domain is final, and the real-domain marketing launch gate passes.

## 2. Evidence base and limitations

The July 14 `/last30days` run searched the 30-day window from 2026-06-13 through 2026-07-13 and returned 209 items across Reddit, YouTube, TikTok, Instagram, Threads, Pinterest, Hacker News, GitHub, and Digg. The strongest recent community themes were exposed frontend secrets, open Supabase/Firebase data, missing server-side authorization, absent input validation, unreviewed dependencies, and unsafe agent permissions.

Research artifact: `/Users/defiankit/Documents/Last30Days/security-issues-faced-by-vibe-coders-building-ai-generated-applications-raw-v3.md`

Important limits:

- X had no working authentication backend, so the research must not claim X coverage.
- Only two of six YouTube results had transcripts. Video titles and descriptions are weaker evidence than transcript-backed material.
- Much of the social corpus is promotional or anecdotal. The list below is an editorial priority ranking, not a prevalence study.
- The priority score combines repeated community discussion, potential impact, distinct search intent, and LyraShield product fit.
- Technical claims in published posts must be verified against primary sources such as OWASP, CWE, vendor documentation, advisories, and original research.

Primary corroboration:

- [Understanding the (In)Security of Vibe-Coded Applications](https://arxiv.org/abs/2606.23130) reports recurring placeholder logic, unfiltered input, secret exposure, agent memory loss, locally optimized objectives, and insufficient security knowledge in real vibe-coded applications.
- [OWASP Secure Coding with AI Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html) covers hallucinated dependencies, prompt injection, agent permissions, sandboxing, context leakage, test fabrication, supply-chain risk, and human accountability.
- [OWASP Inappropriate Trust in AI Generated Code](https://owasp.org/Top10/2025/X01_2025-Next_Steps/) requires human understanding and security review of AI-assisted code.
- [GitHub security validation for third-party coding agents](https://github.blog/changelog/2026-06-09-security-validation-for-third-party-coding-agents/) confirms the practical need for code scanning, dependency checks, and secret scanning on agent-generated changes.

## 3. Top 50 security issues to own editorially

| Rank | Security issue                                     | What the builder commonly sees                                                            | Why it is a strong topic                                                   |
| ---: | -------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
|    1 | Missing database row-level security                | A second account can read or change the first account's records                           | The clearest recent community test and a direct data-breach risk           |
|    2 | IDOR / broken object-level authorization           | Changing an ID in a URL or API request exposes another user's object                      | Common CRUD happy-path code omits ownership checks                         |
|    3 | API keys exposed in frontend bundles               | OpenAI, Stripe, Supabase service, or other secrets appear in browser JavaScript           | Repeated recent incident pattern with immediate user harm                  |
|    4 | Client-side-only authentication                    | Hiding a button or trusting localStorage is treated as access control                     | Vibe tools optimize the visible UI while skipping the server boundary      |
|    5 | Missing server-side authorization                  | A logged-in user can call privileged endpoints directly                                   | Authentication is present, but permission checks are absent                |
|    6 | Cross-tenant data leakage                          | Workspace A can access Workspace B data                                                   | Multi-tenant scoping is easy to omit from generated queries                |
|    7 | Unprotected admin and internal routes              | `/admin`, debug, or maintenance APIs work for ordinary users                              | Generated scaffolds often expose convenience routes                        |
|    8 | Broken JWT and session validation                  | Tokens are decoded but not verified, expire incorrectly, or accept the wrong issuer       | Libraries look simple while secure validation is configuration-heavy       |
|    9 | Password reset and email-verification flaws        | Reset tokens are reusable, predictable, leaked, or verification is bypassable             | Auth generators prioritize completion over abuse cases                     |
|   10 | Unsafe password storage                            | Plaintext, reversible encryption, or weak hashing stores credentials                      | Severe impact and highly answerable educational intent                     |
|   11 | SQL injection                                      | User-controlled input reaches raw SQL or unsafe query composition                         | Still appears when agents bypass ORM safety for a quick fix                |
|   12 | Cross-site scripting                               | Untrusted HTML, Markdown, or rich text renders as executable code                         | AI apps commonly render model and user output                              |
|   13 | Missing input validation                           | APIs accept unexpected fields, types, sizes, or formats                                   | One of the strongest recent vibe-code research findings                    |
|   14 | Permissive CORS                                    | `*` or reflected origins expose credentialed APIs                                         | A common "make it work" development workaround that survives launch        |
|   15 | Missing CSRF protection                            | Authenticated state changes can be triggered from another site                            | Cookie-based auth is often added without request-origin defenses           |
|   16 | Server-side request forgery                        | URL fetchers reach private IPs, metadata services, or redirect into internal networks     | Especially relevant to URL scanners, importers, webhooks, and AI tools     |
|   17 | Unsafe file uploads                                | Attackers upload executable, oversized, spoofed, or public files                          | Generated upload flows often validate only the extension                   |
|   18 | Path traversal                                     | Filenames or archive entries escape the intended directory                                | AI-written filesystem code frequently trusts joined paths                  |
|   19 | Command injection                                  | User-controlled values reach shells, package scripts, or subprocesses                     | Agentic apps and build tools increase shell exposure                       |
|   20 | OAuth redirect and callback mistakes               | Open redirects, state mismatch, or callback-domain confusion leaks access                 | Easy to misconfigure in generated social-login flows                       |
|   21 | Missing rate limits                                | Login, signup, reset, AI, upload, and webhook endpoints are unbounded                     | Recent community summaries explicitly cite zero rate limiting              |
|   22 | Brute force and account enumeration                | Error messages reveal accounts and attackers can retry indefinitely                       | Natural follow-on to auth and rate-limit demand                            |
|   23 | Unverified Stripe webhooks                         | Forged events grant access or mark orders paid                                            | High commercial intent among SaaS builders                                 |
|   24 | Payment and entitlement logic bypass               | The browser decides plan, price, credit, or access state                                  | Generated checkout UIs can obscure the missing server source of truth      |
|   25 | Mass assignment                                    | Extra JSON fields change role, ownership, price, or status                                | Schema validation is often missing from generated CRUD APIs                |
|   26 | Replay, race, and idempotency failures             | Duplicate webhooks, clicks, or concurrent requests create repeated rewards or charges     | Happy-path tests rarely exercise concurrency                               |
|   27 | Missing security headers                           | CSP, HSTS, frame, MIME, and referrer controls are absent or weak                          | Strong free-tool intent and low-friction product entry                     |
|   28 | Insecure cookies                                   | Session cookies lack Secure, HttpOnly, SameSite, or correct scope                         | A concrete misconfiguration users can verify                               |
|   29 | Weak transport security                            | HTTP, permissive mobile transport exceptions, or invalid TLS survives production          | Recent practitioner discussion includes development bypasses shipping live |
|   30 | Public-by-default apps, buckets, and databases     | Internal tools, storage, or previews are indexed and reachable                            | Directly matches recent exposed-app reporting                              |
|   31 | Verbose errors and debug endpoints                 | Stack traces, environment values, SQL, or internal paths leak to users                    | Development defaults commonly survive AI-assisted launch                   |
|   32 | Source maps and build-artifact leakage             | Proprietary source, routes, or secrets ship in maps and packages                          | A distinct AI-build pipeline blind spot                                    |
|   33 | Sensitive data in logs and analytics               | Tokens, prompts, PII, and request bodies enter third-party telemetry                      | High trust and privacy relevance                                           |
|   34 | Missing audit trails                               | Teams cannot prove who changed access, created a scan, or approved an action              | Important for incident response and agency handoff                         |
|   35 | Missing monitoring and alerts                      | A breach, scan failure, queue stall, or critical finding is silent                        | Moves users from launch check to continuous protection                     |
|   36 | Missing backup and recovery proof                  | An agent or user deletes production data with no tested restore                           | Recent agent incidents make this tangible                                  |
|   37 | Vulnerable or outdated dependencies                | AI suggests versions with known CVEs                                                      | OWASP and GitHub both treat dependency validation as a core control        |
|   38 | Hallucinated or malicious packages                 | A plausible package name installs the wrong or malicious dependency                       | Specific AI-assisted software supply-chain risk                            |
|   39 | Unsafe install scripts and dependency supply chain | Post-install scripts or transitive packages gain excessive access                         | Strong bridge from SCA to agent permissions                                |
|   40 | Secrets leaked through AI prompts and context      | `.env`, credentials, PII, or proprietary code enters model context                        | Current evidence includes full repository and `.env` upload concerns       |
|   41 | Indirect prompt injection                          | Repositories, issues, web pages, or documents instruct the agent to exfiltrate or act     | Distinct agentic risk with growing search demand                           |
|   42 | Over-permissioned MCP tools                        | Tools expose filesystem, network, shell, or mutations without approval                    | Direct fit with LyraShield's approval-gated MCP design                     |
|   43 | Missing agent sandbox and egress controls          | A coding agent can read host files or reach arbitrary destinations                        | Strong recent discussion around secure agent runtimes                      |
|   44 | Destructive production permissions                 | Agents can delete databases, files, deployments, or tests                                 | High-impact and understandable founder concern                             |
|   45 | Poisoned rules and instruction files               | Repository instructions silently disable checks or expand scope                           | AI-specific change-control and prompt-supply-chain risk                    |
|   46 | AI-generated test fabrication and blind spots      | Tests pass because they assert the generated bug or omit abuse cases                      | OWASP explicitly warns against trusting generated tests as proof           |
|   47 | CI/CD confused deputy                              | An agent workflow uses broad tokens to perform unintended writes                          | Directly relevant to autonomous PR and deployment workflows                |
|   48 | Multi-agent propagation                            | One poisoned result spreads through sub-agents and downstream tasks                       | Emerging risk worth owning before it becomes generic content               |
|   49 | Placeholder logic and silent business failures     | Stubs, fake success paths, invented defaults, or incorrect calculations appear functional | A core finding of the June 2026 empirical study                            |
|   50 | No accountable human review or threat model        | Nobody can explain, own, or safely change the shipped code                                | The root workflow failure behind most other issues                         |

## 4. Content architecture

### 4.1 Authority page

Canonical URL: `/blog/vibe-coding-security-guide`
Working title: **Vibe Coding Security: The Complete Guide to Securing AI-Built Apps**
Primary query: `vibe coding security`
Secondary entities: AI-generated code security, AI app security, secure vibe coding, Cursor security, Lovable security, Replit security, Bolt security
Length: 2,500-3,000 words; target 2,800
Intent: informational with high product-evaluation adjacency

Required structure:

1. A 50-70 word direct answer defining vibe-coding security.
2. A concise "what fails most often" table led by data access, authorization, secrets, input validation, and dependency risk.
3. The six-layer model: identity/access, data/secrets, input/execution, payments/business logic, delivery/supply chain, agentic controls.
4. A pre-launch checklist with links to the five free tools.
5. A "how LyraShield AI approaches the problem" section describing only implemented code truth and clearly labeling the controlled-scan release gate.
6. A fix-and-retest workflow, not a scanner-only pitch.
7. Primary-source citations and a visible last-updated date.
8. Four genuine FAQs with concise standalone answers.
9. Links to the six cluster indexes, not a wall of 99 links.
10. CTA: use a relevant free tool first; secondary CTA to sign in/join the approved launch flow.

Internal-link rule: every supporting article #2-#100 includes one contextual link to this authority page in its first third. The authority page links back to the strongest 3-5 articles per cluster and to all five tools. This gives most posts a clean hubward link without turning the authority page into a directory.

### 4.2 Reusable article template for posts #2-#100

Every 1,200-1,500 word post uses the existing Astro collection and `BlogPost.astro` layout:

1. H1 from frontmatter, with no second H1 in the body.
2. 40-80 word answer-first opening.
3. "What this looks like" symptom or minimal vulnerable pattern.
4. "Why AI-generated code misses it" explanation.
5. Safe verification steps that do not target a real unpatched system.
6. Minimal fixed pattern and edge cases.
7. "What automated tools can and cannot prove" honesty block.
8. Contextual link to the authority page.
9. Link to one free tool and one closely related article.
10. Two to four frontmatter FAQs only when they add distinct questions.
11. Primary sources and material `updatedDate` changes.

Do not add a new CMS or programmatic content framework. The current Markdown/MDX collection, draft flag, FAQ schema, sitemap, RSS, canonical logic, and tag-overlap related posts already cover this plan.

## 5. The 100-blog map

All supporting posts target 1,200-1,500 words. "Pillar" in the Link column means the article must link to `/blog/vibe-coding-security-guide`.

|   # | Working title / slug                                                                                | Primary query and intent                        | Cluster      | Words | Link / tool CTA                       |
| --: | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------ | ----: | ------------------------------------- |
|   1 | Vibe Coding Security: The Complete Guide / `vibe-coding-security-guide`                             | vibe coding security - definitive guide         | Authority    | 2,800 | Links to all clusters and tools       |
|   2 | Supabase RLS for Vibe-Coded Apps / `supabase-rls-vibe-coded-apps`                                   | supabase rls security - fix                     | Access       | 1,400 | Pillar + RLS Checker                  |
|   3 | How to Find IDOR in an AI-Built App / `idor-ai-built-apps`                                          | idor vulnerability test - how-to                | Access       | 1,350 | Pillar + Launch Checklist             |
|   4 | Stop Exposing API Keys in Frontend Code / `api-keys-frontend-ai-apps`                               | exposed api key frontend - fix                  | Secrets      | 1,300 | Pillar + Secret Scanner               |
|   5 | Why Client-Side Auth Is Not Access Control / `client-side-auth-not-security`                        | client side authentication security - explainer | Access       | 1,300 | Pillar + Launch Checklist             |
|   6 | Server-Side Authorization for AI-Generated APIs / `server-side-authorization-ai-apis`               | backend authorization - implementation          | Access       | 1,400 | Pillar + Launch Checklist             |
|   7 | Prevent Cross-Tenant Data Leaks / `multi-tenant-data-isolation`                                     | multi tenant data isolation - fix               | Access       | 1,450 | Pillar + RLS Checker                  |
|   8 | Secure Admin Routes in AI-Built Apps / `secure-admin-routes`                                        | secure admin routes - how-to                    | Access       | 1,300 | Pillar + Launch Checklist             |
|   9 | JWT Validation Mistakes AI Tools Generate / `jwt-validation-mistakes`                               | jwt security best practices - fix               | Auth         | 1,400 | Pillar + JWT Inspector                |
|  10 | Secure Password Reset and Email Verification / `password-reset-email-verification-security`         | password reset security - how-to                | Auth         | 1,400 | Pillar + Launch Checklist             |
|  11 | Password Hashing for Vibe Coders / `password-hashing-vibe-coders`                                   | how to store passwords securely - explainer     | Auth         | 1,300 | Pillar + Launch Checklist             |
|  12 | SQL Injection in AI-Generated Code / `sql-injection-ai-generated-code`                              | ai generated sql injection - fix                | Input        | 1,400 | Pillar + Launch Checklist             |
|  13 | XSS in AI Apps That Render Markdown or Model Output / `xss-ai-app-markdown-output`                  | ai app xss markdown - fix                       | Input        | 1,450 | Pillar + Launch Checklist             |
|  14 | Input Validation for AI-Generated APIs / `input-validation-ai-generated-api`                        | api input validation - how-to                   | Input        | 1,350 | Pillar + Launch Checklist             |
|  15 | CORS for Vibe-Coded Apps / `cors-vibe-coded-apps`                                                   | cors configuration security - fix               | Web          | 1,300 | Pillar + Headers Checker              |
|  16 | CSRF Protection for Cookie-Based AI Apps / `csrf-cookie-auth-ai-apps`                               | csrf protection cookie auth - how-to            | Web          | 1,350 | Pillar + Launch Checklist             |
|  17 | SSRF Protection That Resolves DNS / `ssrf-protection-dns-redirects`                                 | ssrf prevention dns rebinding - technical       | Input        | 1,500 | Pillar + full app scan CTA            |
|  18 | Secure File Uploads in AI-Built Apps / `secure-file-uploads-ai-apps`                                | secure file upload - how-to                     | Input        | 1,400 | Pillar + Launch Checklist             |
|  19 | Prevent Path Traversal in Generated File Code / `path-traversal-generated-code`                     | path traversal prevention - fix                 | Input        | 1,300 | Pillar + full app scan CTA            |
|  20 | Command Injection in Agentic App Workflows / `command-injection-agentic-apps`                       | command injection prevention - fix              | Agent        | 1,400 | Pillar + full app scan CTA            |
|  21 | Secure OAuth Redirects and Callbacks / `oauth-redirect-callback-security`                           | oauth redirect uri security - how-to            | Auth         | 1,350 | Pillar + Launch Checklist             |
|  22 | Rate Limiting for AI Apps / `rate-limiting-ai-apps`                                                 | ai api rate limiting - how-to                   | Web          | 1,400 | Pillar + Launch Checklist             |
|  23 | Stop Brute Force and Account Enumeration / `brute-force-account-enumeration`                        | prevent account enumeration - fix               | Auth         | 1,300 | Pillar + Launch Checklist             |
|  24 | Verify Stripe Webhook Signatures / `stripe-webhook-signature-security`                              | stripe webhook signature verification - how-to  | Payments     | 1,350 | Pillar + Launch Checklist             |
|  25 | Keep Pricing and Entitlements Off the Client / `payment-entitlement-server-source-truth`            | saas entitlement security - explainer           | Payments     | 1,400 | Pillar + full app scan CTA            |
|  26 | Prevent Mass Assignment in CRUD APIs / `mass-assignment-crud-api`                                   | mass assignment vulnerability - fix             | Input        | 1,300 | Pillar + Launch Checklist             |
|  27 | Idempotency and Replay Protection for SaaS / `idempotency-replay-protection`                        | webhook idempotency security - how-to           | Payments     | 1,400 | Pillar + Launch Checklist             |
|  28 | Security Headers Every AI-Built App Needs / `security-headers-ai-built-apps`                        | security headers checker - tool-led             | Web          | 1,300 | Pillar + Headers Checker              |
|  29 | Secure Session Cookies / `secure-session-cookie-settings`                                           | secure cookie settings - how-to                 | Auth         | 1,300 | Pillar + JWT Inspector                |
|  30 | TLS and Mobile Transport Security / `tls-mobile-transport-security`                                 | mobile app transport security - explainer       | Web          | 1,350 | Pillar + Headers Checker              |
|  31 | Public-by-Default Deployments and Storage / `public-by-default-ai-apps`                             | ai app exposed data - prevention                | Data         | 1,400 | Pillar + Launch Checklist             |
|  32 | Remove Debug Routes and Verbose Errors / `debug-routes-error-leaks`                                 | stack trace information disclosure - fix        | Data         | 1,300 | Pillar + Launch Checklist             |
|  33 | Stop Shipping Source Maps and Private Build Artifacts / `source-map-build-artifact-security`        | source map security production - fix            | Supply chain | 1,350 | Pillar + Secret Scanner               |
|  34 | Keep PII and Secrets Out of Logs / `sensitive-data-logging`                                         | pii in logs security - prevention               | Data         | 1,350 | Pillar + Secret Scanner               |
|  35 | Audit Logs for Security-Sensitive Actions / `security-audit-log-design`                             | security audit log best practices - how-to      | Operations   | 1,400 | Pillar + product audit trail          |
|  36 | Monitoring and Alerts Before Launch / `security-monitoring-ai-apps`                                 | app security monitoring checklist - how-to      | Operations   | 1,350 | Pillar + schedules/notifications      |
|  37 | Prove Backup and Restore Before Agents Touch Production / `backup-restore-agentic-apps`             | backup restore test - how-to                    | Operations   | 1,400 | Pillar + Launch Checklist             |
|  38 | Audit AI-Suggested Dependencies for CVEs / `ai-dependency-vulnerability-audit`                      | ai generated dependencies security - how-to     | Supply chain | 1,400 | Pillar + product SCA                  |
|  39 | Hallucinated Packages and Slopsquatting / `hallucinated-packages-slopsquatting`                     | ai hallucinated package security - explainer    | Supply chain | 1,350 | Pillar + product SCA                  |
|  40 | Secure Install Scripts and Transitive Dependencies / `install-script-supply-chain-security`         | npm postinstall security - how-to               | Supply chain | 1,400 | Pillar + product SCA                  |
|  41 | What Never to Paste Into an AI Coding Tool / `secrets-ai-coding-prompts`                            | ai coding assistant privacy secrets - checklist | Agent        | 1,300 | Pillar + Secret Scanner               |
|  42 | Indirect Prompt Injection in Repositories and Web Pages / `indirect-prompt-injection-coding-agents` | coding agent prompt injection - explainer       | Agent        | 1,450 | Pillar + MCP security                 |
|  43 | Least-Privilege MCP Tools / `least-privilege-mcp-tools`                                             | mcp security permissions - how-to               | Agent        | 1,400 | Pillar + product MCP                  |
|  44 | Sandboxing and Egress Control for Coding Agents / `coding-agent-sandbox-egress`                     | coding agent sandbox security - guide           | Agent        | 1,500 | Pillar + product approval model       |
|  45 | Keep AI Agents Away From Production Deletes / `agent-production-permissions`                        | ai agent database deletion prevention - guide   | Agent        | 1,400 | Pillar + approvals/audit              |
|  46 | Protect AGENTS.md and Rules Files From Poisoning / `agent-rules-file-security`                      | ai coding rules prompt injection - guide        | Agent        | 1,400 | Pillar + MCP security                 |
|  47 | Why AI-Generated Tests Are Not Security Proof / `ai-generated-tests-security`                       | ai generated tests security - explainer         | Verification | 1,350 | Pillar + verified findings            |
|  48 | Prevent CI/CD Agents From Becoming a Confused Deputy / `cicd-agent-confused-deputy`                 | agentic ci security - guide                     | Agent        | 1,450 | Pillar + GitHub diff gate             |
|  49 | Stop Prompt Injection From Spreading Across Agents / `multi-agent-prompt-injection`                 | multi agent security - guide                    | Agent        | 1,400 | Pillar + MCP security                 |
|  50 | Find Placeholder Logic and Silent Failures / `placeholder-logic-silent-failures`                    | ai generated code silent failure - guide        | Verification | 1,400 | Pillar + retest workflow              |
|  51 | Human Review and Threat Modeling for Vibe Coding / `human-review-threat-model-vibe-coding`          | vibe coding threat model - guide                | Verification | 1,450 | Pillar + Launch Checklist             |
|  52 | Secure a Cursor-Built App Before Launch / `cursor-app-security-checklist`                           | cursor app security - checklist                 | Workflow     | 1,400 | Pillar + Launch Checklist             |
|  53 | Secure a Claude Code Project / `claude-code-security-workflow`                                      | claude code security - workflow                 | Workflow     | 1,400 | Pillar + product MCP                  |
|  54 | Secure an OpenAI Codex Project / `codex-security-workflow`                                          | codex security - workflow                       | Workflow     | 1,400 | Pillar + product MCP                  |
|  55 | Secure a Windsurf Project / `windsurf-security-workflow`                                            | windsurf security - workflow                    | Workflow     | 1,400 | Pillar + Launch Checklist             |
|  56 | Secure a Lovable App Before Launch / `lovable-app-security-checklist`                               | lovable app security - checklist                | Workflow     | 1,400 | Pillar + RLS Checker                  |
|  57 | Secure a Bolt App Before Launch / `bolt-app-security-checklist`                                     | bolt app security - checklist                   | Workflow     | 1,400 | Pillar + Launch Checklist             |
|  58 | Secure a Replit App Before Launch / `replit-app-security-checklist`                                 | replit app security - checklist                 | Workflow     | 1,400 | Pillar + Headers Checker              |
|  59 | Secure a v0-Generated App / `v0-app-security-checklist`                                             | v0 app security - checklist                     | Workflow     | 1,350 | Pillar + Secret Scanner               |
|  60 | Secure a Base44 App Before Launch / `base44-app-security-checklist`                                 | base44 security - checklist                     | Workflow     | 1,400 | Pillar + Launch Checklist             |
|  61 | Secure Supabase Auth, RLS, and Service Keys / `supabase-security-guide`                             | supabase security checklist - guide             | Stack        | 1,500 | Pillar + RLS Checker                  |
|  62 | Secure Firebase Rules and Storage / `firebase-security-guide`                                       | firebase security rules checklist - guide       | Stack        | 1,450 | Pillar + Launch Checklist             |
|  63 | Secure a Next.js App Generated by AI / `nextjs-ai-app-security`                                     | nextjs security checklist - guide               | Stack        | 1,450 | Pillar + Headers Checker              |
|  64 | Secure React Frontends Without Trusting the Browser / `react-frontend-security-ai-code`             | react frontend security - guide                 | Stack        | 1,400 | Pillar + Secret Scanner               |
|  65 | Secure Node and Express APIs Generated by AI / `node-express-ai-api-security`                       | express api security checklist - guide          | Stack        | 1,450 | Pillar + Launch Checklist             |
|  66 | Secure FastAPI Code Generated by AI / `fastapi-ai-generated-security`                               | fastapi security checklist - guide              | Stack        | 1,450 | Pillar + Launch Checklist             |
|  67 | Secure Vercel Deployments and Preview URLs / `vercel-deployment-security`                           | vercel security checklist - guide               | Stack        | 1,350 | Pillar + Headers Checker              |
|  68 | Secure Cloudflare Workers Built With AI / `cloudflare-workers-ai-security`                          | cloudflare workers security - guide             | Stack        | 1,450 | Pillar + Headers Checker              |
|  69 | Secure GitHub Actions Used by Coding Agents / `github-actions-coding-agent-security`                | github actions ai agent security - guide        | Stack        | 1,450 | Pillar + GitHub diff gate             |
|  70 | Build a Secure MCP Server / `secure-mcp-server-guide`                                               | mcp server security - guide                     | Stack        | 1,500 | Pillar + product MCP                  |
|  71 | Secure an AI SaaS With Stripe / `ai-saas-stripe-security`                                           | ai saas stripe security - guide                 | Stack        | 1,500 | Pillar + Launch Checklist             |
|  72 | AI App Pre-Launch Security Checklist / `ai-app-prelaunch-security-checklist`                        | ai app security checklist - checklist           | Verification | 1,400 | Pillar + Launch Checklist             |
|  73 | The Two-Account Test for Data Isolation / `two-account-idor-test`                                   | test app authorization two accounts - how-to    | Verification | 1,250 | Pillar + Launch Checklist             |
|  74 | Secret Scanning Before Every Commit / `secret-scanning-before-commit`                               | secret scanning git - how-to                    | Verification | 1,300 | Pillar + Secret Scanner               |
|  75 | Dependency Scanning With OSV and Lockfiles / `osv-dependency-scanning`                              | osv dependency scanner - how-to                 | Verification | 1,350 | Pillar + product SCA                  |
|  76 | SAST vs DAST vs SCA for AI-Built Apps / `sast-dast-sca-ai-apps`                                     | sast vs dast vs sca - comparison intent         | Verification | 1,400 | Pillar + full app scan CTA            |
|  77 | A Security Review Prompt That Does Not Replace Testing / `ai-security-review-prompt`                | security review prompt for ai code - template   | Verification | 1,300 | Pillar + Launch Checklist             |
|  78 | Threat Modeling for Non-Security Founders / `threat-model-ai-startup`                               | startup threat model template - guide           | Verification | 1,400 | Pillar + Launch Checklist             |
|  79 | Why Every Security Fix Needs a Retest / `security-fix-retest-workflow`                              | security retesting - explainer                  | Verification | 1,350 | Pillar + product retest               |
|  80 | How to Verify a Security Finding / `verify-security-finding`                                        | verify vulnerability finding - guide            | Verification | 1,400 | Pillar + verified findings            |
|  81 | SARIF for AI Coding Workflows / `sarif-ai-coding-workflow`                                          | sarif security results - guide                  | Verification | 1,350 | Pillar + product SARIF                |
|  82 | Add a Security Diff Gate to Pull Requests / `security-diff-gate-pull-requests`                      | pull request security gate - how-to             | Verification | 1,400 | Pillar + GitHub diff gate             |
|  83 | Build a Go / No-Go Security Launch Gate / `security-launch-readiness-gate`                          | security launch readiness checklist - guide     | Verification | 1,400 | Pillar + launch readiness             |
|  84 | Create a Security Report for a Client Handoff / `client-security-report-handoff`                    | client security report template - guide         | Verification | 1,350 | Pillar + product reports              |
|  85 | Schedule Weekly Security Checks / `weekly-security-scan-workflow`                                   | scheduled security scan - guide                 | Operations   | 1,300 | Pillar + schedules/notifications      |
|  86 | What to Do With a Critical Finding / `critical-security-finding-response`                           | critical vulnerability remediation - guide      | Operations   | 1,350 | Pillar + fix/retest                   |
|  87 | Is AI-Generated Code Safe for Production? / `ai-generated-code-production-safety`                   | is ai generated code safe - answer              | Decision     | 1,400 | Pillar + Launch Checklist             |
|  88 | When a Vibe-Coded Prototype Becomes Production / `prototype-to-production-security`                 | prototype production security checklist - guide | Decision     | 1,400 | Pillar + Launch Checklist             |
|  89 | What Not to Share With AI Coding Assistants / `ai-coding-assistant-data-privacy`                    | ai coding assistant privacy - checklist         | Decision     | 1,350 | Pillar + Secret Scanner               |
|  90 | How to Review an AI-Generated Pull Request / `review-ai-generated-pull-request`                     | ai code review checklist - guide                | Decision     | 1,450 | Pillar + GitHub diff gate             |
|  91 | Privacy Checklist for AI-Built Apps / `ai-app-privacy-checklist`                                    | ai app privacy checklist - checklist            | Decision     | 1,400 | Pillar + Launch Checklist             |
|  92 | Security Reviews for Agencies Shipping Client Apps / `agency-client-app-security-review`            | agency app security review - commercial         | Audience     | 1,400 | Pillar + product reports              |
|  93 | Security for Solo Founders Who Vibe Code / `solo-founder-vibe-coding-security`                      | vibe coding security for founders - guide       | Audience     | 1,400 | Pillar + Launch Checklist             |
|  94 | Secure Internal Tools Built by Non-Developers / `secure-ai-built-internal-tools`                    | ai built internal tool security - guide         | Audience     | 1,450 | Pillar + full app scan CTA            |
|  95 | Secure Public AI API Endpoints / `secure-public-ai-api-endpoints`                                   | ai api security checklist - guide               | Decision     | 1,450 | Pillar + Launch Checklist             |
|  96 | What an App Security Score Can and Cannot Mean / `app-security-score-explained`                     | app security score - explainer                  | Decision     | 1,350 | Pillar + LyraShield Score methodology |
|  97 | Reduce Security Scanner False Positives / `security-scanner-false-positives`                        | security false positives - guide                | Decision     | 1,400 | Pillar + verified findings            |
|  98 | How to Prioritize Security Findings / `prioritize-security-findings`                                | vulnerability prioritization - guide            | Decision     | 1,400 | Pillar + findings workflow            |
|  99 | Share a Security Report Without Leaking Details / `share-security-report-safely`                    | share security report safely - guide            | Decision     | 1,350 | Pillar + scorecards/reports           |
| 100 | Rotate and Recover From an Exposed API Key / `exposed-api-key-incident-response`                    | exposed api key what to do - urgent how-to      | Operations   | 1,350 | Pillar + Secret Scanner               |

## 6. `/tools` product-led SEO surface

### 6.1 Hub page

URL: `/tools`
Title: `Free Security Tools for AI-Built Apps | LyraShield AI`
H1: `Free security tools for AI-built apps`
Purpose: route users by problem, not by product feature.

Hub sections:

1. "Check before launch" - launch checklist and headers checker.
2. "Protect data and access" - RLS checker and JWT/session inspector.
3. "Stop secret leaks" - browser-local secret scanner.
4. "Need a complete review?" - honest explanation of what the free tools cannot verify and how the app's scan -> finding -> fix -> retest -> report loop differs.
5. Detailed product-tool inventory from §7.
6. FAQ covering privacy, limitations, no-guarantee language, and whether inputs leave the browser.

Use `CollectionPage` + `ItemList` JSON-LD on the hub. Each individual tool page uses `WebApplication`, `BreadcrumbList`, and visible FAQ content when present. Do not add schema for capabilities that are not visible on the page.

### 6.2 Five free tools

| Tool                                  | URL and primary query                                           | Minimal implementation                                                                                                                 | Output                                                                                                        | Privacy and safety boundary                                                                                          | Product bridge                                          |
| ------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| AI App Launch Security Checklist      | `/tools/ai-app-security-checklist`; `ai app security checklist` | Client-side weighted questionnaire using a versioned JSON checklist                                                                    | Layer scores, missing checks, prioritized next actions, printable result                                      | No code or target data; local state only by default; result is guidance, not a security grade or guarantee           | CTA to register a repo/URL for a real scan              |
| Security Headers and CORS Checker     | `/tools/security-headers-checker`; `security headers checker`   | Cloudflare Worker fetch of a public HTTPS URL with strict SSRF validation, redirect limits, response-size/time caps, and rate limiting | CSP, HSTS, frame, MIME, referrer, permissions, cookie, and CORS observations                                  | Reject private/reserved/unresolvable IPs at every redirect; never render response body; do not store target URL      | CTA to URL scanning and launch readiness                |
| Browser-Local Secret Exposure Scanner | `/tools/secret-exposure-scanner`; `api key leak checker`        | Native browser File API/TextDecoder plus maintained deterministic patterns; no upload                                                  | File/line/type findings, redacted previews, rotation steps                                                    | Code never leaves the device; cap file size/count; never echo full secrets; explain false positives                  | CTA to repository secret scanning and verified findings |
| Supabase RLS Policy Checker           | `/tools/supabase-rls-checker`; `supabase rls checker`           | Browser-local SQL text lint using a small explicit ruleset, not a full SQL parser                                                      | Missing enable/force RLS, permissive policies, `SECURITY DEFINER`, ownership-check, and service-role warnings | No database connection and no SQL upload; clearly label heuristic limits                                             | CTA to full repository/API scan and two-account retest  |
| JWT and Session Inspector             | `/tools/jwt-session-inspector`; `jwt decoder security`          | Browser-local Base64URL decode plus deterministic claim/cookie checklist                                                               | Header/claim display, expiry/audience/issuer observations, algorithm and cookie guidance                      | Never send or persist tokens; warn users not to paste live production tokens; decoding is not signature verification | CTA to auth/authorization scan and finding explanation  |

The lazy implementation is the correct implementation here: native browser APIs, existing Astro/Cloudflare runtime, existing Zod, and small deterministic rules. Add no new dependency unless the RLS checker later proves it needs a real parser. Security and privacy controls are not simplified away.

### 6.3 Standard tool-page anatomy

1. Answer-first definition and supported input.
2. Interactive tool above the fold.
3. Plain-language result with severity labels that do not imitate a verified LyraShield Score.
4. "What this checks" and "What this cannot prove."
5. Remediation steps and links to 3-5 relevant articles.
6. Privacy disclosure adjacent to the input, not buried in a footer.
7. CTA matched to the gap: repo scan, URL scan, findings, or retest.
8. Two to four genuine FAQs.
9. Stable, self-canonical URL and unique social image.

## 7. Detailed explanation of implemented app tools

The `/tools` hub should include this product inventory below the free utilities. It must distinguish implemented code from release readiness.

| Product capability                   | What it does                                                                                        | User value                                                         | Honest boundary                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Repository and URL targets           | Registers a GitHub repository or deployed URL as a scan target                                      | One workflow for code and reachable applications                   | URL targets skip repository-only scanners by design                                   |
| Scan modes and budgets               | Routes Safe/Quick/Standard to Luna and Deep/Custom to Terra with positive spend caps                | Lets a team choose review depth while controlling spend            | This is mode routing, not a within-scan Luna-to-Terra cascade                         |
| Scan orchestration and preflight     | Queues scans, validates targets, blocks unsafe URLs and concurrent runs, records lifecycle events   | A traceable scan rather than a black-box request                   | Local Safe scan completed; production controlled-scan evidence remains a release gate |
| SCA dependency scanning              | Finds supported manifests, resolves dependencies, batches OSV checks, and emits normalized findings | Identifies known vulnerable components                             | It does not replace every ecosystem-specific package tool                             |
| Secret scanning                      | Walks repository sources within bounds and identifies secret patterns                               | Catches committed credentials and tokens                           | No public detection-rate claims; users must rotate exposed credentials                |
| URL checks                           | Applies public-target SSRF safety and URL-oriented security checks                                  | Useful for deployed apps without repository access                 | Application checks are not transport-level egress control                             |
| Finding normalization                | Converts engine, SCA, secret, and URL results into a consistent finding model                       | One triage queue across scanners                                   | Normalization is not proof by itself                                                  |
| Verified findings and evidence       | Stores evidence, verification state, code locations, checksums, and encrypted artifact references   | Helps users distinguish demonstrated risk from scanner noise       | A score or report is not a security guarantee                                         |
| Plain-language explanations          | Explains what a finding is, why it matters, and how to address it                                   | Makes AppSec usable for founders and developers                    | Explanations remain scoped to the evidence available                                  |
| Fix proposals                        | Creates a structured remediation proposal for a finding                                             | Turns a problem into an actionable change plan                     | Users still review security-sensitive changes                                         |
| GitHub fix PRs                       | Opens a pull request from an approved fix proposal                                                  | Moves remediation into the existing developer workflow             | PR creation is approval- and permission-gated                                         |
| Retests                              | Re-runs validation after a fix and records the result                                               | Proves whether the change addressed the original finding           | A passing retest is scoped to that finding and test                                   |
| Immutable reports                    | Generates developer, executive, or supported report views from creation-time snapshots              | A stable handoff for teams, clients, or stakeholders               | Reports do not silently rebuild from later mutable state                              |
| LyraShield Score                     | Produces a deterministic versioned 0-100 score and grade after qualifying scans                     | A concise summary of scoped security posture                       | Fully public methodology; never describe it as a guarantee                            |
| Public scorecards, cards, and badges | Creates opt-in, revocable, privacy-allowlisted public artifacts                                     | Lets teams share verified progress without exposing findings       | Cards omit targets, open findings, CWEs, and private details                          |
| Launch readiness                     | Returns NOT_EVALUATED, GO, GO_WITH_CONDITIONS, or NO_GO from current scan/finding state             | Helps a team make a release decision                               | It stays NOT_EVALUATED until a scan completes                                         |
| Schedules                            | Creates recurring target scans with bounded cron validation                                         | Moves from one-off review to continuous checks                     | Production queue recovery and capacity still need target-environment proof            |
| Notifications                        | Sends in-app and configured external notifications for scan and finding events                      | Brings critical results into existing workflows                    | Provider availability must not rewrite completed scan truth                           |
| GitHub diff gate and SARIF           | Checks the exact base-to-head range and exports standard results                                    | Adds security feedback to pull requests and code-scanning surfaces | It complements, not replaces, dedicated point tools                                   |
| MCP tools                            | Exposes scan target, get findings, get launch readiness, and create report through JSON-RPC stdio   | Lets coding agents call LyraShield from their workflow             | Mutations require controlling-terminal approval and fail closed without it            |
| Agent actions                        | Lists targets, runs scans, gets scan state, lists/gets findings, and explains findings              | A permissioned automation surface                                  | Deep scans and sensitive mutations are approval-gated and audited                     |
| Workspaces, RBAC, and audit chaining | Scopes data/actions by workspace and records tamper-evident audit history                           | Supports teams without weakening tenant boundaries                 | Enterprise SCIM/SSO/private-worker features remain roadmap items                      |
| Privacy lifecycle                    | Supports account deletion/anonymization and privacy-minimized public analytics                      | Reduces unnecessary personal-data retention                        | Public analytics remain coarse product-funnel diagnostics                             |

Do not describe billing, quotas, enterprise identity, Security Copilot sidebar, visual security plans, private workers, VPC deployment, or BYOK/BYOM as available. They are not implemented.

## 8. Technical implementation plan

### Phase 0 - launch prerequisites

1. Founder approves the public domain, trademark direction, publication voice, and tool claims.
2. Production `PUBLIC_SITE_URL` is public HTTPS and `PUBLIC_INDEXABLE=true` only after the real-domain QA gate.
3. Cloudflare D1 and rate-limit placeholders are replaced and `WAITLIST_IP_SALT` is a Worker secret.
4. Google Search Console and Bing Webmaster Tools properties are created after the canonical domain is final.
5. Establish six stable tags: `vibe-coding-security`, `access-control`, `web-security`, `supply-chain`, `agent-security`, `verification`. Avoid one-off tags.

### Phase 1 - authority and information architecture

1. Add `/tools` to the header and footer only when the hub exists.
2. Build the authority post as `draft: true` and validate it against `BLOG_AUTHORING.md`.
3. Add five cluster sections to the blog index or a dedicated topic directory only if discovery becomes weak. Do not create thin tag pages for every keyword.
4. Use the existing blog schema. No frontmatter changes are required for the first tranche.
5. Add contextual authority links manually in each post. A build-time auto-injected paragraph would be repetitive and weaker for users.

### Phase 2 - free-tool foundation

Minimum file shape:

- `apps/marketing/src/pages/tools/index.astro`
- five explicit tool pages under `apps/marketing/src/pages/tools/`
- one shared `ToolLayout.astro`
- one small `tools.ts` metadata array for hub cards and sitemap-consistent labels
- tool-specific components only where interaction is required
- focused unit tests for deterministic rules and Worker tests for the URL fetch boundary

Reuse `Base.astro`, `SeoHead.astro`, `JsonLd.astro`, existing styles, Zod, PostHog, and Cloudflare bindings. Do not add React, a new form library, a CMS, or a generic plugin system.

Security tests required before launch:

- headers checker: private IPv4/IPv6, DNS rebinding, redirect-to-private, oversized response, timeout, non-HTTP schemes, credentialed URLs, and rate-limit cases
- secret scanner: redaction, false-positive allowlist, binary/oversized file rejection, and no-network regression
- RLS checker: enable/force RLS, missing ownership predicate, permissive policy, `SECURITY DEFINER`, comments/strings, and known-safe examples
- JWT inspector: malformed token, unsafe algorithm observation, expired/not-yet-valid timestamps, missing audience/issuer, and no-network regression
- checklist: versioned scoring, deterministic result, keyboard flow, mobile layout, print/download, and no guarantee language

### Phase 3 - publishing waves

| Wave                      | Weeks | Output                                                                 | Goal                                                            |
| ------------------------- | ----: | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Foundation                |   1-2 | Authority draft, `/tools` hub, analytics contract, Search Console plan | Establish canonical structure                                   |
| High-intent launch        |   3-6 | Tools 1-3 plus posts #2-#17                                            | Win access, secrets, auth, and input demand                     |
| Commercial workflows      |  7-11 | Tools 4-5 plus posts #18-#38                                           | Connect diagnosis to SaaS and supply-chain needs                |
| Agentic security          | 12-16 | Posts #39-#51 and #69-#70                                              | Own prompt, MCP, CI, and agent-permission questions             |
| Platform workflows        | 17-21 | Posts #52-#68 and #71                                                  | Capture tool/stack-specific search intent without teardown copy |
| Verification and audience | 22-26 | Posts #72-#100                                                         | Build durable workflow and decision content                     |

Publishing pace: four founder-approved posts per week after the authority page. Do not publish 100 thin drafts in a burst. Update the authority page after each wave with the best new explanations and links.

### Phase 4 - AEO/GEO and E-E-A-T requirements

Every published page must include:

- direct answer in the first paragraph
- named author and useful bio
- published and materially updated dates
- primary-source citations near technical claims
- stable H2/H3 question headings
- concise tables, definitions, and steps that remain accurate when quoted alone
- visible limitations and "what this cannot prove"
- original diagrams or minimal code examples where they improve understanding
- FAQ only for questions actually answered on the page
- one authority link, one related-post link, and one tool/product link

Monthly citation benchmark: run the same 20 non-branded questions in Google AI Overviews where available, Bing Copilot, ChatGPT Search, and Perplexity. Record whether LyraShield is cited, the cited URL, the answer accuracy, and competing sources. Do not automate scraping in violation of platform terms and do not treat citation appearance as a guaranteed ranking metric.

## 9. Analytics and success criteria

### Privacy-safe events

Allowlist only:

- `tools_hub_view`
- `tool_started` with tool slug
- `tool_completed` with tool slug and coarse result band
- `tool_to_app_click` with tool slug
- `blog_to_tool_click` with article slug and tool slug
- `authority_to_app_click`

Never send pasted code, URLs, hostnames, JWTs, SQL, secrets, finding text, file names, IPs, or user-authored captions to analytics.

### 30 / 60 / 90-day measures after indexing

| Metric      | 30 days                                                           | 60 days                                                   | 90 days                                                                      |
| ----------- | ----------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Technical   | All intended URLs indexed; no canonical or structured-data errors | CWV good on representative blog/tool pages                | Stable crawl and no duplicate-intent pages                                   |
| Search      | Baseline non-brand impressions and query set                      | First top-20 positions for long-tail issue/tool queries   | Growing clicks to authority, issue, and tool clusters                        |
| AEO/GEO     | Establish 20-prompt citation baseline                             | Improve extractable-answer accuracy and citation coverage | Earn repeat citations for at least several non-brand questions               |
| Product-led | Tool completion baseline                                          | Identify highest-intent tool-to-app path                  | Improve qualified tool-to-app conversion without collecting sensitive inputs |
| Editorial   | Authority + first wave live                                       | Refresh weak titles/answers from Search Console evidence  | Consolidate cannibalizing posts rather than creating more variants           |

No arbitrary traffic promises belong in the plan. Set numeric targets only after 30 days of real impressions and tool usage establish a baseline.

## 10. Definition of done for each page

- distinct search intent and no cannibalization with an existing URL
- title <=70 characters; description 70-160 characters
- one H1 and valid heading order
- answer-first introduction
- target word range met without filler
- primary technical sources linked
- authority, related-post, and tool/product links present
- useful FAQ or an explicit decision to omit it
- privacy and limitation copy present for tools
- keyboard, mobile, error, loading, and empty states verified
- structured data matches visible content and validates
- canonical, Open Graph, sitemap, RSS, and `llms.txt` behavior verified on an indexable build
- `draft: true` until explicit founder approval
- marketing lint, typecheck, build, focused tests, and `git diff --check` pass
- real-domain visual QA and Search Console URL inspection pass before claiming the page is live/indexed

## 11. Immediate next implementation slice

The smallest useful slice is:

1. Authority article draft.
2. Done: `/tools` hub.
3. Done: browser-local AI App Launch Security Checklist.
4. Done: browser-local Secret Exposure Scanner, headers/CORS checker, Supabase RLS checker, and JWT/session inspector.
5. Supporting posts #2, #3, #4, #13, #28, and #72.

This slice validates authority-page linking, two privacy-safe interactive tools, the highest-demand issue cluster, structured data, analytics, and the blog-to-tool-to-app funnel before the team commits to all 100 posts.
