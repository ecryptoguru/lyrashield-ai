# LyraShield AI — Production Deployment Gate

> No production deployment is approved by this document. It records the minimum gates that must be satisfied before a release. Choose vendors and infrastructure only after founder approval; do not copy local Docker Compose into production.

`userguide.md` documents the end-user experience. This runbook owns only deployment, configuration, verification, and operational release boundaries.

## Architecture boundary

- The Next.js web application and BullMQ worker need managed PostgreSQL and Redis.
- The worker runs the `lyrashield` CLI and may launch a sandbox. Its host and Docker access are high-risk infrastructure.
- The Astro marketing site is an independent Cloudflare Worker with D1 and Cloudflare Rate Limits.
- Public scorecard pages, social card images, SVG badges, referral capture, and privacy-safe funnel events are served by the Next.js app origin, not the marketing Worker. Server-rendered scorecard metadata must derive its public origin from runtime `BETTER_AUTH_URL`; the shared image may have a scanner-specific `NEXT_PUBLIC_APP_URL` baked at build time.
- S3-compatible evidence storage is mandatory for scans that may produce PoC/code-location artifacts. Email, GitHub OAuth/App integration, and monitoring providers use separate credentials.

## Production gates and current status

This section mixes completed controls, regression boundaries, and unresolved gates. Review each status before any traffic-growth campaign; a resolved item remains here when its configuration or proof must be preserved.

### 1. Email verification is enabled in production — Brevo secrets are required on both application surfaces

**Status:** resolved on 2026-08-21. Both `lyrashield-app` and `lyrashield-scanner` run with `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=1` and a `BREVO_API_KEY=secretref:brevo-api-key` binding. Their production readiness checks pass. The deployment workflow verifies that the pre-provisioned `brevo-api-key` secret exists on every configured Container App before updating a verification-enabled revision.

**Regression boundary.** Do not remove either secret or disable the workflow validation while email verification is enabled. A missing provider credential is a boot-time error, not a reason to accept unverified registration.

**Brevo IP security.** Brevo's "Block unknown IP addresses" setting is disabled at the account level. Azure Container Apps Consumption has 180+ dynamic outbound NAT IPs that cannot be statically allowlisted; maintaining an IP allowlist would silently break email sending when the NAT pool changes. The trade-off is that any holder of the Brevo API key can send emails from any IP — protect the key accordingly.

**Way out (small, well-defined).**

1. A Brevo API key is provisioned and verified. The sender address (`support@lyrashieldai.com`) must be verified in Brevo.
2. Pre-provision the `brevo-api-key` Container App secret on both `lyrashield-app` and `lyrashield-scanner`; bind `EMAIL_FROM` and `NOTIFICATION_FROM_EMAIL` where email is sent.
3. Set the `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION` repository variable to `1`; `deploy-azure.yml` binds the existing secret to both Container Apps and fails before deployment if either secret is missing.
4. Deploy. `packages/auth` enforces verification once the flag and the provider are both present; the boot-time refinement in `packages/config/src/env.ts` guarantees the two can never disagree.

**Do not** re-enable the flag without the key. The deploy will fail fast by design rather than silently accepting unverified sign-ups.

**Related history.** The flag was declared in the env schema and read by no code until 2026-07-30, so setting it previously had no effect and real behaviour derived from whether `BREVO_API_KEY` happened to be set. It is now authoritative. PR #247 (2026-08-09) verified the full Brevo integration locally.

### 2. Verify the runtime database role cannot bypass RLS

**Status:** verified on 2026-08-22. The worker VM queried the runtime connection as
`app_runtime_prod`; both `rolsuper` and `rolbypassrls` were `false`. Re-run this
check whenever the runtime credential or database role changes.

**Why it matters.** All 30 tenant-scoped tables (21 workspace tables plus 9 child tables: `Evidence`, `FixProposal`, `PullRequest`, `ScanCoverageReceipt`, `ScanEvent`, `ScanResultManifest`, `ScorecardEvent`, `ScorecardShare`, `Ticket`) carry fail-closed RLS policies and
`FORCE ROW LEVEL SECURITY`. `FORCE` subjects the table _owner_ to those policies — it does
**not** affect superusers or any role with `BYPASSRLS`. A superuser connection bypasses
row-level security unconditionally, so if `DATABASE_URL` connects as one, every policy is
inert and tenant isolation rests entirely on the application-layer Prisma extension. Managed
Postgres providers commonly hand out a superuser as the default user, so this is easy to
inherit by accident.

Verified empirically on 2026-07-30 against a local instance with the production migration
chain applied: as a superuser, a cross-workspace `SELECT` returned the other tenant's row
and a cross-workspace `UPDATE` modified it. As a `NOSUPERUSER NOBYPASSRLS` role, both
returned zero rows.

**How to check.**

```sql
SELECT current_user, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = current_user;
```

Both booleans must be `false`. If either is `true`, provision a dedicated runtime role and
point `DATABASE_URL` at it, keeping the privileged role only for migrations
(`DATABASE_DIRECT_URL`):

```sql
CREATE ROLE app_runtime LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE <db> TO app_runtime;
GRANT USAGE ON SCHEMA public, app TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
```

### 3. Shared rate limiting is enforced at deploy, not at boot

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are asserted by the deploy workflow
before the container image is swapped, and passed to both apps as secret references. Without
them the limiter falls back to a per-instance in-memory store, so the effective limit becomes
(limit x replica count) and scaling out to absorb load weakens the control.

Exact dependency probes (`/api/health`, `/api/ready`, `/api/ready/scans`) use a
per-instance 120-request/minute guard and do not spend Upstash REST commands. If a
runtime Upstash request fails, ordinary API/auth/webhook limits fall back to their
existing in-memory buckets for a 60-second cooldown before one shared-limit probe is
retried. The cooldown log contains only a bounded reason category; it never includes the
client identifier or provider response. Rotate the REST URL and token as one matching
credential pair. Initialization failures follow the same cooldown and retry once it expires.
Updating BullMQ `REDIS_URL` does not update this separate control.

This is deliberately a deploy gate rather than boot validation. Boot validation fires in
every production-mode process — including the Playwright E2E server — and would fail a
running app on restart, trading a rate-limiting weakness for an availability outage. The
deploy check catches the same misconfiguration at the only moment it can be fixed safely.

**2026-08-22 alerting update.** `app-any-5xx` is enabled on `lyrashield-app` with a
one-minute evaluation window and routes to `lyrashield-operator-alerts`. It catches a
scan-readiness `503` even when the request volume is below the broader `app-http-5xx`
threshold. This is incident detection, not a substitute for worker heartbeat and queue
recovery proof.

**Regression cover.** `packages/db/src/rls-fail-closed.test.ts` asserts the deny-by-default
behaviour against a real database, and refuses to run — rather than passing vacuously —
when handed a role that can bypass RLS. CI provisions that restricted role and exports
`RLS_RUNTIME_DATABASE_URL`.

