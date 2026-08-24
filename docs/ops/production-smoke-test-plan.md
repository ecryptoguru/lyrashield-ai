# Production Smoke-Test Plan — Sprint-10 Three-Track Build

> **Purpose.** Validate the three Sprint-10 flows in production after
> provisioning: **Cloud billing**, **Local BYOK licensing**, and the
> **Affiliate program**. Each flow lists exact steps, pass/fail criteria, and
> the log/DB evidence to capture. The procedure originated at
> `main @ 0d61b1a6`; recorded evidence sections retain their historical
> revision. Use `PRD.md` and `AGENTS.md` for current release status.
>
> **This is a validation plan, not a change plan.** No product behavior is
> modified here. Revocation hard-stop and the flat 25% annual affiliate rate
> are resolved product rules; payout-provider activation remains an
> operational gate.

---

## 0. Preconditions — do NOT run in production until all are true

| #   | Precondition                                                                                                                             | How to verify                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Real license signing key provisioned in Azure Key Vault and `LICENSE_SIGNING_KEY_ID` set                                                 | `az keyvault secret show --vault-name lyrashieldprodsecrets --name license-signing-private-key`; Container App env has `LICENSE_SIGNING_KEY_ID` |
| 2   | Polar + Razorpay configured: explicit `POLAR_ENVIRONMENT`, complete credentials, dedicated webhook secrets, and Cloud/Local catalog maps | Deploy configuration check passes; provider dashboards show matching environment and webhooks                                                   |
| 3   | Brevo flipped in production: `BREVO_API_KEY`, `EMAIL_FROM`, `NOTIFICATION_FROM_EMAIL` set and `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=1`  | `docs/deployment/PRODUCTION_DEPLOYMENT.md` blocker #1 resolved                                                                                  |
| 4   | Runtime DB role cannot bypass RLS                                                                                                        | run `packages/db/scripts/verify-license-rls-live.sh` (see `license-rls-live-verification.md`) — **must pass 6/6 first**                         |
| 5   | `LYRASHIELD_INTERNAL_API_KEY` set on the app                                                                                             | license issue/renew routes return 403 without the header                                                                                        |
| 6   | Migrations applied through `20260819000000_sprint10_license_affiliate_indexes`                                                           | `pnpm --filter @lyrashield/db migrate:deploy` reports up to date                                                                                |
| 7   | Worker jobs scheduled: `billing-downgrade`, `billing-expire-packs`, `billing-reconciliation`, `affiliate-*`                              | worker boot log lists the repeatable jobs                                                                                                       |
| 8   | A dedicated test workspace + test founder account exist for smoke runs; never use a real customer workspace                              | —                                                                                                                                               |

**Rollback / abort (all flows).** If any step fails in a way that writes real
billing state, do not retry blindly. Abort criteria and the escape hatch per
flow are in each section. Global escape: `downgradeToFree(workspaceId)` is the
admin lever to return a workspace to a known-clean billing state; license
issues are clawed back via `POST /api/licenses/revoke`; affiliate mistakes are
undone by admin `suspend`. Capture the failing `WebhookEvent.externalId` /
`AuditLog` rows before any cleanup so reconciliation can replay them.

---

## 1. Cloud billing flow

Constants (verified in `packages/pricing/src/plans.ts`, `packs.ts`,
`packages/billing/src/trial.ts`, `grace.ts`):

- Trial: **14 days**, **100 one-time agent-minutes**, **3 targets**, no Deep,
  no card.
- Plans (monthly agent-min / target cap): TRIAL 100/3 · STARTER 300/5 ·
  PRO 1200/15 · TEAM 4000/50 · AGENCY custom. Deep allowed PRO+.
- Deep/Custom meter at **3×** (`DEEP_SCAN_MULTIPLIER = 3`).
- Overage **$0.15/min** (`STANDARD_OVERAGE_PER_MINUTE_USD = 0.15`), Team only,
  gated by a user-set spend limit.
- Minute packs: `pack_100` $15 · `pack_250` $30 · `pack_500` $50, valid
  **180 days**; draw order = monthly pool → oldest unexpired pack → overage.
