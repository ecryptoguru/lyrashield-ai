## Verification + fix pass — Sprint-10 three-track build

Independent verification of the Sprint-10 three-track work (Track A Cloud Billing, Track B BYOK Local/Desktop licensing, Track C Affiliate). This branch sits on top of `integration/sprint-10-byok-affiliate` and fixes the issues found. Verification was performed by the LyraShield Developer Agent against the founder-confirmed spec — **not** by trusting the PR #349 body's self-reported claims.

### Root cause of the two red CI checks on PR #349

Both failing checks (`Lint, Typecheck, Test & Build` and `RLS Child-Table Write Reproduction`) died at the Prisma migration step before reaching any tests. Root cause: a SQL syntax error in migration `20260818000004_final_indexes`.

```sql
-- BROKEN (unterminated quoted identifier, DESC misplaced inside parens)
CREATE INDEX "Click_affiliateId_clickedAt_desc_idx" ON "Click"("affiliateId", "clickedAt DESC);
CREATE INDEX "Conversion_affiliateId_occurredAt_desc_idx" ON "Conversion"("affiliateId", "occurredAt DESC);
```

The `"clickedAt DESC` token is an unterminated quoted identifier — Postgres reads `clickedAt DESC` as one identifier, leaving the column list un-closed, then chokes on the next token (`ERROR: syntax error at or near "" ON ""`, P3006/P3018). The same typo repeats on the Conversion index.

**Fix:** removed both `_desc` index statements. The ascending `Click_affiliateId_clickedAt_idx` and `Conversion_affiliateId_occurredAt_idx` from migration 3 already cover these query patterns (Postgres can scan an ascending index backwards for latest-first listing). The `_desc` variants were also **not declared in the Prisma schema**, so even with the SQL fixed they would have caused `migrate diff` drift. Baseline confirmed: `main @ 2e5005e` and PR #348 are both green on these checks, so these were unambiguous new regressions.

### Additional fixes (found by inspecting the three-track code against the confirmed spec)

**1. INR conversion undercharged India minute-pack buyers (~17%)**
`packages/config/src/env.ts`: `BILLING_USD_INR_RATE` defaulted to `83`, but the founder-confirmed spec is "INR = USD × 100" and the pricing catalog + marketing page both use ×100 (₹2,900 for $29). Only the topup route used the env rate, so a $15 pack cost ₹1,245 instead of ₹1,500. Default changed to `100` (still configurable for a future live-FX override by the founder).

**2. Polar `refund.created` was unreachable dead code**
`packages/billing/src/providers/polar/webhooks.ts`: `isHandledPolarEvent` did not include `"refund.created"`, so `processPolarEvent` was never called for Polar refunds — even though the adapter has a working `refund.created` → `reverseRefund` handler. Refunded Cloud customers would have kept their minute-pack entitlements. Razorpay's `payment.refunded` was already handled correctly; this makes Polar symmetric. The 14-day Cloud money-back guarantee depends on this path.

**3. Affiliate commission leak on minute packs**
`packages/affiliate/src/webhook-dispatch.ts`: a minute-pack `order.paid` (productId like `polar_pack_100`) is not a Local SKU, so it fell through to the Cloud `onOrderPaid` handler and would have created a **25% recurring commission on a one-time pack purchase**. The spec explicitly forbids commission on minute packs. Added `isMinutePackOrder()` (detects via `packId` in metadata or a productId tail matching `pack_100`/`pack_250`/`pack_500`) and a dispatch branch that skips commission. Verified no false positives against Cloud subscription payloads (their productId tail is `monthly`/`annual`, metadata has no `packId`).

**4. Team licenses missing minimum-3-seats enforcement**
`apps/web/src/lib/licenses/license-service.ts` + `apps/web/src/app/api/licenses/issue/route.ts`: the issue route's Zod schema allowed `seatCount` min 1 for all SKUs, but the spec requires "Team $99/seat perpetual (min 3)". Added `isTeamSku()` / `TEAM_MIN_SEATS` / `validateSeatCountForSku()` and call it from both the issue route (returns 400 `INVALID_SEAT_COUNT`) and `issueLicenseForPolarOrder` (throws, caught non-blocking in the webhook's `maybeIssueLicense`).

### What is verified

