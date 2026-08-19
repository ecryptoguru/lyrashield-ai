# LyraShield — Affiliate & Partner Dashboard: Dev-Ready Brief

Dev-ready brief for the LyraShield Developer Agent: build the custom affiliate/partner dashboard inside apps/web (Next.js App Router) with branded subdomain, referral-link + promo-code attribution, recurring-commission engine on Polar/Razorpay webhooks, fraud controls, and payout ledger. All program terms founder-confirmed 2026-08-15.

## Goal, Context & Constraints

# Affiliate & Partner Dashboard — Dev-Ready Brief

**Owner:** LyraShield Developer Agent. **Repo:** `ecryptoguru/lyrashield-ai` (monorepo, Turborepo/pnpm, Next.js App Router in `apps/web`). **Do NOT route to the Lyrafin Developer Agent.**

## Goal
Build LyraShield AI's **custom affiliate/partner system + transparent partner dashboard** inside `apps/web`, reachable in-app and via a branded subdomain. Affiliates apply, get manually approved, receive a referral link + promo code, and earn commission on the paid LyraShield products they refer — with a real-time, transparent dashboard for clicks, signups, conversions, commissions, and payouts.

## Founder-confirmed program parameters (2026-08-15/16 — do not change)
- **Custom build on our platform** (not a third-party affiliate portal). Full transparency is the point.
- **Host/URL:** in-app at **`app.lyrashieldai.com/affiliates`**; **`affiliates.lyrashieldai.com` 301-redirects** to it.
- **Commission — Cloud subscriptions:** **25% recurring for 12 months** per referred paid subscription; **30%** at **10+ active** (tier evaluated at commission-creation, prospective). Base = **net (pre-tax, after discounts)**, snapshotted per commission. Annual: 25% of the annual amount as paid.
- **Commission — Local-mode licenses (v1.1):** **20% one-time** on referred Local-license sales.
- **No commission on:** minute packs, trial signups, or self-referrals. **No lifetime deals.**
- **Attribution:** last-click first-party cookie + promo-code override; **60-day window** (config).
- **Eligibility:** application + manual approval.
- **Clawback:** reverse commission on refund/chargeback (automatic, reason-coded, >$200 manual review). **Cloud subs carry a 14-day money-back window** — refunds within it claw back commission (the 30-day hold covers it). Local licenses are no-refund → clawback only on chargeback.
- **Payouts — threshold/cadence/hold:** **$100 minimum, monthly net-30** (paid 15th), **30-day commission hold** before availability, **tax-form gate** (W-9/W-8BEN/W-8BEN-E) before payout, **new-affiliate reserve** 20–30% for the first 90 days.
- **Payout rail (final v2, 2026-08-16):** **Polar cannot pay affiliates** (collection-only). **Paying entity = the Indian company.** **RazorpayX Payouts API → Indian affiliates** (INR domestic, IMPS/UPI). **Payoneer Enterprise Mass Payouts API → global (non-India) affiliates** from the Indian entity (funded via our Indian AD bank under RBI outward-remittance; enterprise API needs partnership approval + custom quote). **RBI-native fallback: BriskPe (PA-CB I&O) / Cashfree.** **Optional at scale: Trolley** for W-8/W-9/1099/withholding automation. **No Wise** (Wise India is receive-only for business), **no PayPal**, **no Stripe Connect self-serve from India**, **no manual SWIFT** at scale. Build the payout ledger **provider-agnostic**, routing by affiliate region (India → RazorpayX; global → Payoneer). (India tax: purpose code + Form 15CA/15CB + TDS 194H 2% >₹20k/yr + GST 18% if registered + DTAA/treaty for non-residents — confirm with AD bank + tax advisor.)

## Hard constraints
- Reuse existing referral foundation — do NOT redesign: `ReferralCode`, `ReferralAttribution`, `UsageRecord` (has `idempotencyKey @unique`), `WebhookEvent` (`@@unique([provider, externalId])`) already exist in `packages/db/prisma/schema.prisma`. Build the affiliate domain alongside/around these; keep the waitlist referral ladder as a separate concern.
- Billing: **Polar (global MoR)** + **Razorpay (India)** for Cloud subscriptions; Local licenses are a one-time purchase flow (see the Local-mode brief). Commission only on **successful payment** webhook events, never on trial start or signup.
- Money in **`Decimal`**, never Float. All ids `cuid`. Idempotency everywhere (webhooks + payouts).
- **High-risk zones:** billing/commissions, referral/attribution, public score surfaces, PII. Branch + PR, verify green, merge only on explicit founder approval.
- Brand guardrails extend to affiliates (no benchmark/only-we claims, no naming the upstream engine, no FUD; money-back language only for Cloud, never Local) — surfaced in the program terms, not code.
- Affiliates never see customer PII (masked customer IDs only).