- Grace cap `GRACE_CAP_MS = 900000` (15 min) per billing cycle.

### 1.1 Sign-up → 14-day trial

**Steps:** register a new account (email verification on) → create workspace →
`POST /api/billing/trial/start` `{workspaceId}`.

**Pass criteria:**

- Response `200 {started:true, trialEndsAt}`.
- DB: `Workspace.trialStartedAt` set, `plan=FREE`, `deepAllowed=false`;
  `BillingAccount` row `status=trialing`, `currentPlan=FREE`, `trialEndsAt` set.
- DB: one `UsageRecord` `kind=trial_grant`, `quantity=100`,
  `idempotencyKey="<workspaceId>:<ts>:TRIAL"`.
- Re-POST the same call → idempotent (`started:false`), no second
  `trial_grant` row.
- Attempt to start a trial for a second workspace with the same user →
  `409 TRIAL_ALREADY_USED`.

**Logs/DB to check:** `logger.info("Trial started")`; `UsageRecord` count for
the workspace = 1.

### 1.2 Metered Standard scan on trial

**Steps:** add a target → run a **Standard** scan to completion.

**Pass criteria:**

- Scan completes; a `UsageRecord` `kind=agent_minutes` row is written with
  `idempotencyKey="<workspaceId>:<scanId>:<phase>"` and quantity =
  `ceil(ms/60000)` (min 1), no 3× multiplier.
- `GET /api/billing/usage?workspaceId=` shows `poolConsumed` increased and
  `totalRemaining` decreased by the same amount.

### 1.3 Trial cap + clock

**Steps:** drive usage to 100 minutes (or seed near-cap) → attempt another
scan; separately simulate `trialStartedAt` > 14 days ago (staging DB edit or
time-travel account) → attempt a scan.

**Pass criteria:**

- Over cap → `403 NO_MINUTES_REMAINING` (trial variant message).
- Past 14 days → `assertScanAllowed` returns `TRIAL_EXPIRED`; `BillingAccount.status`
  flips to `trial_expired` (via `blockOnExpiry`); dashboard shows upgrade CTA;
  scans blocked.