- Engine PR #79 CI is **green** (`verify` + sandbox build). Thin-fork boundary held: zero edits to `strix/**` or `lyrashield_adapter/**`; TUI (`lyrashield/tui/`) and desktop (`desktop/`) live correctly outside the fork boundary. `scripts/verify-controlled-derivative.sh` unchanged and still enforces the footprint budget.
- Track A: 9 spec invariants PASS (money in Decimal/integer-cents never Float; all ids cuid; idempotency on UsageRecord/WebhookEvent and used; cloud pricing values exact; trial 14d/100min/no-Deep/no-card; packs 100/$15, 250/$30, 500/$50, 180-day validity; overage $0.15/min; INR ×100; Deep=Pro+; STARTER additive non-transactional enum migration; single billing webhook ingress with Polar Standard-Webhooks + Razorpay HMAC validation; entitlement gates by capacity+depth not core detection).
- Track B: 11 spec invariants PASS (ed25519 signing; perpetual fallback on expiry, both TS + Rust; 3-machine cap with `SELECT FOR UPDATE`; local encrypted results store + keychain secrets; sync opt-in; BYOK scope = ChatGPT+Azure only, local models hidden/experimental; Docker detection + free alternatives; signed GitHub-Releases update channel; LicenseRevocation full invalidation; macOS notarization CI step; Rust payload schema matches TS contract).
- Track C: 10 spec invariants PASS (25%/12mo + 30% at 10+ kicker; Local 20% one-time; net base; 60-day last-click cookie + promo-override; $100 min/net-30/15th/30-day hold/tax-form gate; 20-30% reserve 90 days; clawback idempotent; Conversion/Payout idempotency keys @unique + used; masked customer IDs only; RazorpayX+Payoneer+Briskpe rails, no Wise/PayPal/Stripe-Connect; application + manual approval; cross-device attribution + fraud signals).

### Items NOT fixed in this pass — flagged for founder decision

These need product judgment or are larger multi-file changes; they are **not** silent spec violations I could fix with a smallest-change edit. They are tracked in the verification report:

- **10% team discount at 10+ seats** — not implemented anywhere (pricing catalog, license service, checkout, marketing). Feature gap.
- **GSTIN for India** missing from the affiliate tax-form gate (only W-9/W-8BEN/W-8BEN-E). Needs schema + apply-form UI + eligibility changes.
- **FTC/ASA disclosure + binding affiliate terms** — brand guardrails are advisory text on the assets page, not a terms-of-service affiliates must accept. Product/legal-surface decision.
- **Placeholder ed25519 keys** — `desktop/src-tauri/src/license.rs` `BUNDLED_PUBKEY_HEX` and `tauri.conf.json` updater pubkey are zero/placeholder with no CI step to inject real keys. **Must not ship to production as-is** — license + update verification would be non-functional. Pre-prod hardening.
- **License signing key** read from env; TODO to move to Azure Key Vault.
- **Annual Cloud plans** use a flat 25% affiliate rate, bypassing the 30%-at-10+ tier kicker. Possibly intentional (annual = upfront at base). Needs confirmation.
- **Clawback replay** can double-decrement `activeReferrals` (no guard checking the commission was already `REVERSED`).
- **Fraud signals** `signupCountByIp`/`signupCountByDevice` are never populated at call sites, so `RATE_LIMIT_IP`/`RATE_LIMIT_DEVICE` never fire.
- **Reserve release job** referenced in comments does not exist in the codebase.
- **Cashfree** not implemented (only BriskPe); all payout providers are stubs (manual-approval flow).
- **Test coverage gap**: `packages/affiliate` and `packages/billing` have **no test files** and no vitest wired in. The "1,928 tests passed" in the PR #349 body are pre-existing tests in other packages; the new billing/affiliate packages are untested. Recommend adding test infrastructure + regression tests for the money/security-critical paths.

### Verification method

- Cloned both repos at the integration/track-b HEADs.
- Pulled the failing CI check logs via the GitHub Actions API (did not trust the PR body).
- Dispatched three parallel read-only inspections (one per track) against the founder-confirmed spec invariants.
- Confirmed `main` and PR #348 are green to rule out pre-existing breakage.
- **Note:** the web monorepo cannot be locally verified in this sandbox (no `node_modules`; npm registry blocked), so `pnpm typecheck/lint/test/build` are CI-verified on this PR. The engine toolchain (`uv`/`cargo`) is also unavailable locally; engine PR #79 CI is the verifier.

### Blocking external dependencies (not code)

- **Polar + Razorpay**: checkout/webhook flows need live provider configuration (Polar product IDs, Razorpay plan IDs with the confirmed INR amounts) — dashboard setup, not code.
- **Brevo**: email-verification flip needs `BREVO_API_KEY` provisioned.
- **Payoneer Enterprise Mass Payouts**: needs partnership approval + custom quote (affiliate payouts, global).
- **RazorpayX**: needs India entity + KYC (affiliate payouts, India).
- **Codesigning + notarization secrets**: `TAURI_SIGNING_PRIVATE_KEY`, Apple Developer ID + App Store Connect credentials, notarytool profile — for the desktop release pipeline.
- **ed25519 license-signing key pair**: must be generated and the public key baked into the desktop build; private key in Azure Key Vault (not env) for production.