## Information Architecture & Routes

## Information architecture & routes

Serve inside `apps/web`. **Recommended:** primary surface in-app at `app.lyrashieldai.com/affiliates`, with **`affiliates.lyrashieldai.com` 301-redirecting** to it (or a middleware rewrite mapping the subdomain to the affiliate route group). Founder is flexible on URL — pick the cleanest; document the choice.

**Public (logged-out or logged-in):**
- `/affiliates` — program landing: terms, commission, how it works, apply CTA.
- `/affiliates/apply` — application form (requires a logged-in `User`): name, website/channel, audience size/type, promotion methods, payout method, tax-form status.

**Partner (approved affiliates, role-gated):**
- `/affiliates/dashboard` — KPI cards + date filter (7d/30d/90d/custom, UTC).
- `/affiliates/links` — primary referral link + create campaign/SubID link variants, copy/QR/share, promo code display, click-test tool.
- `/affiliates/activity` — tabs: Clicks / Signups / Conversions, paginated, CSV export.
- `/affiliates/commissions` — immutable ledger with status + release date.
- `/affiliates/payouts` — balances (Pending/Available/Lifetime), payout history, request button, payout-method + tax-form form.
- `/affiliates/assets` — logos, banners, screenshots, email swipes, brand guidelines.

**Admin (founder/ops, `BILLING_ADMIN`/`OWNER`):**
- `/admin/affiliates` — approval queue (approve/reject/suspend), tier override, payout approval, fraud-flag review, brand-bid/coupon monitoring notes.

**Middleware:** detect `?ref=` param or `/r/:code` path on `apps/web` → validate affiliate → record click (async, non-blocking) → set first-party cookie. Subdomain host rewrite to the affiliate route group.

## Data Model (Prisma)

## Data model (Prisma) — new affiliate domain

Add to `packages/db/prisma/schema.prisma`. Money = `Decimal @db.Decimal(19,4)`. All ids `cuid`. Reuse `User` (Better Auth) for affiliate identity; reuse `WebhookEvent` for provider idempotency.