### 4. Container registry cleanup — RESOLVED 2026-07-30, updated 2026-08-01

**Status:** live. `cleanup-old-images` in `deploy-azure.yml` runs after every successful
image build, even when the Azure deploy is skipped or later fails, with `dry-run: false`, removing dangling untagged manifests. Web/scanner images
keep the most recent 10 tagged versions; worker images keep the most recent 100 tagged
versions because the worker VM pins images by digest and the approved digest may lag
behind `main` deploys.

**Why this existed.** Historically, every merge to `main` pushed a new SHA-tagged image and re-pointed
`:latest`; worker publication now uses SHA-only tags. Multi-arch buildx pushes also leave several
untagged manifests per build. Confirmed 2026-07-30: `lyrashield-web` had 10 versions (6
untagged) and `lyrashield-worker` had 4 (3 untagged) after only a handful of deploys.

**Why it shipped in dry-run first.** Deleting container images is irreversible, and a naive
"delete this version ID" approach can remove an untagged manifest that a _kept_ tagged
manifest list still references, silently breaking a future pull of an image that still looks
valid. `dataaxiom/ghcr-cleanup-action` resolves manifest lists before deleting specifically to
avoid that, but a first run against accumulated history was reviewed before going live rather
than trusted blind.

**Rollout and rollback boundary.** The deployment workflow reads the least-privilege
`ghcr-token` from `lyrashieldprodsecrets`, proves both exact image manifests are pullable,
and syncs the registry credential before creating a revision. Renew that `read:packages`
classic PAT before its current 2026-11-20 expiry; the deploy identity has
`Key Vault Secrets User` only on that secret. All three Container Apps use multiple-revision
mode. Existing production revisions keep 100% traffic while app, scanner, and egress-proxy
candidates pass their revision-specific readiness checks in parallel. The egress proxy
allows only the worker VM IP, so CI verifies its candidate and promoted endpoint from that
VM through Azure Run Command instead of weakening ingress or accepting the runner's expected
`403`. Only then does one step promote all candidates. Failed promotion or public readiness
restores every captured previous traffic target. The scanner keeps one warm replica so a
scale-from-zero private image pull cannot turn `/api/ready` into a multi-minute timeout.
Revision recovery never reverses database migrations or application-scope secrets and
configuration.

**What the review found.** Run `30496418272`'s dry-run pass reported "no tagged images found
to delete" and "no untagged images found" for both packages — with `keep-n-tagged: 10` and
only ~10 total accumulated versions, nothing had aged out yet. The first live run is a
verified no-op, not a leap of faith; it starts actually pruning once deploy counts exceed the
keep threshold. The 2026-08-01 update splits worker cleanup into its own step with
`keep-n-tagged: 100`, emits `web_digest` and `worker_digest` from the build, and deploys
app/scanner images as `image:tag@sha256:<digest>` so the running container is pinned to an
immutable manifest even if the `:latest` tag moves.

### 5. Production backup and restore proof completed; monitoring remains

**Status:** backup automation is live. On 2026-08-21 an encrypted backup was restored into an
isolated environment and schema, RLS, audit-chain, and application startup checks passed. This is
one restore drill, not an RPO/RTO claim. Alerting on missed backups, recurring restore drills,
capacity evidence, and named recovery ownership remain required.

**Operating rule.** Keep the backup destination and credentials separate from ordinary evidence
storage where practical, retain the workflow run and artifact metadata as release evidence, and
alert on a missed scheduled run or failed upload. Keep the exact drill artifact and assertions;
do not generalize one successful drill into guaranteed recovery time or data-loss bounds.

### 6. GitHub App connect path is provisioned; ownership proof remains load-bearing

**Status:** the GitHub App and its six repository secrets are configured. The callback requires
OAuth-during-installation ownership proof and fails closed when client credentials are absent.
Re-run the positive install, duplicate-workspace rejection, reconnect, and webhook-delivery checks
after any App permission, credential, callback, or deployment change.

**Exposure.** `POST /api/integrations/github/install` calls `getInstallAppUrl()`, which throws
`GITHUB_APP_SLUG not configured` when `GITHUB_APP_SLUG` is empty. The route catches it and
returns 500 `{ code: "CONFIG_ERROR", message: "GitHub App is not configured" }`. Previously
(days 1-3 of the beta, pre-F1) onboarding was REPO-only: step 2 was "Connect GitHub" as the only
way forward, and `(dashboard)/layout.tsx` redirects any user whose onboarding is neither
`completed` nor `skipped` back to `/onboarding`. A 500 on that one path = every new signup bricked.
That exact scenario was verified live in a browser on 2026-07-30.

**F1's fix (merged 2026-07-30):** step 2 is now a four-way choice: Connect GitHub / Add app URL
/`Add API / Skip`. The non-GitHub paths never call the install endpoint, and `connectGitHub()`
now explicitly degrades — it marks the GitHub option unavailable, keeps the three other paths,
and shows a stable `GitHub connect is unavailable right now…` message (never the raw server error).
A brand-new signup therefore survives without GitHub (URL/API scan or skip → dashboard) even while
the GitHub path 500s. The P0 is closed.

**Why the GitHub path still matters.** Without the GitHub App, private-repository scanning and any
flow that needs the App's `Contents: Read` / `Metadata: Read` / webhook delivery remain disabled.
For a beta that may grow from URL scans to repo scans, that is a real conversion drop-off. The App
path's own code is intentionally **failing closed**: the install callback (`GET
/api/integrations/github/install`) requires an existing workspace `Integration` binding for the
`installation_id` (IDOR / enumeration defense) and the deploy pipeline never creates a secret
from a callback-supplied parameter. Those gates are load-bearing, not placeholders — see
`PRODUCTION_DEPLOYMENT.md` prerequisites and `AGENTS.md`'s "GitHub installations and Fix PRs"
rule.

**Provisioning and rotation checklist.**

1. **Create the GitHub App** (owner: `ecryptoguru`, same account that owns `lyrashield-ai`):
   - `https://github.com/settings/apps/new`
   - **General**: name `LyraShield AI (app.lyrashieldai.com)`, description `Release assurance for AI-built apps — authorized repository scanning.`, homepage `https://lyrashieldai.com`.
   - **Webhook**: active; URL `https://app.lyrashieldai.com/api/webhooks/github`; generate a webhook secret now and save its value (it becomes `LYRASHIELD_GITHUB_APP_WEBHOOK_SECRET`). Subscribe to `Installation` (deleted signal) and `Pull request` (if Fix PR automation is on) delivery — unsubscribe from everything else.
   - **Repository permissions — start minimal** (expand only when the first flow that needs more lands; every permission addition requires re-authorizing installs):
     - `Contents: Read` — scan authorized code.
     - `Metadata: Read` — list repos for the `POST /api/integrations/github/repos` call.
     - `Pull requests: Read and write` — **only** when server-generated, approval-bound Fix PRs are implemented; until then `Read` is enough.
   - **Account permissions**: none required for today's beta (the install-URL uses the slug; listing installs needs the App JWT only).
   - **Identifying and authorizing users**: tick **"Request user authorization (OAuth) during installation"** and set the **Callback URL** to `https://app.lyrashieldai.com/api/integrations/github/install` (the same route that receives the install callback). This is REQUIRED, not cosmetic. `installation_id` on its own is a global, enumerable value that proves nothing about who is calling, so the callback binds a workspace only after exchanging the `code` GitHub appends for a user token and confirming through `GET /user/installations` that the installer actually administers that installation. With the box unticked no `code` ever arrives, every first-time install fails closed with `?github=verification_required`, and nobody can connect the integration.
   - **Privacy / visibility**: the App must be **Public** for any account other than the owner to install it — a Private App 404s `https://github.com/apps/<slug>/installations/new` for everyone else, which surfaces to users as GitHub claiming the app does not exist. "Public" governs who may _install_; it does not grant anyone access to your repos. Keep installs scoped to specific `ecryptoguru` repos (or "all repos on the account" if the boundary is governed by the per-workspace allowed-repo list instead).

