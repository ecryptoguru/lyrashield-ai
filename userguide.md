# LyraShield AI User Guide

Last verified against the application code and open-registration deployment: 2026-08-10

LyraShield AI helps builders review an application before release and retain an evidence-backed record of what was checked.

## Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report

This guide covers the public Lite Check, authenticated dashboard, scan choices, findings, fixes, reports, scorecards, teams, integrations (agents and services), schedules, notifications, the CLI, MCP tools, and current limitations.

## 1. Important product boundaries

LyraShield AI uses precise result language:

- **Detected** means a scanner or engine returned evidence for a possible issue.
- **Validated** or **retest-confirmed** means a fresh deterministic retest no longer found the issue within its completed scope.
- **Verified** means independent verification evidence exists. Model confidence alone never creates this state.
- **Inconclusive** means the available scan could not establish a reliable result.
- **No finding** means the assigned check completed without returning a mapped finding. It does not mean the application is universally safe.
- **Evidence required** means the control needs deployment, operational, or human-review proof that a repository or URL scan cannot safely establish.

LyraShield AI does not claim that a clean scan is a security guarantee. Always read the retained coverage, limitations, evidence state, and scan events alongside the headline result.

## 2. Public features without an account

### 2.1 Lite Check

Open [https://lyrashieldai.com/scan](https://lyrashieldai.com/scan) to run a passive outside-in review of a public HTTP(S) page.

The Lite Check can:

- inspect the submitted page and its response headers;
- inspect up to six same-origin JavaScript or CSS assets linked by the page;
- review HTTPS, mixed-content, security-header, and CORS basics;
- identify supported public framework and backend-as-a-service markers;
- detect high-confidence credential patterns without returning the matched value;
- create a privacy-bounded optional Lite scorecard.

It does not authenticate, exploit, fuzz, brute-force, enumerate a database, actively test row-level security, crawl arbitrary paths, or fetch exposed environment-file paths. It is separate from the authenticated full-scan pipeline and does not produce the official LyraShield Score.

After a result, users can choose **Sign in** to continue to the authenticated app, create an account, or inspect the synthetic sample report. The result keeps its passive-check limitations visible even when all five surface checks look OK.

Before submitting a target, confirm that you own it or are authorized to test it and accept the displayed terms. Bare domains are normalized to HTTPS. URLs containing credentials, query strings, fragments, private addresses, or unsupported protocols are rejected.

### 2.2 Browser-local tools

The public Tools area provides six utilities whose inputs remain in the browser:

1. AI app launch checklist.
2. Security headers and CORS checker.
3. Secret exposure scanner.
4. Supabase row-level-security review helper.
5. JWT and session inspector.
6. **AI App Security scanner** (`/tools/ai-app-security-scanner`) — runs eight deterministic static-analysis signals (AI-01–AI-08) mapped to the OWASP Top 10 for LLM Applications (2025) entirely in the browser. Accepts pasted code or selected local files (≤25 files, 1 MiB/file, 5 MiB total) and reports `DETECTED`, `NO_FINDING`, `INCONCLUSIVE`, and `NOT_ASSESSED` coverage with file, line, bounded evidence, remediation, supported scope, and limitations. AI-03 (advisory), full-repository context, optional LLM triage, persistent evidence, retest, reporting, and the numeric score require the paid repository scan. The free tool shows no numeric score because selected-file coverage is user-controlled and incomplete. Files and pasted code never leave the browser.

These utilities provide guidance and local analysis; they do not create authenticated scan evidence or an official score.

### 2.3 Public methodology and sample report

Use the public methodology page to understand scoring, evidence states, and limitations. The sample report is illustrative and must not be treated as a result for your application.

## 3. Account access

### 3.1 Create an account

1. Open [https://app.lyrashieldai.com](https://app.lyrashieldai.com).
2. Select **Sign up**.
3. Enter your name, email, and password.
4. Complete email verification when prompted (only when the deployment has `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=1` and a configured mail provider), then continue through onboarding.

Registration is open to all users. The application preserves the intended destination through authentication. Use **Forgot password** when the email provider is configured for password reset.

### 3.2 Sign in, sign out, and theme

- Use **Sign in** with your registered email and password, or a configured GitHub, Google, or Microsoft identity. A provider appears only when its credentials are configured for the deployment.
- Use the theme control in the sidebar account area to switch between supported light and dark themes.
- Use **Sign out** at the bottom of the sidebar to end the current session.

## 4. First-time onboarding

Onboarding has three stages and may be safely left with **Finish later**.

### Step 1: Workspace

Enter a workspace name and choose:

- **Just me (`VIBE`)** — intended for a solo project or small product.
- **My team (`TEAM`)** — intended for shared work across multiple people.

The workspace keeps projects, targets, scans, findings, reports, schedules, integrations, and members together. Data is scoped to the active workspace.

### Step 2: Target and goal

Choose a target:

- **Repository** — enter the repository owner and name. Onboarding treats it as a GitHub repository and a staging target.
- **Live app** — enter a public application URL. Onboarding creates a web-application target.

Choose the outcome you need:

- **Check a PR** — review a pull request before merging.
- **Test my app** — review an application or repository for issues.
- **Launch review** — identify what needs attention before release.
- **Monitor weekly** — establish a recurring review goal.

The goal explains the intended outcome. Review depth determines the model, reasoning level, and protected internal run profile.

### Step 3: First scan

Review the workspace, target, and goal, choose an available review depth, then start the review. Repository onboarding offers Release Check, Code Review, and Deep Security Review. URL/API choices are capability-aware and depend on the target details supplied.

## 5. Navigation and workspace switching

The primary navigation contains four lifecycle destinations:

- **Home** — current launch verdict, assurance progress, risk posture, remediation flow, retained finding mix, recent scans, and monthly usage.
- **Targets** — repository, web-application, and API targets.
- **Trust Runs** — create, monitor, cancel, and inspect scans. Two tabs:
  - **Runs** — one-off and manual scans.
  - **Monitoring** — scheduled recurring scans (formerly the Schedules page).
- **Issues** — filter and work through detected risks. Three tabs:
  - **Issues** — the finding queue.
  - **Evidence** — independently verified evidence behind findings (formerly the Evidence page).
  - **Reports** — create, download, share, and revoke assurance reports (formerly the Reports page).

**Review Queue** appears in the Workspace section of the sidebar and mobile More sheet only when pending agent approvals or fix proposals exist. It carries a count badge and links to the approval page. The route remains reachable by URL for authorized users even when the queue is empty.

Open **More** (mobile) or the **Workspace** sidebar group (desktop) for Integrations, Team, Notifications, and Settings. The **Integrations** page is tabbed: **Services** (GitHub, MCP, CLI) and **Agents** (coding-agent setup). Use the workspace switcher above the navigation to change the active workspace. Every page and action is evaluated against the active workspace and your role.

## 6. Projects

Projects are optional containers for related targets and scans.

To create one:

1. Open **More → Projects**.
2. Select **New Project**.
3. Enter a required name and optional description.
4. Save the project.

When adding a target, select the project or leave **No project**. A project card shows its target, scan, and finding counts.

## 7. Targets (Assets)

Open **Assets** to add and review targets.

### 7.1 Repository target

Select **Repository**, then configure:

- target name;
- optional project;
- repository owner;
- repository name;
- branch;
- environment: Local, Preview, Staging, or Production.

Repository targets use the full source-aware pipeline when the worker runtime is available. This can include the external review engine, dependency scanning, secret scanning, agent-configuration checks, workflow checks, evidence persistence, and the Vibe Security 50 coverage ledger.

### 7.2 URL target

Select **URL**, then configure:

- target name;
- type: Web App or API;
- public HTTP(S) URL;
- optional project;
- environment: Local, Preview, Staging, or Production;
- **ownership attestation** — you must check the box confirming you own or are authorized to scan this target before the form can be submitted.

URL and API targets use the pinned deterministic URL scanner. The external AI engine is not invoked for these targets. Review depth still describes the requested workflow, but it does not turn a passive URL scan into a repository or intrusive assessment.

### 7.3 GitHub-connected target

You may also create a repository target from **More → Integrations → Services → GitHub**:

1. Connect the GitHub App.
2. Load repositories the installation is authorized to access.
3. Select a repository.
4. Add it as a target.

The default branch and repository visibility are returned by GitHub. A connected installation is not proof that every repository is accessible; access follows the installation's selected repositories and provider permissions.

### 7.4 Target detail

Open a target to view repository or URL details, its recent scans, latest eligible LyraShield Score, and public-scorecard controls when your role permits publication.

## 8. Scan types and models

The authenticated dashboard exposes one-off review depths that depend on the selected target. Weekly Monitor is the recurring version of the same choices.

### Repository targets

| User option          | Backend mode | Repository model route                       | Maximum duration |
| -------------------- | ------------ | -------------------------------------------- | ---------------: |
| Release Check        | QUICK        | GPT-5.6 Luna, medium                         |           15 min |
| Code Review          | STANDARD     | GPT-5.6 Luna, medium                         |           15 min |
| Deep Security Review | DEEP         | GPT-5.6 Terra/medium + Luna/high specialists |           45 min |
| Weekly Monitor       | QUICK        | GPT-5.6 Luna, medium                         |           15 min |

For an authorized repository target, Deep is the intrusive agentic pentest profile: it may execute and investigate code inside LyraShield's isolated sandbox. That authorization does not extend to attacking a deployed URL or API. URL/API Deep is a separate deterministic, non-mutating behavior profile described below.

### Web App and API targets

Web App and API targets use the pinned deterministic URL scanner. The external AI engine is not invoked for these targets. The available modes are:

| User option               | Target type | Backend mode | Requirements                          |
| ------------------------- | ----------- | ------------ | ------------------------------------- |
| Surface Review            | Web App     | SAFE         | Public HTTP(S) URL                    |
| Expanded Surface Review   | Web App     | STANDARD     | Public HTTP(S) URL                    |
| Behavioral Surface Review | Web App     | DEEP         | Public HTTP(S) URL                    |
| Endpoint Review           | API         | SAFE         | Public HTTP(S) URL                    |
| Contract Review           | API         | STANDARD     | An OpenAPI document URL on the target |
| Contract Behavior Review  | API         | DEEP         | An OpenAPI document URL on the target |

These reviews are non-mutating. Surface and Expanded reviews use passive GET requests; Behavioral Surface Review and Contract Behavior Review may add bounded GET, HEAD, OPTIONS, and CORS behavior probes within the selected profile. They do not authenticate, exploit, fuzz, or enumerate arbitrary paths outside the configured scope. Contract and Contract Behavior reviews use the supplied OpenAPI document to bound the operations reviewed.

For repository targets, `SAFE` resolves to `QUICK` and `CUSTOM` resolves to `DEEP`. For Web App and API targets, `QUICK` resolves to `SAFE` for compatibility, while `CUSTOM` is unsupported. These aliases do not create a fourth product capability. Durations are hard ceilings, not completion promises.

LyraShield applies protected internal run limits automatically. The dashboard does not display model costs, spend, or accounting events. If a protected limit is reached, the scan ends with a neutral limit message while operators retain the internal usage record for reconciliation.

## 9. Start and monitor a scan

1. Open **Trust Runs → Runs**.
2. Select **New Scan**.
3. Choose a target.
4. Choose a review depth that is available for that target type. Locked options explain why they are unavailable (for example, Contract Review requires an OpenAPI document on an API target).
5. Review the selected workflow description.
6. Select **Start Scan**.

Only one active scan may run against the same target. Wait for it to finish or cancel it before starting another.

Scan submission is accepted only while the scan service has a live worker. If the worker is starting, restarting, or unavailable, the request returns `SCAN_SERVICE_UNAVAILABLE` and no scan is created. Wait briefly and retry once; repeated clicks are unnecessary and cannot create hidden queued work.

Possible lifecycle states include Queued, Preflight, Running, Verifying, Completed, Failed, Cancelled, Stopped by Limit, Timed Out, and Requires Approval. The list refreshes active scans automatically and also provides manual **Refresh**, **Cancel**, and **Load more** actions.

## 10. Understand scan details

Open a scan to review:

- status, goal, review depth, duration, and trigger type;
- target and completed scanner scope;
- summary and coverage warnings;
- selected model and reasoning effort for repository scans;
- immutable result-manifest checksum;
- coverage receipts grouped by scanner and Vibe Security 50 family;
- findings sorted by severity;
- the chronological scan-event timeline.

The scanner labels are:

- **Engine review** — model-assisted repository analysis.
- **Dependency scan** — package-manifest and advisory checks.
- **Secret scan** — bounded credential-pattern review.
- **Agent configuration** — supported agent instruction and workflow checks.
- **URL scan** — pinned deterministic public-surface review.
- **AI App Security** — deterministic static-analysis signals (AI-01–AI-08) mapped to the OWASP Top 10 for LLM Applications (2025). Paid repository scans rerun the shared core and may add bounded AI-03 advisory enrichment when exact dependency resolution and a complete fresh advisory receipt are available. A private score is shown only when its coverage and AI-03 freshness gates pass, and it is excluded from public scorecards. Engine-bound LLM triage is planned; the generic in-process overlay is not a released customer capability.

The Vibe Security 50 ledger contains one receipt for each control. Read `NO_FINDING` as “the assigned scanner returned no mapped finding,” not “passed.” Seven controls always require operational or human evidence.

## 11. Findings

Open **Issues → Issues** to review all retained findings in the active workspace. Available list filters are All, Critical, High, Medium, Low, Open, Fixed, and Verified.

A finding may contain:

- severity, status, confidence, CWE, CVSS, and category;
- verification state, method, and reason;
- plain-language explanation;
- technical details and exploitability;
- business impact and recommended fix;
- redacted evidence references;
- fix proposals and retest history;
- CISA Known Exploited Vulnerabilities and FIRST EPSS context when available.

Threat-intelligence enrichment prioritizes review but does not change severity or verification state by itself.

### Finding workflow

1. Read the evidence and limitations.
2. Create and edit a fix proposal describing the change you intend to make.
3. Apply the change yourself. Saving a proposal does not modify the repository.
4. Queue a fresh retest after applying the change.
5. Review whether the retest is validated, independently verified, blocked, or inconclusive.
6. Generate an assurance report from the retained retest when appropriate.

Depending on your permission, you may also mark a finding as accepted risk or false positive. These are audited decisions, not silent deletion. When you do, the UI requires a short reason; the reason is stored as the finding's status reason and is shown on the finding detail for future reviewers.

## 12. Fix proposals and pull requests

The **Fix proposals** page lists proposals created from findings. A proposal is guidance and an auditable plan; it is not proof that code changed.

Automatic Fix PR execution is intentionally fail-closed. The application does not accept a client-authored patch, branch, title, or body for privileged PR creation. Creating a real PR remains unavailable until a server-generated patch can be immutably bound to an approval.

## 13. Retests

Retests create a new server-owned scan against the original target. They do not mutate the old result.

- Deterministic findings receive a targeted deterministic profile when available.
- Engine-only findings retain their originating review depth.
- A clean deterministic retest with complete coverage can become validated/retest-confirmed.
- Engine-only absence remains inconclusive unless independent evidence exists.
- A finding remains `FIXED_PENDING_RETEST` until the server-owned retest records its result.

Open the new scan from the finding drawer to follow progress and retained events.

## 14. LyraShield Score and launch readiness

Eligible completed Standard or Deep scans can create a versioned LyraShield Score from retained evidence. The score is 0–100 with a grade and methodology version. It is scoped to the completed scan and is not a security guarantee.

Open **Overview** or the launch-readiness surface to see:

- `NOT_EVALUATED` before a completed scan exists;
- `GO`, `GO_WITH_CONDITIONS`, or `NO_GO` based on retained findings;
- current score when available;
- blocking and verified finding counts;
- severity distribution;
- conditions and recommendations.

“Ready to Launch” means no blocking findings were retained within completed scope. It does not certify untested systems or evidence-required controls.

## 15. Public scorecards and referrals

From an eligible target detail page, authorized users can create a public scorecard. Publication is opt-in and audited. Lower grades require explicit confirmation.

The public payload is deliberately limited to the approved scorecard fields, such as grade, scope line, scan date, methodology version, and resolved-findings count. It excludes target URLs, repository names, open findings, severity details, evidence, and vulnerability text.

Scorecard actions include:

- publish and revoke;
- choose Grade or Verified fixes presentation;
- share through native sharing, LinkedIn, X, Bluesky, WhatsApp, Reddit, or email;
- copy the link or caption;
- download wide, square, or portrait social cards;
- copy a revocable README badge;
- review human views, share handoffs, and referred signups.

A newer score may supersede an older card. Revocation disables the public page, social images, and badge. Referral rewards are qualified only after the referred workspace completes its first real scan; views alone are not rewarded.

## 16. Reports

Open **Issues → Reports → Generate Report** and choose:

- **Executive** — decision-first posture, score trajectory, release conditions, and priority actions.
- **Developer** — technical findings, remediation state, retest outcomes, and fix guidance.
- **Compliance** — evidence-oriented summary and methodology for lightweight assurance review.

Enter a title and optionally select a completed scan. New reports retain an immutable creation-time snapshot.

Available actions:

- download the report;
- create or regenerate a private share link;
- copy the link or client-handoff message;
- open an email handoff;
- revoke the share link.

Private report links expire after 30 days. Shared report pages are noindex and use a no-referrer policy. Revocation prevents further access through the old token.

## 17. Monitoring schedules

Open **Trust Runs → Monitoring → New Schedule** and configure:

- target;
- UTC cron expression;
- review depth: Release Check, Code Review, Deep Security Review, or Weekly Monitor.

Built-in descriptions recognize common daily, weekly, and monthly cron expressions. Custom expressions remain UTC and should be verified before saving.

Each schedule displays its target, review depth, human-readable timing, last run, next run, and enabled state. You can enable/disable or delete a schedule.

## 18. Notifications

Open **More → Notifications** to review scan alerts, critical-finding warnings, and workflow updates. You can:

- filter unread notifications;
- mark one notification as read;
- mark all notifications as read;
- open the linked resource when a notification provides one.

Personal notifications are visible only to their intended user; workspace-wide notifications are visible within the workspace.

## 19. Team and roles

Open **More → Team** to view active members and pending invitations. Users with invitation permission can invite an email address and assign a role below their own privilege level. Owners may assign any role; non-owners cannot create a peer or higher-privilege role.

Available roles:

- **Owner** — full workspace control, including ownership-sensitive actions.
- **Admin** — broad operational, governance, integration, member, scan, finding, report, schedule, and agent permissions.
- **Security Admin** — security operations, policies, audit access, scan/finding workflows, schedules, reports, and agent approval.
- **AppSec Manager** — operational security workflows without owner/admin governance authority or agent approval.
- **Billing Admin** — billing management plus finding visibility and report creation/download.
- **Developer** — targets, scans, findings, fixes, retests, reports, notifications, schedules, and permitted agent actions.
- **Member** — basic project, target, scan, finding, fix, retest, report, notification, and schedule workflows.
- **External Pentester** — scan, finding, retest, report, notification, and schedule visibility with limited mutation rights.
- **Auditor** — read-oriented scan/finding/retest access plus audit export and reports.
- **Viewer** — read-only scan, finding, retest, report-download, notification, and permitted agent visibility.

The server checks permissions for every protected API action. A visible page does not override the role check.

## 20. Integrations

The **Integrations** page has two tabs:

- **Services** — GitHub, MCP, and CLI connections.
- **Agents** — coding-agent setup (Claude, Cursor, VS Code, and others) with install commands and rules files.

### GitHub

The current dashboard integration supports connecting the GitHub App, loading authorized repositories, and creating repository targets. Installation identifiers are globally unique and provider ownership must be proven before a fresh callback can create a workspace integration.

Other integration types exist in the internal schema and roadmap, but the current dashboard should not be read as offering active Slack, Jira, Linear, Teams, ServiceNow, SIEM, or compliance-platform connections.

### 20.5 Billing and plans (Cloud Mode)

These are the configured commercial terms. Live checkout and charging remain disabled until the founder activates the production providers.

LyraShield Cloud offers a 14-day free trial: 100 agent-minutes, Standard and Quick scans only (no Deep), and no card required. When the trial ends, pick a paid plan or let it lapse.

| Plan    | Price       | Minutes/mo | Targets | Deep | Notes                               |
| ------- | ----------- | ---------: | ------: | ---- | ----------------------------------- |
| STARTER | $29/mo      |        300 |       5 | No   | Standard + Quick                    |
| PRO     | $99/mo      |      1,200 |      15 | Yes  | Deep enabled                        |
| TEAM    | $299/mo     |      4,000 |      50 | Yes  | Deep + opt-in overage + spend limit |
| AGENCY  | Contact-led |     custom |  custom | Yes  | Custom terms                        |

- **Annual billing:** 15–25% discount, prepaid.
- **Payment rails:** India uses Razorpay (INR pricing, UPI, GST invoices); Global uses Polar (USD).
- **Minute packs:** 100/$15, 250/$30, 500/$50 — valid 180 days.
- **Overage:** $0.15/min — Team plan opt-in with a configurable spend limit.
- **Deep/Custom scans:** 3× agent-minute multiplier, PRO+ only.
- **Grace period:** 15 min free grace if minutes run out mid-scan.
- **Refunds:** 14-day money-back on Cloud subscriptions.
- **Billing page:** manage subscription, buy minute packs, view usage, and set a spend limit (Team).

### 20.6 Affiliate program

- Apply at `/affiliates/apply` (requires a LyraShield account).
- Manual approval by the LyraShield team.
- Approved affiliates receive a referral link and a promo code.

Commission:

- 25% recurring on Cloud subscriptions for 12 months; 30% once you reach 10+ active referrals.
- 20% one-time on Local licenses.
- No commission on minute packs, trials, or self-referrals.

Attribution uses a last-click cookie (60 days), with a promo code override.

Dashboard at `/affiliates/dashboard` shows clicks, signups, conversions, commissions, and payouts.

Payouts:

- $100 minimum, monthly net-30 on the 15th, with a 30-day hold.
- Tax form required (W-9 or W-8BEN).
- New affiliates carry a 20–30% reserve for the first 90 days.
- Rails: RazorpayX (India, IMPS/UPI) or Payoneer (global).

### 20.7 LyraShield Local/Desktop (BYOK)

LyraShield Local is a desktop app for macOS and Windows. It is a one-time 1-year license with BYOK — you bring your own AI.

- **Supported BYOK:** ChatGPT/OpenAI subscription (OAuth) and Azure OpenAI.
- **Scan depths:** all depths are available — there is no Cloud-style depth gating because your AI pays, not us.
- **Metering:** zero agent-minute metering; your AI pays, not LyraShield.
- **Privacy:** scans run locally. No code, findings, or keys leave your machine.
- **Optional cloud sync:** connect your LyraShield account to sync findings (see Cloud sync below — monotonic, device-bound).
- **Perpetual fallback:** update eligibility controls only newer updates. Your
  installed eligible build and local scans remain usable, and any build at or
  below the signed perpetual fallback remains installable.
- **Offline grace:** after a successful server verification, the app can scan
  and sync offline for seven rolling days. It shows the remaining grace period;
  after seven days, reconnect before scanning, syncing, or updating. Explicit
  revocation or invalidation stops operation immediately.
- **Updates:** the app checks quietly and also provides a manual check. It shows
  version and release notes, asks before downloading, reports progress, and
  restarts only after confirmation. Updates are never installed automatically.

Pricing:

- **Individual:** $199 launch / $299 regular — 3 machines.
- **Team:** $99/seat + $59/seat/yr renewal, or $149/seat/yr subscription with sync.
- **Refunds:** none on Local licenses.

Public Local self-service checkout is not open yet. A temporarily unavailable
payment state means no provider request was created and existing access is
unchanged.

### License delivery and retrieval

After a Local license purchase (Polar or Razorpay), you receive an email with a **one-time retrieval link** (expires in 7 days, single use). The email never contains the raw license key itself. Open the link or `POST {"token":"..."}` to `/api/licenses/retrieve` to retrieve your license key and signed license file **once**. The link expires after first retrieval or after 7 days and then returns a generic `404 Not Found` (no oracle). The retrieval token is stored only as a SHA-256 hash with an expiry and single-use marker, and is never logged. If email delivery fails, the system marks the fulfillment as `DELIVERY_FAILED` and retries automatically via the webhook-track queue before the webhook is considered complete; concurrent webhook deliveries mint only one license. If your link expired or was already used, contact support to re-issue.

## 21. Settings and account deletion

The Settings page displays:

- workspace name, mode, and plan;
- target, scan, finding, and member counts;
- retention period;
- product-telemetry state;
- active security-control summary;
- shortcuts to Team, Integrations, Notifications, and Schedules (Trust Runs → Monitoring).

The current settings surface reports retention and telemetry configuration but does not provide self-service editors for every field.

To delete your account, enter the exact confirmation text `DELETE`. Deletion is blocked when you are the sole owner of a workspace because removing the account would orphan it. Transfer or add ownership first. Deletion anonymizes retained attribution where required and preserves audit-chain integrity.

## 22. CLI, MCP, and agent workflows

LyraShield ships three ways to run checks from a coding agent, an editor, or a terminal, sharing one underlying API client so their behavior cannot drift apart.

### CLI

The `lyrashield` command-line tool (published on npm; the scoped alias `@lyrashield/cli` is deprecated and will be removed in the next major release) installs, configures, and drives scans without hand-editing any config file:

```bash
npx lyrashield login              # browser-based OAuth device login or workspace API key
npx lyrashield init                # detect installed coding agents and configure them
npx lyrashield doctor              # check what's configured and what's missing
npx lyrashield gate                # CI-friendly diff-aware security gate
```

`login` writes `~/.lyrashield/credentials.json` with `0o600` permissions. If the browser-based OAuth device flow is unavailable, it falls back to `LYRASHIELD_API_KEY` from the environment. `LYRASHIELD_API_URL` defaults to `https://app.lyrashieldai.com` and is resolved consistently by `packages/credentials`, which is the single source of truth for the credentials file.

`init`/`install <agent>` choose an install strategy based on the agent. All 24 distinct agents are rendered from `packages/agent-registry`, which produces 30 registry entries. Four clients have confirmed Agent Plugins v1.0.0 manifests; the registry also retains reserved entries for VS Code and GitHub Copilot pending independent verification.

- **Agent Plugin** — for Claude Code, Cursor, OpenAI Codex, and Kiro, the CLI prefers a portable plugin install from `@lyrashield/agent-plugin` (currently v0.1.17, which adds Cursor streamable-http transport support). Plugin files land in the client-specific plugin directory and never inline a raw API key. Pass `--strategy agent-plugin` or `--strategy config-file` to force a specific strategy when both are available. The `packages/agent-registry` covers all 24 distinct agents.
- **Config-file** — 16 clients whose settings can be safely written; the CLI merges into the existing file, never overwrites, and refuses to place a raw API key in a conventionally shared file unless you explicitly pass `--inline-secret` and the file is gitignored.
- **Vendor CLI** — Amp is configured by shelling out to `amp mcp add`.
- **Guided manual** — for the 7 clients whose tooling has no writable config file — Cline, JetBrains AI & Junie, PiCode, OpenClaw, Hermes, Goose, and Aider — `install` prints exact copy-paste command/argument/environment values, generated from the same source of truth the writable installers use.

`uninstall <agent>` removes the LyraShield entry from the chosen agent's config or plugin directory.

Other commands mirror the dashboard and the MCP tools below: `scan`, `status`, `findings`, `explain <findingId>`, `fix-plan <findingId>`, `verify <findingId>`, `report`, `readiness`, `targets`, and `rules add/remove/check <agent>` (writes or removes LyraShield's security policy in that agent's native rules format — `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, and others — inside a checksummed block so re-running never clobbers your own edits to the surrounding file). `check-diff` is the same fast, local, **advisory** heuristic as the MCP tool of the same purpose — not a full recorded scan. Every command supports `--json` for scripting, and `gate` exits non-zero when a finding at or above the configured severity is present, matching the GitHub Action's own gate semantics.

**Project defaults** make scans one-command: `lyrashield project use` detects the current git repo, creates or reuses a repo target, and saves it as the default project. `lyrashield scan` then starts a scan without `--target`. Switch projects with `lyrashield project switch <targetId>`, list them with `lyrashield project list`, or clear with `lyrashield project clear`. To scan the current git repo instead of the saved default, pass `--auto`; to scan another repository, pass `--repo <owner/repo>`.

**Review depth:** deeper modes consume more compute and take longer. Choose the least intensive mode that answers the question.

| What you ask         | Goal                | Mode       |
| -------------------- | ------------------- | ---------- |
| Pre-PR check         | `CHECK_PR`          | `QUICK`    |
| Quick check          | `TEST_APP`          | `QUICK`    |
| Standard repo review | `TEST_APP`          | `STANDARD` |
| Launch review        | `LAUNCH_REVIEW`     | `STANDARD` |
| Repository pentest   | `FULL_PENTEST`      | `DEEP`     |
| Compliance review    | `COMPLIANCE_REVIEW` | `DEEP`     |
| Weekly monitor       | `WEEKLY_MONITOR`    | `QUICK`    |

### MCP

LyraShield exposes an MCP server for local editors and a hosted remote endpoint. The full tool catalog lives in `packages/mcp/README.md`; the current set is:

#### Read tools

- `lyrashield_list_workspaces` — list workspaces the API key can access;
- `lyrashield_list_targets` — list targets in a workspace;
- `lyrashield_get_scan_status` — status and events for a scan;
- `lyrashield_get_findings` — list findings with optional target or severity filters;
- `lyrashield_explain_finding` — full detail and plain-language explanation of a finding;
- `lyrashield_generate_fix_plan` — assemble a remediation plan from a finding;
- `lyrashield_get_launch_readiness` — retrieve the current scoped launch verdict;
- `lyrashield_create_pr_security_recap` — generate a markdown security recap for a PR comment;
- `lyrashield_check_diff` — fast **advisory** heuristic pre-filter on a diff (not a full recorded scan).

#### Write tools

- `lyrashield_scan_target` — start a scan on a registered target. Pass `targetId` directly, or pass `repo` (e.g. `ecryptoguru/lyrashield-ai`) to create or reuse a target; `auto: true` detects the current git repo only for local stdio MCP;
- `lyrashield_run_pr_scan` — start a PR-focused (CHECK_PR) scan. It has the same `repo` support, and local-stdio-only `auto` support, as `lyrashield_scan_target`;
- `lyrashield_record_fix_proposal` — record a fix proposal on a finding;
- `lyrashield_verify_fix` — queue a retest to verify a fix;
- `lyrashield_create_report` — create an executive, developer, or assurance report. (The internal type value is still `compliance` for backward compatibility; the UI label is "Assurance.")

Read actions follow API-key scope and workspace permissions. Locally, mutating MCP actions require interactive approval on the controlling terminal (or your editor's own approval prompt, where the editor supports MCP elicitation) and fail closed when no approval channel is available.

The remote-HTTP transport supports two authentication methods:

- **Bearer API key** — `Authorization: Bearer lsk_…` with a read-only or read/write key.
- **OAuth 2.0** — the hosted flow at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` (also under `/api/mcp/`) lets an MCP client authenticate through `/oauth/consent`, select a workspace, and request an optional write scope. Remote connections are **read-only by default**; write actions require the OAuth write scope plus explicit approval. OAuth clients cannot use the operator-only `LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS` bypass.

A pre-authorized trusted-automation opt-in remains available for CI that should never pause for approval. Model-facing inputs pass through the prompt-injection guard in every case.

Use the same supported scan modes as the API: SAFE, QUICK, STANDARD, DEEP, or CUSTOM. Dashboard users should normally prefer the named presets rather than raw modes.

### GitHub Action

For CI pipelines that don't need an AI editor at all, `ecryptoguru/lyrashield-ai@v1` (the `action.yml` at the repository root) runs a diff-aware gate — secret detection plus risky-pattern checks, emitting SARIF — entirely in your own runner with your own `GITHUB_TOKEN`. It needs no LyraShield account or API key. See the [GitHub Action integration guide](https://lyrashieldai.com/docs/integrations/github-action) for the workflow file and inputs.

## 23. Current availability

The public marketing site, Lite Check, browser-local tools, methodology, and content are live. The authenticated dashboard is open for registration; its dedicated BullMQ/engine worker remains a separate controlled full-scan boundary. Ordinary web requests use a restricted `NOBYPASSRLS` database role, and repository scan admission fails closed when the worker heartbeat is absent. The current production Standard/Luna acceptance scan exercised the promoted worker with Luna/medium-only routing, reconciled accounting, retained findings and receipts, and a sealed result manifest. That target- and version-scoped result is bounded runtime proof, not a security guarantee or universal coverage proof; an approved Deep/Terra run remains a separate gate.

The production application has an authenticated application origin, TLS Redis queue, sandbox-capable worker compute, authorized Luna/Terra deployments, baseline Azure alerts, and DNS-pinned deny-by-default egress. The worker runs an explicitly promoted, CI-verified immutable digest rather than a mutable tag; each future release repeats VM digest, OCI-label, Docker-health, and scan-readiness reconciliation with the prior digest retained for rollback. Azure Foundry repository scans use direct JSON function tools. The current endpoint rejects programmatic tool calling; this is an optimization gate, not a user-facing scan failure. Broad full-scan availability still requires production proof for private evidence persistence, application-level readiness/queue/provider alerts, capacity evidence, failure recovery, and each additional review profile claimed. No recovery or RPO/RTO claim is made.

Billing, Local/Desktop licensing, and the affiliate application/ledger are implemented. New Polar and Razorpay checkout requests are independently admission-controlled and default off in production while webhook settlement remains enabled. Test configuration and signed webhook smoke are complete, but live paid canaries, production desktop distribution/signing proof, Local self-service checkout, payout API provisioning, and the public affiliate opening remain controlled release gates.

Automatic server-generated Fix PRs, intrusive exploit replay, a within-scan Luna-to-Terra cascade, Security Copilot, and enterprise identity/deployment controls are not currently user features.

LyraShield does not claim "SOC 2 compliant," "certified," "guarantees security," "AI safety tested" (without a named framework), or "adversarial robustness proven." Each requires external attestation, a reproducible evaluation corpus, a defined threat model, or a formal certificate. See `docs/claims-readiness.md` for the full map.

## AI assurance workspace

The private AI assurance workspace keeps operational evidence, an AI system profile, and a threat model per target. Profile and threat-model values are explicitly **Customer-declared**: completing required fields records an inventory version, not verified lineage, compliance, or certification. High and critical threat scenarios require a mitigation, test plan, and owner before a version can be created. Private reports freeze the evidence/profile/threat-model state present at creation; shared reports omit the entire AI assurance projection.

## 24. Troubleshooting

### Sign-in keeps loading

- Confirm the authenticated app origin and Better Auth URL match the deployment.
- Complete email verification when prompted. Email verification and password reset require `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=1` with a configured mail provider (e.g., Brevo); if the deployment has these disabled, the operator must help with account recovery.
- Clear the site session and sign in again.
- If a password is uncertain, use an enabled social provider or ask the operator for invite/account help; never share the password.
- Ask the operator to inspect the authentication API and application logs without sharing your password.

### A scan will not start

- Confirm the target belongs to the active workspace.
- Confirm your role has scan-create permission.
- Check whether the target already has an active scan.
- If the message says the scan service is unavailable, no scan was launched. Wait for the operator to restore worker readiness, then retry once.
- For repository scans, the operator should verify `/api/ready/scans`, Redis queue connectivity, the GPT-5.6 deployment, OpenAI/Azure credentials, sandbox image, and evidence storage. For Azure Foundry, verify that the deployment passes the engine provider-contract baseline; leave programmatic tool calling disabled unless its explicit capability gate passes.
- Review the returned error and scan events. An enqueue race may create a visible `FAILED` scan with a retained queue event, but it will never remain silently queued or be replayed automatically.

### A scan has no findings

Open the scan detail and read coverage receipts and warnings. No findings may mean the assigned checks returned no mapped result, a scanner was not applicable, evidence is required, or the scan was limited. It is not proof that every control passed.

### A report or scorecard link stopped working

The link may have expired, been revoked, or been superseded. Generate a fresh private report link or publish the latest eligible scorecard.

## 25. Recommended workflow

For most solo builders and small teams:

1. Create a workspace and repository target.
2. Run Release Check while iterating.
3. Run Code Review before a meaningful release.
4. Inspect coverage and limitations before interpreting findings.
5. Record the fix proposal, apply the change, and queue a fresh retest.
6. Run Deep Security Review for high-risk or complex releases that need additional depth.
7. Generate the report appropriate for the reader.
8. Publish a privacy-bounded scorecard only when you want a public artifact.
9. Add Weekly Monitor after the first release.

This keeps routine work simple while preserving deeper review for releases where it provides the most value.

### Local/Desktop workflow (BYOK)

For users who prefer to run scans on their own AI and keep everything local:

1. Activate your LyraShield Local license on macOS or Windows.
2. Configure BYOK — connect a ChatGPT/OpenAI subscription (OAuth) or Azure OpenAI.
3. Scan locally; all depths are available with zero agent-minute metering.
4. Optionally connect your LyraShield account to sync findings to the cloud.

### 20.8 Cloud sync (Local → Cloud) — authenticated monotonic evidence sync

- **Device-bound proof:** the raw license key is stored only in the OS keychain (Rust native). It never lives in React state or browser localStorage, and is never returned in API responses. All sync calls require an authenticated web session (`requireAuth`) plus the key proof (hashed, narrow privileged lookup).
- **Workspace binding:** sync is bound to a single workspace via `withWorkspaceRLS`. Direct-purchase licenses (`workspaceId = NULL`) become bound on first `POST /api/sync/connect`; subsequent calls are rejected unless the caller is a member of that workspace. Under a `NOBYPASSRLS` DB role the binding is enforced at the DB layer.
- **Monotonic sequence:** `SyncCursor.seq` (BIGINT, `20260822190000_sync_cursor_sequence`) is the sole ordering primitive. Every `POST /api/sync/findings` must send `expectedSeq` (current trusted seq). The server does a CAS (`updateMany where seq = expectedSeq` inside `withWorkspaceRLS`); concurrent batches with the same expected seq — exactly one wins, the other gets `409 CURSOR_STALE`. Stale or reordered distinct batches are rejected; exact replays of the same findings at `expectedSeq = currentSeq` or `currentSeq-1` are idempotent (`duplicate:true`, seq unchanged).
- **Detection-state-only:** the server forces `verified = false` and maps `FIXED → FIXED_PENDING_RETEST`; any `verified:true`, `status = FIXED` (unless mapped), or unknown status is rejected (`400 FORGED_VERIFICATION / INVALID_STATUS / FORGED_TERMINAL_STATUS`). Only `OPEN` (and the mapped `FIXED_PENDING_RETEST`) traverse the boundary.
- **Reports atomic:** `reports[]` (max 50, 500 kB each) are persisted atomically in the same `withWorkspaceRLS` transaction as findings, via the `Report` model (`contentJson` holds the local evidence payload). Either all findings + reports + seq advance commit, or none do. Discarded/bounded input is never counted (`reportsPersisted` vs `reportsReceived`).
- **Trusted native cursor:** the desktop keeps one trusted cursor row (`sync_state` id=1, `seq` INTEGER) in native SQLite. It is the only source of `expectedSeq`; the server's `GET /api/sync/cursor` (`seq` / `cursor` alias, `lastSyncedFindingId`, `lastSyncedAt`) is the authoritative source on restart or `409` rewind. The client parses the actual envelope `data.seq` / `data.cursor`, not a top-level `cursor` string heuristic, and adopts the server seq on conflict.
- **Restart & rewind recovery:** after a crash or `409 CURSOR_REWIND`, call `GET /api/sync/cursor` (or `fetch_and_adopt_cursor` in Rust) to adopt the server seq before retrying. `PUT /api/sync/cursor` cannot advance seq — only `POST /api/sync/findings` CAS can.
- **Logout / revoke:** revoked licenses are rejected on every sync endpoint; `disconnect` clears the native `sync_state` row (keychain license remains for activation).