```prisma
enum AffiliateStatus { PENDING APPROVED REJECTED SUSPENDED }
enum CommissionStatus { PENDING AVAILABLE RESERVED PAID REVERSED EXPIRED }
enum PayoutStatus { PENDING PROCESSING PAID FAILED CANCELED }

model Affiliate {
  id              String @id @default(cuid())
  userId          String @unique
  user            User @relation(fields: [userId], references: [id])
  status          AffiliateStatus @default(PENDING)
  promoCode       String? @unique
  baseRateBps     Int @default(2500)   // 25%
  tierRateBps     Int @default(3000)   // 30%
  tierThreshold   Int @default(10)     // active referrals for kicker
  activeReferrals Int @default(0)      // cached count of active referred subs
  reservePct      Int @default(25)     // new-affiliate reserve (20-30%), released after reserveUntil
  reserveUntil    DateTime?            // approvedAt + 90 days
  payoutMethod    Json?                // { type: paypal|wise|bank, details..., taxFormStatus }
  createdAt       DateTime @default(now())
  approvedAt      DateTime?
  links           AffiliateLink[]
  clicks          Click[]
  commissions     Commission[]
  payouts         Payout[]
  subscriptions   AffiliateSubscription[]
}

model AffiliateProgram {   // versioned terms, single active row for v1
  id String @id @default(cuid())
  slug String @unique @default("default")
  attributionWindowDays Int @default(60)   // confirmed 60 days
  holdDays Int @default(30)
  capMonths Int @default(12)
  baseRateBps Int @default(2500)
  tierRateBps Int @default(3000)
  tierThreshold Int @default(10)
  reservePct Int @default(25)
  reserveDays Int @default(90)
  minPayout Decimal @db.Decimal(19,4) @default(100)
  currency String @default("USD")
  active Boolean @default(true)
}

model AffiliateLink {
  id String @id @default(cuid())
  affiliateId String
  affiliate Affiliate @relation(fields: [affiliateId], references: [id])
  code String @unique           // the ref/ referral code
  campaign String?
  subid String?
  createdAt DateTime @default(now())
  clicks Click[]
  @@index([affiliateId])
}

model Click {                  // immutable, high-volume
  id String @id @default(cuid())
  linkId String
  link AffiliateLink @relation(fields: [linkId], references: [id])
  affiliateId String
  affiliate Affiliate @relation(fields: [affiliateId], references: [id])
  visitorId String?
  landingUrl String?
  referrer String?
  ipHash String?
  userAgent String?
  subid String?
  utm Json?
  clickedAt DateTime @default(now())
  @@index([affiliateId, clickedAt])
  @@index([visitorId, clickedAt])
}

model AttributionToken {       // server-side cookie key
  id String @id @default(cuid())
  tokenHash String @unique
  affiliateId String
  clickId String
  expiresAt DateTime
  consumed Boolean @default(false)
  createdAt DateTime @default(now())
}

model AffiliateSubscription {  // links a referred paid subscription to an affiliate
  id String @id @default(cuid())
  providerSubscriptionId String @unique
  provider String              // polar | razorpay
  customerId String
  affiliateId String
  affiliate Affiliate @relation(fields: [affiliateId], references: [id])
  firstPaidAt DateTime
  capEndsAt DateTime           // firstPaidAt + capMonths
  isActive Boolean @default(true)
  conversions Conversion[]
}

model Conversion {             // monetizable payment event (initial + renewals)
  id String @id @default(cuid())
  externalId String            // polar order_id / razorpay payment_id
  idempotencyKey String @unique
  subscriptionId String?
  subscription AffiliateSubscription? @relation(fields: [subscriptionId], references: [providerSubscriptionId])
  affiliateId String
  grossAmount Decimal @db.Decimal(19,4)
  commissionableAmount Decimal @db.Decimal(19,4)  // net pre-tax after discounts
  currency String @db.VarChar(3)
  method String                // link | code
  promoCode String?
  subid String?
  occurredAt DateTime
  commissions Commission[]
  @@unique([externalId, affiliateId])
  @@index([affiliateId, occurredAt])
}

model Commission {             // computed ledger entry
  id String @id @default(cuid())
  conversionId String
  conversion Conversion @relation(fields: [conversionId], references: [id])
  affiliateId String
  affiliate Affiliate @relation(fields: [affiliateId], references: [id])
  rateBps Int                  // snapshot 2500 or 3000
  amount Decimal @db.Decimal(19,4)
  currency String @db.VarChar(3)
  status CommissionStatus @default(PENDING)
  earnedAt DateTime @default(now())
  availableAt DateTime?        // earnedAt + holdDays
  reversalOfId String?
  payoutItem PayoutItem?
  @@unique([conversionId, affiliateId])
  @@index([affiliateId, status, availableAt])
}

model Payout {
  id String @id @default(cuid())
  affiliateId String
  affiliate Affiliate @relation(fields: [affiliateId], references: [id])
  amount Decimal @db.Decimal(19,4)
  currency String @db.VarChar(3)
  status PayoutStatus @default(PENDING)
  provider String?             // paypal | wise | manual
  providerPayoutId String? @unique
  idempotencyKey String @unique
  requestedAt DateTime @default(now())
  paidAt DateTime?
  failureCode String?
  items PayoutItem[]
}

model PayoutItem {
  id String @id @default(cuid())
  payoutId String
  payout Payout @relation(fields: [payoutId], references: [id])
  commissionId String @unique
  commission Commission @relation(fields: [commissionId], references: [id])
  amount Decimal @db.Decimal(19,4)
}
```

