# LyraShield AI User Guide

Last verified against the application code and open-registration deployment: 2026-07-22

LyraShield AI helps builders review an application before release and retain an evidence-backed record of what was checked. The product workflow is:

**Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report**

This guide covers the public Lite Check, authenticated dashboard, scan choices, findings, fixes, reports, scorecards, teams, integrations, schedules, notifications, MCP tools, and current limitations.

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

The public Tools area provides five utilities whose inputs remain in the browser:

1. AI app launch checklist.
2. Security headers and CORS checker.
3. Secret exposure scanner.
4. Supabase row-level-security review helper.
5. JWT and session inspector.

These utilities provide guidance and local analysis; they do not create authenticated scan evidence or an official score.

### 2.3 Public methodology and sample report

Use the public methodology page to understand scoring, evidence states, and limitations. The sample report is illustrative and must not be treated as a result for your application.

## 3. Account access

### 3.1 Create an account

1. Open [https://app.lyrashieldai.com](https://app.lyrashieldai.com).
2. Select **Sign up**.
3. Enter your name, email, and password.
4. Complete email verification when prompted, then continue through onboarding.

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

Review the workspace, target, and goal, then select **Start safe scan**. The first scan always uses Safe mode. Other review depths are available from the Scans page afterward.

## 5. Navigation and workspace switching

The primary navigation contains:

- **Overview** — current launch verdict, assurance progress, risk posture, remediation flow, retained finding mix, recent scans, and monthly usage.
- **Assets** — repository, web-application, and API targets.
- **Scans** — create, monitor, cancel, and inspect scans.
- **Findings** — filter and work through detected risks.
- **Reports** — create, download, share, and revoke assurance reports.
- **Settings** — workspace posture, counts, retention, telemetry state, connected surfaces, and account deletion.

Open **More** for Projects, Fix proposals, Schedules, Team, Integrations, and Notifications. Use the workspace switcher above the navigation to change the active workspace. Every page and action is evaluated against the active workspace and your role.

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
- environment: Local, Preview, Staging, or Production.

URL and API targets use the pinned deterministic URL scanner. The external AI engine is not invoked for these targets. Review depth still describes the requested workflow, but it does not turn a passive URL scan into a repository or intrusive assessment.

### 7.3 GitHub-connected target

You may also create a repository target from **More → Integrations → GitHub**:

1. Connect the GitHub App.
2. Load repositories the installation is authorized to access.
3. Select a repository.
4. Add it as a target.

The default branch and repository visibility are returned by GitHub. A connected installation is not proof that every repository is accessible; access follows the installation's selected repositories and provider permissions.

### 7.4 Target detail

Open a target to view repository or URL details, its recent scans, latest eligible LyraShield Score, and public-scorecard controls when your role permits publication.

## 8. Scan types and models

The authenticated dashboard exposes three one-off review depths. Weekly Monitor is the recurring user workflow.

| User option          | Backend mode | Model for repository engine | Reasoning |
| -------------------- | ------------ | --------------------------- | --------- |
| Release Check        | SAFE         | GPT-5.6 Luna                | Medium    |
| Code Review          | STANDARD     | GPT-5.6 Luna                | Medium    |
| Deep Security Review | DEEP         | GPT-5.6 Terra               | Medium    |
| Weekly Monitor       | SAFE         | GPT-5.6 Luna                | Medium    |

The backend also supports QUICK (Luna/medium) and CUSTOM (Terra/medium coordination with Luna/medium specialists) for approved API or agent workflows. They are not additional one-off dashboard choices. GPT-5.6 Sol is retained in internal accounting but is not currently assigned to a scan preset.

LyraShield applies protected internal run limits automatically. The dashboard does not display model costs, spend, or accounting events. If a protected limit is reached, the scan ends with a neutral limit message while operators retain the internal usage record for reconciliation.

## 9. Start and monitor a scan

1. Open **Scans**.
2. Select **New Scan**.
3. Choose a target.
4. Choose Release Check, Code Review, or Deep Security Review.
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

The Vibe Security 50 ledger contains one receipt for each control. Read `NO_FINDING` as “the assigned scanner returned no mapped finding,” not “passed.” Seven controls always require operational or human evidence.

## 11. Findings

Open **Findings** to review all retained findings in the active workspace. Available list filters are All, Critical, High, Medium, Low, Open, Fixed, and Verified.

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

Depending on your permission, you may also mark a finding as accepted risk or false positive. These are audited decisions, not silent deletion.

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

Open **Reports → Generate Report** and choose:

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

## 17. Schedules

Open **More → Schedules → New Schedule** and configure:

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

### GitHub

The current dashboard integration supports connecting the GitHub App, loading authorized repositories, and creating repository targets. Installation identifiers are globally unique and provider ownership must be proven before a fresh callback can create a workspace integration.

Other integration types exist in the internal schema and roadmap, but the current dashboard should not be read as offering active Slack, Jira, Linear, Teams, ServiceNow, SIEM, or compliance-platform connections.

## 21. Settings and account deletion

The Settings page displays:

- workspace name, mode, and plan;
- target, scan, finding, and member counts;
- retention period;
- product-telemetry state;
- active security-control summary;
- shortcuts to Team, Integrations, Notifications, and Schedules.

The current settings surface reports retention and telemetry configuration but does not provide self-service editors for every field.

To delete your account, enter the exact confirmation text `DELETE`. Deletion is blocked when you are the sole owner of a workspace because removing the account would orphan it. Transfer or add ownership first. Deletion anonymizes retained attribution where required and preserves audit-chain integrity.

## 22. MCP and agent workflows

LyraShield exposes four MCP tools:

- `lyrashield_scan_target` — start a scan on a registered target;
- `lyrashield_get_findings` — list findings with optional target or severity filters;
- `lyrashield_get_launch_readiness` — retrieve the current scoped verdict;
- `lyrashield_create_report` — create an executive, developer, or compliance report.

Read actions follow API-key scope and workspace permissions. Mutating MCP actions require interactive approval on the controlling terminal and fail closed when no approval terminal is available. Model-facing inputs pass through the prompt-injection guard.

Use the same supported scan modes as the API: SAFE, QUICK, STANDARD, DEEP, or CUSTOM. Dashboard users should normally prefer the named presets rather than raw modes.

## 23. Current availability

The public marketing site, Lite Check, browser-local tools, methodology, and content are live. The authenticated dashboard is open for registration; its dedicated BullMQ/engine worker remains a separate controlled full-scan boundary. Ordinary web requests use a restricted `NOBYPASSRLS` database role, and repository scan admission fails closed when the worker heartbeat is absent. A current-tree Safe retest and a successful, reconciled Deep controlled scan are still required before the full-scan release gate passes.

The production application has an authenticated application origin, TLS Redis queue, private evidence storage, sandbox-capable worker compute, authorized Luna/Terra deployments, baseline Azure alerts, and DNS-pinned deny-by-default egress. Broad full-scan availability still requires completed controlled-scan proof, application-level readiness/queue/provider alerts, capacity evidence, and backup/restore. No recovery or RPO/RTO claim is made.

Billing plans, plan quotas, automatic server-generated Fix PRs, intrusive exploit replay, a within-scan Luna-to-Terra cascade, Security Copilot, and enterprise identity/deployment controls are not currently user features.

## 24. Troubleshooting

### Sign-in keeps loading

- Confirm the authenticated app origin and Better Auth URL match the deployment.
- Complete email verification when prompted; use password reset when it is enabled for the deployment.
- Clear the site session and sign in again.
- If a password is uncertain, use an enabled social provider or ask the operator for invite/account help; never share the password.
- Ask the operator to inspect the authentication API and application logs without sharing your password.

### A scan will not start

- Confirm the target belongs to the active workspace.
- Confirm your role has scan-create permission.
- Check whether the target already has an active scan.
- If the message says the scan service is unavailable, no scan was launched. Wait for the operator to restore worker readiness, then retry once.
- For repository scans, the operator should verify `/api/ready/scans`, Redis queue connectivity, the GPT-5.6 deployment, OpenAI/Azure credentials, sandbox image, and evidence storage.
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