- 4th target on an active trial → `TARGET_LIMIT_REACHED` ("trial allows up to
  3 targets").

### 1.4 Upgrade → checkout (monthly + annual, Polar USD + Razorpay INR)

**Steps:** from the upgrade CTA, `POST /billing/checkout` for each
combination: `{workspaceId, plan: STARTER|PRO|TEAM, interval: monthly|annual}`
via Polar (USD region) and Razorpay (INR region). Complete checkout in each
provider's **test/sandbox mode**. Live mode is read-only readiness inspection;
no real purchase is part of this gate.

**Pass criteria:**

- Checkout returns a valid Polar URL / Razorpay subscription id; `429
RATE_LIMITED` fires on rapid repeats; `503 PROVIDER_NOT_CONFIGURED` if a
  token is missing (fail-closed, not a crash).
- On `subscription.created`/`active` (Polar) or `subscription.activated`
  (Razorpay): within one transaction — `BillingAccount` upserted
  (`provider`, `externalId`, `status`, `currentPlan`, `interval`,
  `currentPeriodStart/End`), `Workspace.plan` + `deepAllowed` updated,
  `AuditLog action=billing.subscription_synced`.
- `status=active` → `UsageRecord kind=pool_grant` with
  `idempotencyKey="<ws>:<periodStart>:<plan>"`, quantity = plan minutes
  (STARTER 300 / PRO 1200 / TEAM 4000); `graceUsedMs` reset to 0.
- **Annual grants monthly, not lump-sum:** a PRO annual checkout grants
  exactly **1200** minutes, not 14400 (pinned by
  `e2e/billing/checkout-flows.spec.ts`).
- Razorpay checkout presents the payment methods and mandate limits available
  for the exact purchase and account. Record the hosted-checkout receipt; do
  not claim fixed UPI/card/netbanking routing without current provider proof.

**Logs/DB:** `WebhookEvent` row `provider=polar|razorpay`, unique
`(provider, externalId)`, `processed=true`.

### 1.5 Metered scan on paid + grace

**Steps:** on PRO, run a Standard scan; then drive balance to 0 mid-scan
(seed near-zero) and observe grace.

**Pass criteria:**

- Scan completes and meters against the pool.
- When balance hits 0 mid-scan, worker calls `enterGrace`; `Workspace.graceUsedMs`
  increments, capped at 900000; on exceeding, `AuditLog billing.grace_exceeded`
  and the scan halts (`STOPPED_BUDGET`). `getGraceState` reports
  `inGrace/usedMs/remainingMs/exceeded`.

### 1.6 Minute-pack purchase

**Steps:** `POST /api/billing/topup` `{workspaceId, pack:"pack_100"}` via
Polar and Razorpay; complete payment.

**Pass criteria:**

- Polar `order.paid` / Razorpay `payment.captured` → `MinutePack` row
  (`minutes=100`, `remainingMinutes=100`, `expiresAt ≈ now+180d`,
  `externalId=<order/payment id>`), unique `(workspaceId, externalId)`.
- Replay the same webhook → no duplicate pack (idempotent on
  `workspaceId+externalId`); `checkout-flows.spec.ts` "idempotency replay
  (100× → 1 effect)" is the reference behavior.
- Draw order: after the monthly pool is exhausted, consumption decrements
  `MinutePack.remainingMinutes` oldest-first.

### 1.7 Overage (Team)

**Steps:** on TEAM, `POST /api/billing/spend-limit` `{cents}` (e.g. 1500 =
$15), exhaust pool + packs, run a scan that spills into overage.

**Pass criteria:**

- `UsageRecord kind=overage_minutes` with
  `idempotencyKey="<ws>:<scanId>:<phase>:overage"`, debited at $0.15/min.
- When cumulative cycle overage × $0.15 reaches `spendLimitCents`, further
  scans → `403 NO_MINUTES_REMAINING` (spend-limit variant message).
- `POST /api/billing/spend-limit` on a non-TEAM plan → `403 PLAN_NOT_ELIGIBLE`.

### 1.8 Refund reversal

**Steps:** issue an approved policy-exception refund for a minute-pack order in
Polar/Razorpay sandbox; let the provider's `refund.created` webhook arrive.

**Pass criteria:**

- `MinutePack.remainingMinutes` zeroed for that `externalId`.
- `UsageRecord kind=refund_reversal` with
  `idempotencyKey="<ws>:<refundExternalId>"`.
- Replayed refund webhook → no double reversal.

### 1.9 No $ cost leakage to the dashboard

**Steps:** open the dashboard billing/usage pages and scan views as a
non-founder user.

**Pass criteria:** UI displays agent-minutes and pack balances; internal
provider cost fields (`estimatedCostCents`, `actualCostCents`,
`providerCostUsd`, `billedCostUsd` on `Scan`) are **not** rendered on any
customer-facing surface.

---

## 2. Local licensing flow

Wire format (verified in `packages/licenses/src/sign.ts`,
`e2e/licenses/license-api.spec.ts`): `activate` returns a detached blob
`<base64(canonicalJSON(payload))>.<base64(ed25519 signature)>`; payload
fields are `sku, seatCount, machineIds, updateEligibleUntil,
perpetualFallbackBuild`. `perpetualFallbackBuild` is resolved server-side
from `LICENSE_PUBLISHED_BUILD` — client-supplied `currentBuild` is ignored.

### 2.1 Purchase a Local license (Polar)

**Steps:** complete a Polar checkout for a Local SKU product (one of
`POLAR_LOCAL_PRODUCT_IDS`) in sandbox, then one live purchase.

**Pass criteria:**

- The Polar `order.paid` path (via `issueLicenseForPolarOrder()` or
  `POST /api/licenses/issue` with the internal key) creates a `License`
  (`workspaceId` possibly NULL) + `LicenseKey` (`keyHash=sha256(rawKey)`,
  `issuedByProvider="polar:<orderId>"`) via `getSystemPrisma()`.
- Replay the same order → `{alreadyIssued:true}`, no duplicate license.
- Team SKUs reject `seatCount < 3` (`validateSeatCountForSku`).

### 2.2 Desktop online activation + seat cap

**Steps:** from the desktop app, `POST /api/licenses/activate`
`{licenseKey, machineId}` for machines 1, 2, 3, then a 4th (Individual cap
= 3; Team = 1 per seat).

**Pass criteria:**

- Each new machine returns `200` with `license` + `blob`, records a
  `LicenseActivation` (`lastSeenAt`), and appends to `License.machineIds`.
- Re-activating the same machine is idempotent (no extra seat consumed).
- The 4th machine on an Individual license → `409 MACHINE_CAP_REACHED`.

### 2.3 Offline grace + revalidation

**Steps:** activate, then run the desktop app offline through its grace
window; on reconnect it calls `POST /api/licenses/verify` with the stored
license file.

**Pass criteria:**

- `verify` with a valid, unexpired license file → `valid:true,
updateEligible:true` (signature verified against the **server-side**
  public key — never a client-supplied key).
- A tampered file (modified `seatCount`/`machineIds`) →
  `signature_mismatch` (`valid:false`).
- A revoked license → `valid:false, revoked:true, reason:"LICENSE_REVOKED"`.

### 2.4 Revoke → hard-stop

**Steps:** as an OWNER, `POST /api/licenses/revoke` `{licenseId, reason}`.

**Pass criteria:**

- Atomic transaction: `License.revoked=true`, `signature/signingKeyId` set to
  `REVOKED`, a `LicenseRevocation` row written, all `LicenseActivation` rows
  deactivated, `SyncCursor` rows for the license deleted.
- Non-OWNER → `403 FORBIDDEN`; repeat revoke → `409 ALREADY_REVOKED`.
- After revocation, `verify` reports revoked and the desktop app hard-stops.

### 2.5 Wire-format round-trip with real keys

**Steps:** with the production `LICENSE_SIGNING_PRIVATE_KEY` in place,
activate a real purchased license, capture the returned `blob`, and verify
the exact received bytes locally against the production public key.

**Pass criteria:** the blob decodes to canonical JSON whose ed25519 signature
verifies with the Key Vault public key; `signingKeyId` matches
`LICENSE_SIGNING_KEY_ID`.

**Rollback / abort (Local).** `POST /api/licenses/revoke` is the escape
hatch for a mis-issued license. Note the open product-policy item — whether
revocation overrides perpetual fallback — is a **founder-pending decision**
and is deliberately not exercised here.

---

## 3. Affiliate flow

Defaults (verified in `packages/affiliate/src/program.ts`): attribution
window **60d**, hold **30d**, cap **12 months**, base **25%** (2500 bps),
tier **30%** (3000 bps) at **10+** active referred subs, reserve **25%** for
the first **90 days**, min payout **$100** (`AFFILIATE_PAYOUT_MIN_CENTS`
default 10000).

### 3.1 Apply → approve

**Steps:** sign up a creator account → `POST /affiliates/api/apply` with
`acceptTerms:true` → as admin, approve via
`POST /api/admin/affiliates/action` `{action:"approve"}`.

**Pass criteria:**

- Application writes `Affiliate.acceptedTermsAt` and
  `termsVersion="2026-08-18-v1"` (the FTC/ASA terms gate — an application
  without `acceptTerms` cannot be approved; the admin action asserts
  `acceptedTermsAt != null`).
- Admin approve requires `PERMISSIONS.affiliate.admin`.

### 3.2 Create link → click → referred signup

**Steps:** as the approved affiliate, create a link → visit `/r/:code` (or
`?ref=`) in a fresh browser → complete a referred signup.

**Pass criteria:**

- `/r/:code` records a `Click` (hashed IP/UA) and sets the `__ls_aff` cookie
  (`Path=/; Domain=.lyrashieldai.com; SameSite=Lax; HttpOnly; Secure`,
  Max-Age 5184000 = 60d) — only when consent is given (`__ls_consent`); an
  `AttributionToken` row backs the cookie (opaque UUID, SHA-256 hashed).
- Signup persists the affiliate↔user link (cross-device). A tampered/unknown
  cookie token attributes nothing.
- Self-referral (same email/user) is rejected.

### 3.3 Conversion → commission

**Steps:** the referred user completes a paid Cloud subscription checkout.

**Pass criteria:**

- On the billing `order.paid` / `subscription.*` event, a `Conversion` +
  `Commission` (`status=PENDING`, `availableAt = now + 30d`) is created at
  25% of the net (pre-tax, post-discount) base; commission on annual plans is
  recognized on the annual amount as paid.
- Attribution precedence: checkout promo code > cookie > unattributed.
- **No commission on minute packs:** a `pack_*` / `polar_pack_*` /
  `razorpay_pack_*` order is detected by `isMinutePackOrder()` and skipped
  (`skipped:"minute_pack_no_commission"`). Verify by purchasing a pack via a
  referred account and confirming **no** commission row appears.
- **Tier escalation:** at 10 active referred subscriptions the rate moves to
  30% (snapshot at commission creation, prospective).
- **12-month cap:** renewal past `capEndsAt` creates an `EXPIRED` commission
  with amount 0.

### 3.4 Reserve hold → payout eligibility → payout

**Steps:** fast-forward `availableAt` (or wait), ensure the affiliate has a
payout method + tax form on file, then `POST /affiliates/api/payouts/request`.

**Pass criteria:**

- New-affiliate reserve: 25% of commissions held for the first 90 days
  (shown transparently); released after 90 days.
- Payout eligibility requires: available balance ≥ $100, valid payout method,
  `taxFormComplete=true` (W-9 / W-8BEN(-E) globally, GSTIN or declaration for
  India), and no other payout `PENDING`/`PROCESSING`.
- Payout lifecycle: `AVAILABLE → RESERVED → PROCESSING → PAID` (or `FAILED`
  with commissions released back to `AVAILABLE`).
- Provider adapters: RazorpayX (India, `RAZORPAYX_*`), Payoneer (global,
  `PAYONEER_*`); BriskPe/Trolley are stubs pending founder decisions.

### 3.5 Clawback on refund

**Steps:** issue an approved policy-exception refund for the referred subscription.

**Pass criteria:**

- The matching `Commission` flips to `REVERSED`, amount zeroed;
  `Affiliate.activeReferrals` decremented on first-payment refunds.
- Commissions > $200 set `manualReview=true`
  (`CLAWBACK_MANUAL_REVIEW_THRESHOLD_USD`).
- Replayed refund webhook on an already-`REVERSED` commission is a no-op.

**Rollback / abort (Affiliate).** Admin `suspend` on the affiliate freezes
new commissions; a mis-approved affiliate can be suspended before any payout.
Do not run live payout providers until one sandbox payout (RazorpayX or
Payoneer test mode) has completed end-to-end.

---

## 4. Evidence to capture

For each flow above, save: the relevant `WebhookEvent` rows
(`provider, externalId, eventType, processed`), `UsageRecord` /
`MinutePack` / `BillingAccount` diffs, `AuditLog` rows, license `blob`
samples (redact the raw license key), and commission/payout rows. Attach to
the release record. Reconciliation jobs (`billing-reconciliation`,
`affiliate-reconciliation`) should report zero drift after the smoke run.

---

## 5. Sprint-10 close-out evidence (2026-08-20)

### 5.1 License signing smoke (precondition #1)

- Key Vault secrets provisioned and `lyrashield-app` identity granted
  `Key Vault Secrets User`.
- Container App env has `LICENSE_SIGNING_KEY_ID=license-key-v1`.
- Smoke: issued license `cmt0nr1a7000001hzgr13urlt` to
  `smoke-test-20260820@example.com`; verified via `POST /api/licenses/verify`.
- Result: `{ valid: true, revoked: false, updateEligible: true, sku: "individual_launch" }`.
- Smoke license deleted from DB after verification.

### 5.2 Test-account cleanup

- Deleted `devagent-v12+20260807@fusionwaveai.com` (user
  `oCADQ8yrpy9xfENVpjSAsXU5t4v2pfHJ`) and workspace
  `30e6ee21-2d50-4f1f-8a0a-9a4f3d8498a7`.
- Deleted `devagent-v10+20260801@fusionwaveai.com` (user
  `6p51yuzc8BZ3x7s2JhJTXEhARZpLTghj`) and workspace
  `5cbb394b-220c-4083-b5dc-02bd4c9fdd61`.
- Re-verification: both emails and workspace IDs no longer exist.

### 5.3 Scanner `DATABASE_URL` consistency

- Set `lyrashield-scanner` secret `db-url` to the app’s
  `database-url-restricted` connection string.
- Restarted scanner; `GET https://scanner.lyrashieldai.com/api/ready` reports
  `{ "status": "ready", "checks": { "database": true, "redis": true } }`.

### 5.4 BullMQ v6 post-deploy re-verification

- Worker image promoted from `sha256:f6cd7fe62efad996c74d720db9429c85f187180f42b8fd8d4a9c43cd2ea1415a`
  to `sha256:ab62709b9ea7b894f45c41ecdf2ea095dcfc6a48df3b436dc0065d376e85cfba`
  (main build `4dc8012`).
- Worker VM `systemctl status lyrashield-worker` is `active (running)` and logs
  show `Worker ready — processing scan jobs`.
- `GET https://app.lyrashieldai.com/api/ready/scans` reports `worker: true`.
- Initial smoke scan `cmt0okk3s000701hzkum7hozb` failed at `PREFLIGHT` with
  `Insufficient host resources for sandbox: free disk 2046MB < minimum 2048MB`.
  Root cause: the worker container's `/tmp` was a 2GB tmpfs, 2MB under the
  2048MB preflight minimum. Fixed by increasing the tmpfs to 4GB in
  `ops/worker/run-worker.sh` and restarting the worker.
- Worker VM disk cleaned: 16.68GB of old Docker images pruned, stray container
  removed, journal logs vacuumed. Host disk freed from 32G to 21G used.
- Second smoke scan `cmt0q9a28000501jnmn1t453t` against `octocat/Hello-World`
  completed successfully: `QUEUED -> PREFLIGHT (passed, 4 checks) -> RUNNING ->
COMPLETED`. Duration: 6m 20s. Model: `azure_ai/gpt-5.6-luna` at medium
  reasoning. Cost: $0.048 (26 LLM requests, 86% cache hits). 0 findings.
- Post-promotion worker logs show no `CONSUMER_WEDGED` or `read ETIMEDOUT`
  entries.

### 5.5 Marketplace re-export

- Marketplace PR opened:
  `https://github.com/ecryptoguru/lyrashield-marketplace/pull/9`
- Source PR opened to keep the export correct:
  `https://github.com/ecryptoguru/lyrashield-ai/pull/362`
- Validation: `node scripts/validate.mjs` passed (26 generated artifacts).

### 5.6 Recorded local repository gates

- At capture time, `main` was `4dc8012` (clean, no uncommitted changes). This is historical evidence, not the current repository head.
- `pnpm install --frozen-lockfile` passed.
- `pnpm typecheck` passed (34 successful tasks).
- `pnpm lint` passed (32 successful tasks).
- `pnpm format:check` passed.
- `pnpm build` passed.
- `pnpm test` passed: 222 test files passed, 1 skipped (1982 tests passed,
  16 RLS-skipped); 17 marketing test files passed (123 tests); 18 motion tests
  passed. All suites green after applying migrations to the local Docker
  Compose Postgres.

### 5.7 Brevo email configuration

- `BREVO_API_KEY` set as a Container App secret (`secretref:brevo-api-key`).
- `EMAIL_FROM` and `NOTIFICATION_FROM_EMAIL` set to
  `support@lyrashieldai.com`.
- App restarted; `/api/ready` reports `database: true, redis: true`.