**Relation to existing models:** keep `ReferralCode`/`ReferralAttribution` for the waitlist ladder (separate domain). Provide a one-time migration note if any existing referral data must map into `AffiliateLink`. `User` needs an `affiliate Affiliate?` back-relation."}, {"name": "Attribution & Tracking Spec", "content": "## Attribution & tracking spec\n\n**Referral link formats:**\n- `https://lyrashieldai.com/r/{code}?subid={optional}&campaign={optional}`\n- Fallbacks: `https://lyrashieldai.com/?ref={code}`, `https://app.lyrashieldai.com/signup?ref={code}`\n\n**Click capture (middleware, non-blocking):** on `?ref=` or `/r/:code`:\n1. Validate `AffiliateLink.code` and `affiliate.status == APPROVED` (edge-cached lookup).\n2. Create a `Click` row (async; don't block the request).\n3. Set **first-party cookie** `__ls_aff` = random token id (DB lookup, not a JWT carrying data), `Max-Age = attributionWindowDays * 86400` (**60d = 5,184,000**), `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Domain=.lyrashieldai.com` so app + subdomain share it.\n4. Create `AttributionToken { tokenHash, affiliateId, clickId, expiresAt }`.\n5. **Last-click wins:** a new valid affiliate click overwrites the cookie.\n6. Only set the cookie after consent per the CMP; otherwise log an anonymized click (no PII) and do not attribute.\n\n**Attribution precedence (publish this exact rule):**\n1. Valid **affiliate promo code** at checkout → credits the code owner.\n2. Else valid unexpired **last-click cookie** → credits its affiliate.\n3. Else unattributed.\n\n**On signup:** resolve the cookie → token → click → affiliate; create an attribution lead record (no money). Reject self-referral (affiliate.userId == new userId) and, per policy, existing customers. Store `ruleVersion: \"v1\"` + attribution inputs for audit.\n\n**On checkout:** read cookie + promo code; resolve affiliate via the precedence rule; attach `affiliate_id`, `click_id`, `promo_code` to the Polar/Razorpay checkout metadata. **Do not create a commission here** — only on the paid webhook.\n\n**Cross-device / cookieless:** if a user signs up authenticated after a click, persist the affiliate↔user link so renewals attribute even if the cookie is gone. Pure cookieless with no promo code: log the click for analytics but mark unattributed (no commission).\n\n**Attribution test matrix (must pass):** day-1 purchase with ref → attributed; day-(window+1) purchase → expired; A then B click → B wins; A click + B code → B wins; tampered cookie → rejected; duplicate webhook → idempotent; blocked cookie + valid code → code wins; self-referral → rejected."}

## Attribution & Tracking Spec

## Attribution & tracking spec

**Referral link formats:**
- `https://lyrashieldai.com/r/{code}?subid={optional}&campaign={optional}`
- Fallbacks: `https://lyrashieldai.com/?ref={code}`, `https://app.lyrashieldai.com/signup?ref={code}`