2. **Note the six values the deploy pipeline needs:**
   - `GITHUB_APP_ID` — numeric App ID from the GitHub App settings page.
   - `GITHUB_APP_SLUG` — the slug from the URL `https://github.com/apps/<slug>` (e.g. `lyrashield-ai`).
   - `GITHUB_APP_PRIVATE_KEY` — PEM private key: scroll to the bottom of the App settings page, `Generate a private key`, download the `.pem`, paste the full contents including `-----BEGIN RSA PRIVATE KEY-----`/`-----END RSA PRIVATE KEY-----`. GitHub rotates this immediately when a new one is generated — the old one stops working the instant the new one exists.
   - `GITHUB_WEBHOOK_SECRET` — the webhook secret you generated in step 1.
   - `GITHUB_APP_CLIENT_ID` — the App's own OAuth **Client ID** (App settings → General). NOT `GITHUB_CLIENT_ID`, which belongs to the separate social-sign-in OAuth app.
   - `GITHUB_APP_CLIENT_SECRET` — App settings → General → `Generate a new client secret`. Shown once; copy it immediately.

3. **Add them as repository secrets** in `ecryptoguru/lyrashield-ai` (Settings → Secrets and variables → Actions → Repository secrets):
   - `LYRASHIELD_GITHUB_APP_ID`, `LYRASHIELD_GITHUB_APP_SLUG`, `LYRASHIELD_GITHUB_APP_PRIVATE_KEY`, `LYRASHIELD_GITHUB_APP_WEBHOOK_SECRET`, `LYRASHIELD_GITHUB_APP_CLIENT_ID`, `LYRASHIELD_GITHUB_APP_CLIENT_SECRET`.