**Click capture (middleware, non-blocking):** on `?ref=` or `/r/:code`:
1. Validate `AffiliateLink.code` and `affiliate.status == APPROVED` (edge-cached lookup).
2. Create a `Click` row (async; don't block the request).
3. Set **first-party cookie** `__ls_aff` = random token id (DB lookup, not a JWT carrying data), `Max-Age = attributionWindowDays * 86400` (30d = 2,592,000), `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Domain=.lyrashieldai.com` so app + subdomain share it.
4. Create `AttributionToken { tokenHash, affiliateId, clickId, expiresAt }`.
5. **Last-click wins:** a new valid affiliate click overwrites the cookie.
6. Only set the cookie after consent per the CMP; otherwise log an anonymized click (no PII) and do not attribute.

**Attribution precedence (publish this exact rule):**
1. Valid **affiliate promo code** at checkout → credits the code owner.
2. Else valid unexpired **last-click cookie** → credits its affiliate.
3. Else unattributed.

**On signup:** resolve the cookie → token → click → affiliate; create an attribution lead record (no money). Reject self-referral (affiliate.userId == new userId) and, per policy, existing customers. Store `ruleVersion: "v1"` + attribution inputs for audit.

**On checkout:** read cookie + promo code; resolve affiliate via the precedence rule; attach `affiliate_id`, `click_id`, `promo_code` to the Polar/Razorpay checkout metadata. **Do not create a commission here** — only on the paid webhook.

**Cross-device / cookieless:** if a user signs up authenticated after a click, persist the affiliate↔user link so renewals attribute even if the cookie is gone. Pure cookieless with no promo code: log the click for analytics but mark unattributed (no commission).

**Attribution test matrix (must pass):** day-1 purchase with ref → attributed; day-(window+1) purchase → expired; A then B click → B wins; A click + B code → B wins; tampered cookie → rejected; duplicate webhook → idempotent; blocked cookie + valid code → code wins; self-referral → rejected.

## Commission & Payout Engine

## Commission & payout engine

**Commission only on money events:**
- **Polar:** `order.paid` (initial + each successful renewal). Do NOT commission on `subscription.cycled` (fires before payment). Handle `order.refunded`/`refund.created` for clawback.
- **Razorpay:** `payment.captured` / `subscription.charged` (~order.paid); `refund.created` for clawback.

**On `order.paid` / `payment.captured` webhook (idempotent):**
1. Dedup via `WebhookEvent @@unique([provider, externalId])` (existing model) — if seen, return.
2. Resolve the customer → `AffiliateSubscription` (persisted at first conversion) or a pending attribution. No affiliate → skip commission.
3. First payment for a subscription → create `AffiliateSubscription { firstPaidAt: now, capEndsAt: now + capMonths, isActive: true }`.
4. If `now > capEndsAt` → record Conversion + Commission `amount=0, status=EXPIRED` (12-month cap reached).
5. Else compute rate: `activeReferrals >= tierThreshold ? tierRateBps(3000) : baseRateBps(2500)` (snapshot `rateBps`). Commission base = **net (pre-tax, after discounts)** — frozen definition.
6. Create `Conversion { idempotencyKey = externalId }` + `Commission { amount, status: PENDING, availableAt: now + holdDays }`. Upgrades/downgrades change future commission amounts (not retroactive).

**Clawback (refund/chargeback):** create a reversal — if the commission is still PENDING, cancel/REVERSE it; if AVAILABLE/PAID, create a negative ledger entry offset against the available balance / next payout. Reason codes: `REFUND`, `CHARGEBACK`, `SELF_REFERRAL`, `FRAUD`. Manual review for amounts > $200.

**Payout lifecycle:** `PENDING (30d hold) → AVAILABLE → RESERVED (in a payout) → PAID`; or `REVERSED`. Balances: Pending / Available / Lifetime.
- Eligibility: `available >= minPayout ($100)` AND payout method valid AND tax form complete AND no active payout lock.
- On request: transactionally `SELECT ... FOR UPDATE` eligible commissions → mark RESERVED → create `Payout` + `PayoutItem[]` → call provider with `idempotencyKey = payout.id` → mark PAID only on provider confirmation; on failure release back to AVAILABLE with `failureCode`.
- Cadence: affiliate-initiated + optional monthly auto-batch on the 15th.

**Background jobs (BullMQ — consistent with the existing worker):**
- `releaseCommissions` (hourly): PENDING where `availableAt <= now` and not refunded → AVAILABLE.
- `expireAttributionTokens`: cleanup expired tokens.
- `payoutScheduler` (monthly, 15th): build eligible payout batches.
- `reconciliationJob`: compare internal commissions/payouts vs Polar/Razorpay exports.

## Dashboard UI Spec

## Dashboard UI spec (transparent, on-platform)

Match the existing LyraShield dashboard design system (OKLCH tokens, dark mode, a11y). Real-time-ish data (cache aggregates ~5 min in Redis).

**`/affiliates/dashboard` — KPI cards + date filter:**
- Clicks (+ unique), Signups, Paid conversions, Conversion rate (conversions / unique clicks).
- Active referred customers, Attributed MRR.
- Earnings: Pending / Available / Paid / Lifetime.
- EPC (earnings per click).
- Tier progress: "N/10 active to unlock 30%."

**`/affiliates/links`:** primary referral link, create SubID/campaign variants (append-only; the promo code is immutable once set), copy/QR/share, promo code display, click-test tool.

**`/affiliates/activity`:** tabs for Clicks / Signups / Conversions, paginated, CSV export. Conversions show masked customer id (`cus_***`), plan, commissionable amount, rate snapshot, commission, status, attribution method (link/code), SubID. Refunds/cancels flagged.

**`/affiliates/commissions`:** immutable ledger — earned_at, release_at (earned + 30d), rate snapshot, amount, status, reversal references.

**`/affiliates/payouts`:** Pending / Available / Lifetime balances, payout history (id, requested, amount, method, status, provider ref, included commissions), request button (enabled at ≥$100 + valid method + tax form), payout-method + tax-form (W-9/W-8BEN) form, next payout date.

**`/affiliates/assets`:** logos, banners, screenshots, email swipes, brand guidelines; track asset → clicks.

**`/admin/affiliates` (founder/ops):** approval queue, tier override, payout approval, fraud-flag review, brand-bid/coupon monitoring notes.

**Privacy:** never show customer emails/PII — masked IDs only. Show the affiliate their own reserve/holdback status transparently (never hidden).

## Fraud Controls, Legal & Acceptance Criteria

## Fraud controls & program terms (enforce in code + surface in UI)

**Enforced in code:**
- Pay commission only on **paid invoice** (never trial start/signup).
- **Self-referral rejection** (affiliate.userId == referred userId).
- Disposable-email / proxy-VPN / device-fingerprint signals flagged on signup; rate-limit signups per IP/device.
- 30-day commission hold; **new-affiliate reserve: 20–30% of commissions held for the first 90 days** (`reservePct`/`reserveUntil` on Affiliate), released as they prove out, shown transparently.
- Automatic clawback on refund/chargeback with reason codes; manual review > $200. **Cloud 14-day money-back refunds claw back commission (the 30-day hold covers it); Local licenses are no-refund → clawback only on chargeback.**
- Refund/chargeback-rate and refund-velocity flags surface in the admin queue.

**Program terms (marketing/legal page — link from `/affiliates`):** no brand bidding (zero tolerance + mandatory negative keywords), no self-referral, no spam/cookie-stuffing/incentivized traffic, FTC/ASA disclosure required, honest-claims-only (LyraShield brand guardrails — no benchmark/only-we, no FUD; money-back language only for Cloud), correct brand usage, opt-in-only audiences (GDPR). Every affiliate deal = application + manual approval + Ankit sign-off.

## Acceptance criteria (verify before claiming done)

**Schema & attribution**
- [ ] Affiliate domain models added (money in `Decimal`, ids `cuid`); `User.affiliate` back-relation; migrations green.
- [ ] `?ref=` / `/r/:code` middleware captures clicks (async) and sets a first-party **60-day** cookie (config window), `Secure/HttpOnly/SameSite=Lax/Domain=.lyrashieldai.com`; last-click wins; promo-code override; consent-gated.
- [ ] Full attribution test matrix passes (expiry, last-click, code-override, tampered cookie, idempotent webhook, cookieless+code, self-referral reject).

**Commission & payout engine**
- [ ] Polar `order.paid` + Razorpay `payment.captured` create Conversion + PENDING Commission idempotently; 25%/30% tier snapshot on Cloud subs; 12-month cap → EXPIRED; net-base calculation frozen; **no commission on minute packs or trial signups; 20% one-time on Local-license sales**; annual Cloud plans commissioned at 25% of annual amount as paid.
- [ ] Refund/chargeback → automatic reversal/clawback with reason codes; >$200 manual review; Cloud 14-day money-back handled within the hold.
- [ ] Payout lifecycle (PENDING→AVAILABLE→RESERVED→PAID / REVERSED) with transactional reservation + idempotent provider call; **$100 min; 30-day hold; monthly net-30 batch on the 15th**; tax-form gate before payout.
- [ ] **Payout ledger is provider-agnostic**, routing by affiliate region: **India → RazorpayX Payouts API; global → Payoneer Enterprise Mass Payouts API** (from the Indian entity). **No Wise, no PayPal.** (BriskPe/Cashfree as RBI-native fallback; Trolley optional at scale for tax-form automation.)
- [ ] **New-affiliate reserve (20–30%, 90 days)** held and released correctly; visible in dashboard.
- [ ] Background jobs: releaseCommissions, expireAttributionTokens, payoutScheduler, reconciliationJob (BullMQ).

**UI**
- [ ] All partner routes render with real data (KPIs, links, activity+CSV, commissions ledger, payouts, assets); admin approval queue works; masked customer IDs only.
- [ ] `app.lyrashieldai.com/affiliates` serves the surface; `affiliates.lyrashieldai.com` 301-redirects to it.

**Quality gates**
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` green; Playwright E2E for apply → approve → link → attributed signup → paid webhook → commission → hold → payout happy path.
- [ ] No customer PII exposed to affiliates; no benchmark/only-we claims; money-back language only for Cloud.

**Dependency note:** Cloud recurring commission requires Sprint-10 Cloud billing live. Local-license one-time commission depends on the Local-mode purchase flow (Track B brief). The schema, application flow, attribution, and dashboard skeleton can be built in parallel; the paid-webhook commission paths verify once each product's billing is live. The 14-day Cloud trial means a referral's recurring commission clock starts at their **first paid invoice** (after trial converts), not at signup.

**Process:** branch + PR (never push to main), verify green, merge only on explicit founder approval. Flag plan-mapping/copy conflicts back to founder/marketing rather than guessing.