4. **Deploy wiring — already shipped in `.github/workflows/deploy-azure.yml` (PR #180+):**
   - `Verify GitHub App credentials` checks the four core App secrets and separately warns when either OAuth client secret is missing; without the OAuth pair, new workspace binding fails closed.
   - `Sync GitHub App secrets to Container Apps` syncs the four core secrets and the OAuth client pair to both Container Apps. Rotating a repository secret therefore also rotates the Container App copy; avoid partial configuration.
   - `Deploy app Container App` / `Deploy scanner Container App` — `--set-env-vars` now includes `GITHUB_APP_ID=secretref:github-app-id` etc. `secretref:` requires the Container App to already define a secret with that name — provisioned by the sync step just above on every deploy, so rotation is automatic and a fresh Container App gets its secrets for the first time.

5. **Verify after the deploy — run the flow to completion, not just to the redirect.** The previous version of this checklist stopped at "the install URL opens", which is exactly why a callback that could never create a binding went unnoticed:
   - `curl https://app.lyrashieldai.com/api/ready` should still be `{"status":"ready",...}`.
   - As a brand-new signup, step 2 should show all 4 options and "Connect GitHub" should be enabled (not "GitHub connect is unavailable right now…").
   - Clicking "Connect GitHub" should open `https://github.com/apps/<slug>/installations/new?state=...` in a new tab (the `state` param is workspace-bound and signed — S2 defense), not 500.
   - **Complete the install on a real account.** GitHub should show its authorization prompt (proof the OAuth-during-installation box is ticked), then land back on `/dashboard/integrations?connected=github` with the account name rendered — NOT `?github=verification_required`.
   - **Confirm the row exists**: one `Integration` row with `type=GITHUB`, `status=active`, `externalId` = the installation id, plus an `integration.github.connected` audit-log entry.
   - **Negative check**: installing the same installation from a second workspace must land on `?github=already_claimed` (the `@@unique([type, externalId])` guard), not bind twice.
   - **Reconnect check**: disconnect, then install again — the soft-deleted row should revive rather than collide.
   - `POST /api/webhooks/github` deliveries (GitHub App settings → Advanced → Recent Deliveries → Redeliver) should 200 and write `webhookEvent` rows (`@@unique([provider, externalId])` idempotency).

**Do not:**

- Hard-code PEM keys or webhook secrets in GitHub workflow files, Terraform, or `*.md` examples.
- Set any `GITHUB_APP_*` env var from workflow `vars` (non-secret) — they must come through `secrets` + `secretref:`.
- Add broader GitHub App permissions (e.g. `Administration`, `Organization`, `Checks: Write`) until the first flow that requires them lands and the extra permission is reviewed as part of that PR's threat model.

**Outstanding audit-account hygiene.** Verify whether `devagent-uxaudit2+20260730@fusionwaveai.com` and `devagent-uxaudit3+20260730@fusionwaveai.com` still exist. If present, purge them only through the RLS-safe account-deletion path; never delete their rows directly.

## Release prerequisites

1. Public HTTPS application and marketing origins plus all trusted auth origins are decided. Scorecard canonical/OG/Twitter URLs must resolve to the application origin.
2. Production Postgres migrations and the CI migration-drift check pass. Before applying `20260714170000_integration_global_external_id_unique`, resolve any duplicate non-null `(type, externalId)` bindings explicitly; the migration intentionally fails rather than silently reassigning an installation.
3. Redis is managed, authenticated, TLS-protected, and reachable by both web and worker without exposing an unauthenticated public Redis port. `REDIS_URL` (`rediss://`) is the Upstash TCP endpoint for BullMQ; `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are the HTTPS interface for distributed rate limiting. The two protocols are never interchangeable. A literal private-network endpoint remains an enterprise deployment option rather than an open-beta prerequisite.
4. All secrets are supplied through the platform's secret manager, never committed files.
5. The worker runs on disposable, dedicated scan infrastructure. It must not share a host, Docker daemon, filesystem, network namespace, or secret boundary with the web application, database, or unrelated workloads.
6. The worker reaches that isolated Docker daemon through `DOCKER_HOST=ssh://...` or a mutually authenticated `tcp://...` endpoint. A production worker fails fast for a local Unix socket; `docker-compose.yml` is development-only.
7. The sandbox image is pinned to the immutable digest emitted by the engine's `publish-sandbox` workflow after both architecture-specific non-root smoke tests pass. That workflow emits BuildKit provenance, an SPDX SBOM, and GitHub/Sigstore-signed attestations. Mutable tags and upstream `usestrix` images are not acceptable.
8. The stale-resource reaper is enabled with a conservative age threshold. It must be able to read active scan state, skip every active scan and running container, and report each cleanup result.
9. Authorized Luna and Terra deployment names plus the matching provider credentials are available for a controlled scan; the fallback model is also configured and tested.
10. Egress policy, DNS pinning/proxying, logs, alerts, backup, and restore ownership are defined. CISA KEV enrichment uses the authenticated proxy; FIRST EPSS remains a direct bounded HTTPS endpoint because its batched query-string protocol is not accepted by that proxy.
11. `.github/workflows/deploy-azure.yml` pins the exact reviewed engine commit. PR CI proves that the pin is merged into engine `main`, its named engine checks passed, and the worker contract is compatible. The main deployment repeats provenance and contract checks, builds and pushes the SHA-only worker candidate, verifies its exact digest and OCI labels, then automatically promotes it only after the Container App rollout passes. Promotion stops admission, proves the database and queues are idle, pre-pulls the digest before registry cleanup, retains the prior configuration for rollback, restarts the systemd worker, reconciles configured/running provenance and Docker health, checks `/api/ready/scans`, and resumes admission. Advance the engine pin only after the engine change is merged and green; never point it at a branch or mutable tag.

### Evidence envelope key provisioning (LYRASHIELD_EVIDENCE_KEK)

Every evidence artifact is client-side envelope-encrypted (per-object AES-256-GCM
data key, wrapped under this KEK) before it reaches the bucket. The key is a
one-time secret:

1. **Generate once**: `node packages/evidence-storage/scripts/generate-kek.mjs`
2. **Store durably first** (password manager / KMS / sealed offline copy): loss
   of the KEK makes every artifact written under it permanently unreadable —
   there is no recovery path. Rotating to a new KEK only affects NEW artifacts;
   existing envelopes record the key ref they were sealed under.
3. **Provision**:
   - GitHub variable `LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF` and secrets
     `LYRASHIELD_EVIDENCE_KEK` and `LYRASHIELD_EVIDENCE_KEK_KEYRING` — the
     deploy workflow validates the
     canonical 32-byte keys and versioned `vN` reference, then injects the
     active ref and immutable Container App secrets `ev-kek-vN` and
     `ev-ring-<12-character-keyring-digest>`. Content-addressing the keyring lets
     a future key be distributed before activation and retained during rollback
     without overwriting the configuration used by an older revision.
   - Key Vault secret `worker-evidence-kek-config-ref`, whose value is
     `vN/<12-character-keyring-digest>`, plus immutable
     `worker-evidence-kek-vN` and
     `worker-evidence-kek-keyring-<12-character-keyring-digest>` secrets. The
     worker VM reads the single selector first, derives the immutable names, and
     writes the coherent set atomically via `ops/worker/refresh-secrets.sh`.
     Every entry is required.
4. **Never** commit the value, paste it into tickets/chats/logs, or reuse
   another secret for it.

Do not overwrite an immutable KEK or keyring in place. First distribute the
future key in the v1 keyring while v1 remains active, and verify v1 readback on
every reader. Then activate v2 with v2 as the primary and v1 in its keyring.
During rollback, restore v1 as primary but keep v2 in the content-addressed v1
keyring so evidence written during the overlap remains readable. A keyring may
therefore contain future versions, but never the active reference or active key
material; it must always contain every prior version. Removing any entry
requires separate retention, backup, restore, and retained-readback evidence.

Use this order; do not skip directly to v2:

1. Confirm durable offline recovery for v1 and choose exact retained v1 evidence
   IDs and checksums without copying private URIs into the change record.
2. Create immutable v2 and overlap-keyring secrets in GitHub, the app Container
   App, and Key Vault. Do not change either active selector yet.
3. Deploy the reviewed code while v1 remains active. Existing workers remain
   compatible: refresh first tries `worker-evidence-kek-config-ref`, then the
   earlier `worker-evidence-kek-active-ref` layout, then the original fixed
   `worker-evidence-kek` as v1 with an empty keyring. A present malformed newer
   selector fails closed and never falls back.
4. Select the v1 overlap configuration whose keyring contains v2. Restart the
   worker only after database/queue preflight permits it, then require app
   evidence readiness, worker readiness, disposable storage proof, and retained
   v1 readback.
5. Select v2 with v2 primary and v1 retained. Repeat every readiness and
   readback gate, then verify one newly retained v2 artifact.
6. For rollback, reselect the content-addressed v1 overlap configuration. Never
   use the original empty v1 keyring after any v2 artifact may have been written.
   Require retained v1 and v2 readback before resuming admission.

After every rotation and before removing any historical key, verify one exact
retained evidence record written under each retained reference. This command
prints only a fixed success marker; it never prints artifact content, storage
URI, key material, or configuration:

```sh
pnpm --filter @lyrashield/worker verify:retained-evidence -- \
  --evidence-id <exact-evidence-id> \
  --workspace-id <exact-workspace-id> \
  --expected-key-ref <exact-versioned-key-ref> \
  --expected-checksum <exact-lowercase-sha256>
```

## Full-scan resource checklist

The live Lite Scanner is a separate passive API and cannot be promoted into the full worker by configuration alone. A controlled repository scan requires all of the following:

- migrated PostgreSQL for application and scan state;
- a managed authenticated `rediss://` service compatible with BullMQ and reachable by both web and worker. Production uses the Upstash TLS TCP endpoint for `REDIS_URL`; the Upstash REST URL/token variables remain the separate HTTP interface used by `@upstash/ratelimit` and do not replace `REDIS_URL`;
- a deployed authenticated Next.js application origin to create targets, authorize users, enqueue scans, and render retained results;
- dedicated worker compute with Git, the `lyrashield` CLI, the inspected engine source, controlled access to the digest-pinned sandbox runtime, and a dedicated internal network shared only with scan sandboxes;
- a host-visible `/var/lib/lyrashield/worker` run root bind-mounted at the same absolute path in the worker, with engine `TMPDIR` below it, so host Docker can resolve every read-only sandbox bind source;
- the worker must pass that host-visible `TMPDIR` to the engine child. A container-local
  `/tmp` lets the engine clone successfully but makes the source path invisible to the
  host Docker daemon, causing sandbox creation to fail before any model request;
- an authorized Luna/Terra/fallback model route and provider credentials;
- private S3-compatible evidence storage configured through all five `S3_*` values;
- secret management, TLS, monitoring, backup/restore, and deployment-level egress enforcement.

Brevo is required when production email verification or invitations are enabled. GitHub App credentials are required for private-repository integration flows. Slack/Discord, billing, and product analytics are optional integrations and are not scan-runtime dependencies.

## Required web/shared and worker configuration

Set only the production values appropriate to each process. Web and Lite Scanner Container Apps use the shared application values; they must not require or receive worker sandbox configuration. `ops/worker/run-worker.sh` owns injection of worker-only model, engine, Docker, sandbox, reaper, telemetry, and concurrency values.

```bash
DATABASE_URL="postgresql://..."
DATABASE_DIRECT_URL="postgresql://..." # direct migration connection when using a pooler
REDIS_URL="rediss://..."  # BullMQ job queue (Upstash TLS TCP endpoint in production)
UPSTASH_REDIS_REST_URL="https://..."  # Distributed rate limiting REST endpoint
UPSTASH_REDIS_REST_TOKEN="..."  # Required when UPSTASH_REDIS_REST_URL is set
BETTER_AUTH_SECRET="..."
BETTER_AUTH_URL="https://app.example.com"
NEXT_PUBLIC_APP_URL="https://app.example.com"
NEXT_PUBLIC_MARKETING_URL="https://www.example.com"
BETTER_AUTH_COOKIE_DOMAIN=".example.com" # only when app and marketing share a parent domain
ADDITIONAL_TRUSTED_ORIGINS="https://www.example.com"
TRUSTED_PROXY_IP_HEADER="x-forwarded-for" # only after ingress strips incoming copies

# Email. The schema default is "1" and production refuses to boot when verification
# is required but no provider is configured. Production keeps this enabled.
LYRASHIELD_REQUIRE_EMAIL_VERIFICATION="1"
BREVO_API_KEY="..."
EMAIL_FROM="noreply@example.com"

# Optional OAuth sign-in/sign-up. Register these exact production callback paths:
# https://<app-origin>/api/auth/callback/github
# https://<app-origin>/api/auth/callback/google
# https://<app-origin>/api/auth/callback/microsoft
# OAuth sign-up is open when the provider is configured and credentials are complete.
GITHUB_CLIENT_ID="..."
GITHUB_CLIENT_SECRET="..."
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
AZURE_AD_CLIENT_ID="..."
AZURE_AD_CLIENT_SECRET="..."
AZURE_AD_TENANT_ID="common"

# Billing provider configuration is app-only. The deploy workflow validates the
# complete protected-environment set and still forces all purchase admissions off.
POLAR_ENVIRONMENT="production" # use sandbox only in isolated billing staging
POLAR_ACCESS_TOKEN="..."
POLAR_ORG_ID="..."
POLAR_WEBHOOK_SECRET="..."
POLAR_PRODUCT_IDS='{"starter_monthly":"..."}'
POLAR_LOCAL_PRODUCT_IDS='{"individual_launch":"..."}'
POLAR_BILLING_ADMISSION="off"
POLAR_LOCAL_BILLING_ADMISSION="off"
RAZORPAY_KEY_ID="..."
RAZORPAY_KEY_SECRET="..."
RAZORPAY_WEBHOOK_SECRET="..."
RAZORPAY_PLAN_IDS='{"starter_monthly":"..."}'
RAZORPAY_BILLING_ADMISSION="off"
RAZORPAY_LOCAL_BILLING_ADMISSION="off"
BILLING_CANARY_WORKSPACE_IDS=""
```

`BETTER_AUTH_URL` is the server-owned authenticated application origin and is also the canonical source for public scorecard metadata. Keep it set to the app origin on both app and Lite Scanner revisions. `NEXT_PUBLIC_APP_URL` remains surface-specific and may be baked into the shared image, so it must not override scorecard canonical or social-card URLs.

After candidate and public smoke checks pass, deployment deactivates every
superseded active Container App revision while retaining exactly the promoted
revision and its one previous rollback revision for app, scanner, and egress
proxy. Cleanup refuses to touch any traffic-serving revision and fails if the
expected current or rollback revision is missing.

### Database boundaries and worker-only configuration

The production worker requires the restricted runtime database URL and a separate system URL for reviewed cross-workspace ownership and recovery operations. `ops/worker/refresh-secrets.sh` maps Key Vault secrets `worker-database-url` and `worker-database-system-url` to these variables and fails closed if either is absent. The production web app also requires its separately provisioned system connection for explicitly reviewed global boundaries such as public share-token resolution, invitation acceptance, license operations, and platform administration; never point it at the ordinary runtime role or expose it to the Lite Scanner. Keep the system role non-superuser, non-replicating, and no broader than those reviewed operations. Billing staging instead binds its no-membership/NOREPLICATION `app_system_staging` role limited to exact license operations and keeps ordinary traffic on `app_runtime_staging` with RLS enforced. The worker also requires the authenticated egress-proxy URL and secret so it cannot accept production URL jobs without the safe fetch boundary.

```bash
DATABASE_URL="postgresql://..." # worker-database-url; RLS-restricted runtime role
DATABASE_SYSTEM_URL="postgresql://..." # worker-database-system-url; privileged ownership-check role
REDIS_URL="rediss://..."
BETTER_AUTH_SECRET="..."
BETTER_AUTH_URL="https://app.example.com"
NEXT_PUBLIC_APP_URL="https://app.example.com"

LYRASHIELD_LLM="azure/gpt-5.6-terra"
LYRASHIELD_LUNA_LLM="azure/gpt-5.6-luna"
LYRASHIELD_TERRA_LLM="azure/gpt-5.6-terra"
LLM_API_KEY="..."
# Do not set LYRASHIELD_IMAGE on the web or Lite Scanner Container Apps.
LYRASHIELD_ENGINE_PATH="lyrashield"
LYRASHIELD_IMAGE="ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:<published-digest>"
LYRASHIELD_ENGINE_SANDBOX_NETWORK="lyrashield-sandbox"
DOCKER_HOST="ssh://scanner@isolated-docker-host"
# For a TLS Docker API instead of SSH:
# DOCKER_HOST="tcp://isolated-docker-host:2376"
# DOCKER_TLS_VERIFY="1"
# DOCKER_CERT_PATH="/run/secrets/isolated-docker-client"
LYRASHIELD_STALE_RESOURCE_REAPER_ENABLED="1"
LYRASHIELD_STALE_RESOURCE_MIN_AGE_MINUTES="1440"
LYRASHIELD_STALE_RESOURCE_REAPER_INTERVAL_MS="900000"
PLATFORM_MAX_SCAN_BUDGET_USD="50"
LYRASHIELD_TELEMETRY="0"
LYRASHIELD_WORKER_CONCURRENCY="1"

# Web Search (Parallel Search). The Key Vault secret name is `worker-web-search-api-key`.
# run-worker.sh auto-enables to 1 when the API key is present; override with 0 to disable.
LYRASHIELD_WEB_SEARCH_ENABLED="1"
LYRASHIELD_WEB_SEARCH_API_KEY="..."
# Optional:
# LYRASHIELD_WEB_SEARCH_MODE="turbo"           # turbo | basic | advanced
# LYRASHIELD_WEB_SEARCH_MAX_RESULTS="5"        # 1-20
# LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL="4000" # 1000-20000
# LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN="50"
# LYRASHIELD_WEB_SEARCH_BUDGET_USD="1.0"       # separate web-search cap

# Optional per-request engine limits; leave unset for engine defaults.
# MAX_OUTPUT_TOKENS caps tokens generated per request (replaces the engine's
# per-scan-mode default; also tightens the budget reservation). MAX_INPUT_TOKENS
# is the compaction ceiling, not a hard reject -- crossing it compacts history
# instead of failing the scan, and the engine clamps values above the 272k
# long-context boundary. Requires an engine build with cap enforcement.
# LYRASHIELD_MAX_OUTPUT_TOKENS="4096"
# LYRASHIELD_MAX_INPUT_TOKENS="200000"

# Azure OpenAI alternative (use these OR the generic LLM_API_KEY/LLM_API_BASE)
# LYRASHIELD_LLM="azure/gpt-5.6-terra" # fallback
# LYRASHIELD_LUNA_LLM="azure/gpt-5.6-luna"
# LYRASHIELD_TERRA_LLM="azure/gpt-5.6-terra"
# AZURE_OPENAI_API_KEY="..."
# AZURE_OPENAI_ENDPOINT="https://<resource>.openai.azure.com"
# AZURE_API_VERSION="v1"

# Azure AI project / serverless alternative
# LYRASHIELD_LLM="azure_ai/gpt-5.6-terra" # fallback
# LYRASHIELD_LUNA_LLM="azure_ai/gpt-5.6-luna"
# LYRASHIELD_TERRA_LLM="azure_ai/gpt-5.6-terra"
# AZURE_AI_API_KEY="..."
# AZURE_AI_API_BASE="https://<resource>.services.ai.azure.com"
# AZURE_API_VERSION="v1"

# S3-compatible evidence storage (required before controlled scans)
S3_ENDPOINT="https://..."
S3_BUCKET="lyrashield-evidence"
S3_ACCESS_KEY="..."
S3_SECRET_KEY="..."
S3_REGION="auto"
# The deploy workflow reads the existing worker-r2-* values from Key Vault and
# copies them into app-only Container App secret references. The scanner never
# receives evidence storage credentials. Key Vault remains the shared source of
# truth for the app and worker; this sync does not rotate or rewrite it.
# Evidence envelope key (REQUIRED with the S3 block — uploads fail closed without it).
# Base64 of exactly 32 bytes. Generate ONCE and store durably before provisioning:
#   node packages/evidence-storage/scripts/generate-kek.mjs
# Losing it makes every envelope-encrypted evidence artifact unreadable.
# Provision as: GitHub secret LYRASHIELD_EVIDENCE_KEK (the deploy workflow syncs the
# app Container App secret and refuses to deploy without it) and Key Vault secret
# worker-evidence-kek (worker VM, ops/worker/refresh-secrets.sh).
LYRASHIELD_EVIDENCE_KEK="<base64 32-byte key>"
```

### Model routing, reasoning, and spend limits

The worker selects one profile before each engine subprocess:

| Product mode | Engine mode | Model variable         | Reasoning | Default cap |
| ------------ | ----------- | ---------------------- | --------- | ----------: |
| Safe         | quick       | `LYRASHIELD_LUNA_LLM`  | medium    |       $1.20 |
| Quick        | quick       | `LYRASHIELD_LUNA_LLM`  | medium    |       $1.20 |
| Standard     | standard    | `LYRASHIELD_LUNA_LLM`  | medium    |       $3.20 |
| Deep         | deep        | `LYRASHIELD_TERRA_LLM` | medium    |       $5.00 |
| Custom       | deep        | `LYRASHIELD_TERRA_LLM` | medium    |       $5.00 |

Safe and Quick are aliases of the same repository profile. The 15-minute Safe/Quick/Standard and 45-minute Deep/Custom values are dashboard estimates, not elapsed-time engine cutoffs: an advancing repository engine keeps running. The worker stops a repository engine only for user cancellation, its protected provider budget, or 20 minutes without a changing bounded `run.json` receipt. URL and API targets retain their own deterministic wall-time, request, and egress limits; they never invoke the repository AI engine and have a $0 AI budget.

The worker permanently versions the official Azure GPT-5.6 rate card in `apps/worker/src/engine/gpt56-pricing.ts` (effective 2026-08-06; USD per 1 million tokens):

| Model         | Input | Cached input read | Cache write | Output |
| ------------- | ----: | ----------------: | ----------: | -----: |
| GPT-5.6 Terra | $2.00 |             $0.20 |       $2.50 | $12.00 |
| GPT-5.6 Luna  | $0.20 |             $0.02 |       $0.25 |  $1.20 |

Source: Azure GPT-5.6 pricing in Microsoft Foundry, captured with its effective date. Cache writes are 1.25 times the uncached input rate. Requests whose prompts exceed 272,000 tokens use the official long-context multipliers of 2 times input and 1.5 times output. The parser assigns complete request entries to standard or long-context input/cache-write/cache-read/output buckets; aggregate counters that cannot identify which request crossed the boundary are not estimated locally.

`LYRASHIELD_LLM` is mandatory as the backward-compatible fallback when a routed variable is absent or empty. Azure deployment names are operator-defined: if the Azure deployment is not literally named `gpt-5.6-luna` or `gpt-5.6-terra`, put the real deployment name after `azure/` or `azure_ai/`.

A finite positive `Policy.maxBudgetUsd` can lower the default for that scan but cannot raise the profile ceiling. Zero fails closed; negative, non-finite, missing, deleted, or cross-workspace policy values cannot remove the mode cap. The worker records `engine_start` with coordinator model/reasoning and retains accounting events privately. When the engine returns usage, the ledger retains provider telemetry, actual-model per-request buckets, cache-read/cache-write counters, the official rate-card calculation, calculation method, reconciliation status, request count, and normalized token counters. A numeric internal bill is written only when that rate-card amount is fully determined and agrees with provider-reported cost when one exists. Ambiguous long-context aggregates, missing billable dimensions, and mismatches remain unpriced and explicitly unreconciled; they do not turn a valid scan result into a fake failure. It never stores prompts or raw provider request payloads, and the dashboard renders no cost, spend, cap, or accounting-event value.

These amounts are internal hard ceilings, not expected per-scan charges or user-facing prices. Engine-reported telemetry is retained for reconciliation even when it exceeds the approved ceiling; the capped internal ledger cannot be presented as the provider invoice. Reconcile it against the Azure meter during the controlled gate; Azure billing remains the final expenditure source.

A durable scan event is recorded immediately before a repository scan enters the provider-billable engine phase. Preflight work remains retryable, while recovery after that boundary fails closed instead of replaying provider work; a failed billable invocation requires an explicit new scan or retest so the queue cannot silently duplicate model spend. Deterministic SCA, secret, URL, and agent-configuration findings use the Safe profile for targeted retests; engine-only findings retain their originating review depth.

Safe/Quick/Standard are Luna-only at medium reasoning. Deep/Custom use a deterministic two-tier invocation: Terra/medium is the root coordinator and Luna/high handles child specialist work. The model cannot self-promote a child to Terra, and only the root can create or stop specialists. On a root content-filter block, the engine switches directly to the delegate model (Luna/high) without retrying Terra; if the delegate also blocks, the scan salvages partial findings and terminates with `content_filter_stopped`. On any other `ModelBehaviorError` from Terra (not just content filter), the engine also falls back to Luna/high; if the delegate also fails, partial findings are salvaged with `engine_stopped` terminal reason. Azure's `response.failed` status without content-filter context is treated as transient and retried with backoff. The worker classifies `engine_stopped` and `content_filter_stopped` scans with findings as `COMPLETED` (error category `ENGINE_STOPPED` or `CONTENT_FILTER_STOPPED`); without findings they remain `FAILED`.

Prompt caching is enabled by default only on supported GPT-5.6 routes. Stable coordinator/delegate cache keys and explicit cache breakpoints maximize repeated-prefix reuse without sharing cache identity across incompatible prompt bundles. Release evidence must retain the prompt-bundle hash and separate read/write token counters; provider records remain authoritative for billing.

Engine PRs #6, #7, and #20 are merged. The promoted engine compacts estimated input at 240k toward 180k, bounds direct dedupe input to 200 kB, limits output and agent concurrency, reserves projected spend before each request, and accounts for provider-reported cache-read tokens with dict/object usage extraction. These controls do not replace provider-meter reconciliation or prove finding quality. Engine CI now runs ruff, mypy, bandit, and the full pytest suite on every PR and push to `main`; Dependabot tracks both GitHub Actions and Python pip dependencies.

### Web Search (Parallel Search)

`ops/worker/refresh-secrets.sh` pulls the optional secret `worker-web-search-api-key` into `LYRASHIELD_WEB_SEARCH_API_KEY` at every worker start. `ops/worker/refresh-egress.sh` resolves and pins `api.parallel.ai:443` in the worker egress policy so the engine can reach Parallel Search from the deny-by-default `bridge` network.

`LYRASHIELD_WEB_SEARCH_ENABLED` defaults to `1` in `ops/worker/run-worker.sh` but requires the API key to be present in `worker.env` to do useful work. Other settings (`MODE`, `MAX_RESULTS`, `MAX_CHARS_TOTAL`, `MAX_CALLS_PER_SCAN`, `BUDGET_USD`) may be overridden in `worker-runtime.conf` or the deployment shell; see `.env.example` for the full set. The engine redacts target hostnames, secrets, and PII from the query and tracks web-search cost separately from the LLM budget. A five-minute egress refresh logs changed hostnames with IP addresses redacted. When the single-concurrency worker already owns an active scan, a changed pin retains the validated old/new firewall union and pending marker without pausing the worker or removing readiness; the next idle timer run performs the token-bound drain challenge. If work starts after the active-job preflight, that challenge still pauses claims, unregisters readiness, and waits for the in-flight job. Missing acknowledgement retains the union and old pin file. A scheduled-restart failure restores that union, cancels the drain, and fails closed so `Restart=always` starts a fresh worker. This prevents DNS pin rotation from interrupting or silently resuming provider-billable scans.

Add GitHub OAuth/App, email, notification, billing, and analytics variables only when those integrations are enabled. R2/S3 is mandatory before controlled full scans, and monitoring is mandatory before general availability. Use `.env.example` as the complete variable index, not as a production secret file.

## Verification before release

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
git diff --check
```

Then, in the target environment:

1. Run `prisma migrate deploy` for every committed migration before application processes serve traffic, then replay the complete migration directory on a fresh database and run the migration-diff gate against a fresh shadow database. Command output and the committed directory are authoritative; do not rely on copied migration counts or partial name lists. Container revision rollback never reverses a Prisma migration or application-scope secret/config change, so migrations must remain forward-only and backward-compatible with the previously running image; recovery ownership must be explicit.
2. Verify `/api/health`, `/api/ready`, `/api/ready/scans`, authentication, workspace isolation, Redis queue connectivity, and worker readiness. The scan-specific endpoint must become `503` once every worker unregisters or its five-minute lease expires, and recover only after a BullMQ-ready worker registers its lease. For a pin change, prove an already-active scan reaches its terminal state without replay; readiness must remain available while that known-active job is deferred, or fail closed if the token challenge races with a new claim, then recover only after the exact replacement registers.
3. Verify the engine version and missing-model early-exit path.
4. Run a Safe or Standard controlled scan and verify its `engine_start` event names Luna with medium reasoning, its 15-minute ceiling is recorded, and its `budget_cap` is $1.20 or $3.20 respectively (or a lower policy amount).
5. Run a founder-approved Deep controlled scan and verify its `engine_start` event names Terra with medium reasoning, delegate/child calls use Luna at high reasoning, the 45-minute ceiling is recorded, and its cap is $5 (or a lower policy amount).
6. Capture audit evidence, confirm the sandbox image digest used, reconcile provider billing with the retained usage/rate-card ledger without treating it as an invoice, and verify evidence artifacts are retrievable from the configured S3-compatible endpoint. Any placeholder or failed upload blocks the gate.
7. Exercise backup and restore on non-production data before claiming an RPO/RTO.
8. Confirm URL targets use only the pinned deterministic URL scanner. Do not re-enable the external engine for URL targets until its transport is DNS-pinned and redirect-safe.
9. Confirm GitHub callbacks can refresh only a pre-existing workspace binding. Fresh installation claims and client-authored Fix PR payloads must remain blocked until their provider-ownership and server-generated-patch gates are implemented.
10. Confirm the worker image labels record the expected app and engine revisions, the configured and running worker references are the exact digest verified by CI, and `LYRASHIELD_IMAGE` is the exact LyraShield-owned sandbox digest qualified on both architectures. Retain the prior worker digest as the rollback record. A tag, upstream image, or digest built separately from the smoke-tested candidate fails the gate.
11. Exercise the stale-resource reaper with one old stopped fixture and one active-scan fixture. Confirm only the owned stale resource is removed, cleanup results are logged, and a database ownership-read failure removes nothing.

Queue recovery is deliberately fail-closed. Workers reconcile queue/database drift unconditionally at startup under a renewable token-owned Redis lease. On five-minute ticks they reconcile when the DB has nonterminal scans, use an hourly idle backstop, and reconcile on database uncertainty. A scan left `QUEUED` for more than five minutes without a processable job becomes `FAILED` with `QUEUE_ORPHANED`; operators must not automatically requeue it because the original attempt may have crossed a paid-provider boundary.

Operational queue rules:

1. Use the authenticated scan cancellation action/API. It transitions the database scan to `CANCELLED`; the worker stops active phases and reconciliation removes a remaining non-active job.
2. Never delete BullMQ keys or jobs directly in Redis, and never change only the database row. Queue and scan state must retain one auditable lifecycle.
3. Before restarting workers, record counts for enabled schedules, non-terminal scans, and waiting/delayed/prioritized/active jobs. Investigate unexpected work before registration makes it eligible to run.
4. After restart, verify `/api/ready/scans`, worker logs, the same queue/database counts, and the absence of an unintended `engine_start` event.
5. Retry a failed/orphaned scan only through an explicit user/operator action that creates a new scan ID. Reconciliation never recreates paid work.

Alert when scan readiness remains 503 beyond the deployment window, no worker heartbeat remains, reconciliation reports drift, a queue-failure event is retained, queue depth grows without active workers, or the oldest waiting job exceeds the approved latency. A planned drain is still an admission outage when readiness is `503`: acknowledge it, bind it to the exact active scan and pin-change log, and close it only after the same image identities, healthy worker, reconciled queue/cost state, and readiness `200` are read back. Web `/api/ready` may remain healthy during a scan-service outage and must not mask this alert. Before staging the Redis/egress candidate, capture live Redis command metrics; the 30-day 324,019-to-132,495-command estimate is a model, not an acceptance result.

## Public scorecard, referral, and sharing gate

Use a founder-approved test workspace and a real eligible Standard/Deep score snapshot. Do not expose a private customer target for launch QA.

1. Publish a scorecard and verify the public page uses exactly the frozen seven-field allowlist: `grade`, `scope`, `scannedAt`, `modelVersion`, `resolvedFindings`, `releaseVerdict`, and `verdictVersion`. Confirm the page is `noindex` and links the public methodology.
2. Inspect canonical, Open Graph, and Twitter tags. Fetch both grade/fixes variants in wide (1200×630), square (1080×1080), and portrait (1080×1350) formats. Verify the SVG badge is script-free and returns `Cache-Control: no-store`.
3. Exercise native sharing where supported plus LinkedIn, X, Bluesky, WhatsApp, Reddit, email, copy, download, README badge, and Open. Each generated scorecard URL must retain `ref` and add only an allowlisted source/UTM value.
4. Open the public CTA in a fresh browser, create a new test account, and complete onboarding. Verify referral code and source survive their separate HttpOnly cookies, self/old-account attribution is rejected, and no reward is issued before the first real completed scan.
5. Verify event privacy and counting: crawler/image/badge fetches do not increment human views; same-session/day reloads deduplicate; DNT/GPC suppress client capture; stored events contain no target, repository, finding, raw IP, user-agent, or caption fields.
6. While the first share remains public, persist a newer eligible snapshot for the same target and verify the older card shows only the boolean supersession notice, never the newer grade, scan, findings, or date. Then revoke the first share and require the page, all image formats, badge, and event endpoint to return 404. Publish the newer snapshot only if an active final card is required.
7. Validate at least the major launch channels against the real HTTPS URL. Social caches are independent deployment state; use official cache refresh/debug tools when available and retain screenshots/results with the release evidence.

Monitor only coarse funnel stages: deduplicated scorecard view, share-button handoff, new-account attribution, and first-scan qualification. Do not label handoffs as impressions or conversions, and do not export referral/session identifiers to third-party analytics.

## Marketing deployment

### Marketing deployment status snapshot — 2026-07-16

The product is now live in open beta with open registration; the snapshot below records the marketing Worker state verified on that date.

- `https://lyrashieldai.com` is live on the `lyrashield-marketing` Worker. The apex and `www` custom domains are attached.
- Production D1, Rate Limit, and KV bindings are provisioned; migrations `0001`–`0003` are applied remotely; `WAITLIST_IP_SALT` is stored as a Worker secret.
- `PUBLIC_SITE_URL=https://lyrashieldai.com` and `PUBLIC_INDEXABLE=true`. The marketing, methodology, browser-local tools, and passive `/scan` surface are indexable. `/terms` remains page-scoped `noindex` and excluded from the sitemap.
- Live HTTPS, security headers, canonical/schema metadata, sitemap/robots/`llms.txt`, product-updates subscription behavior, representative Lighthouse/Brave rendering, the permanent path/query-preserving `www`-to-apex redirect, and a production browser Lite Check pass.
- Production sets `PUBLIC_SCANNER_URL`, `PUBLIC_TURNSTILE_SITE_KEY`, and `PUBLIC_ABUSE_EMAIL` together because the separately protected scanner API and monitored abuse workflow are live. Keep all three configured as one availability gate. `PUBLIC_APP_URL` is set to the authenticated app origin so marketing CTAs can link to open sign-up and sign-in.

Before deploying the Cloudflare marketing Worker:

1. Replace the D1 database ID and Rate Limit namespace placeholder in `apps/marketing/wrangler.jsonc`.
2. Apply all D1 migrations in `apps/marketing/migrations/` (including `0003_waitlist_referrals.sql`, which adds the internally named referral columns) with `wrangler d1 migrations apply` before serving traffic. The `/api/waitlist` route remains the internal backend for the optional product-updates/referral flow.
3. Set `WAITLIST_IP_SALT` with `wrangler secret put`; do not retain the example value.
4. Build with the intended public origins. `PUBLIC_INDEXABLE=true` is rejected unless `PUBLIC_SITE_URL` is public HTTPS.
5. Deploy using Astro's generated configuration:

   ```bash
   PUBLIC_SITE_URL="https://lyrashieldai.com" \
   PUBLIC_SCANNER_URL="https://scanner.example.com" \
   PUBLIC_INDEXABLE=true \
     pnpm --filter @lyrashield/marketing build
   pnpm --filter @lyrashield/marketing exec wrangler deploy --config dist/server/wrangler.json
   ```

6. On the live domain, verify optional product-updates submission, Copy/LinkedIn/X/WhatsApp referral actions, referral-count movement, canonical URL, Open Graph image, JSON-LD, `robots.txt`, sitemap, app-header links, and HTTPS redirect. Confirm no queue-position or waitlist-status copy is exposed and analytics contain only the allowlisted share channel.

## Do not claim as verified

- Docker image build or container health is not a sandbox-scan test.
- A local noindex marketing preview is not a live SEO verification.
- A locally rendered scorecard image is not proof that external social caches have fetched the current canonical asset.
- A scorecard share-button click is not a platform impression, signup, qualified referral, or customer claim.
- A green application CI run is not evidence of configured production secrets, DNS, billing, or backups.
- A database uniqueness migration passing on an empty environment is not evidence that legacy duplicate provider bindings were reconciled.
