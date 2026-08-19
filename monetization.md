# LyraShield AI — Master Business & Monetization Plan (Aug 2026)

LyraShield AI master business & monetization plan (Aug 2026): one app with Local (BYOK license) + Cloud (SaaS) modes, unified pricing, free-tools funnel, affiliate program, GTM, sequencing, unit economics, risks, and metrics — all founder-confirmed decisions synthesized for fastest path to revenue.

## Executive Summary

# LyraShield AI — Master Business & Monetization Plan (August 2026)

**The company in one sentence:** LyraShield AI is an agent-native application-security product for AI-built software, sold as **one app with two modes** — a **Local mode** (runs on the user's machine on the user's own AI — zero COGS to us) and a **Cloud mode** (hosted SaaS platform) — sharing one engine, one account, one brand.

**Current state (verified, 2026-08):** the product is Phase-1 feature-complete and in **open beta** — the Cloud dashboard is live with open registration, a production scan has run end-to-end, the engine is BYOK-capable (ChatGPT/Azure subscriptions), the CLI/MCP/GitHub-Action ship, and a content engine (161 articles + 13 /compare pages + 6 free tools + Lite Check) is live. **The one gap between us and revenue is billing.**

**The monetization strategy (all founder-confirmed):**
- **Cloud mode = SaaS subscription**, opened by a **14-day full-feature, no-card free trial**. Meter = protected targets + agent minutes.
- **Local mode = one-time 1-year license**, BYOK (ChatGPT/Azure subscriptions at launch; local models later).
- **Affiliate program** pays 25% recurring / 12 months to drive low-CAC acquisition.
- **Free tools + content + GitHub Action** are the only free surfaces — the top-of-funnel that feeds both paid modes.

**The plan optimizes for fastest path to sustainable revenue:** build Cloud billing and Local-mode packaging **in parallel** (they're independent), open the **affiliate program** once billing exists, and let the already-live free/content engine feed the funnel. No lifetime deals, no permanent free tier, no refunds — clean, margin-safe, honest.

**The single most important thing to understand:** Local mode is the **fast-cash, privacy-led, zero-COGS** product; Cloud mode is the **compounding-MRR platform**. They share an engine and an account, and Cloud sync is the bridge that upgrades a Local user into a Cloud subscriber.

## Product & Current State

## Product & what's actually built

**One app, two modes, one account.** The user picks a *mode*, not a product. Same engine, same core loop (Target → Scan → Verified Finding → Fix → Retest → Report), same login.

### Local mode (paid 1-year license, BYOK)
- Scans run **on the user's machine**; the user supplies their own AI. **Launch BYOK = ChatGPT subscription sign-in + Azure OpenAI subscription** (both already engine-supported; ChatGPT sub runs record `cost: 0`). **Local/self-hosted models are a later engine build** (the engine currently requires GPT-5.6 Terra/Luna).
- Works **fully offline**, no login required to scan. Account only needed to sync/manage the license.
- Value prop: **privacy, ownership, one honest price, no API bill.**

### Cloud mode (subscription, hosted)
- Scans run on **LyraShield compute**; full platform: dashboard, findings DB, history, team/RBAC, continuous monitoring, CI gating (GitHub Action), reports, scorecards/referrals, MCP/IDE.
- Value prop: **the platform + zero ops + team + continuous loop.**

### What's live today (the foundation we monetize)
- **Cloud app:** open registration, dashboard, findings, fix proposals, retests, reports, launch-readiness, score/scorecard/referral, MCP server, CLI (24 agents), GitHub Action (diff-aware gate, account-less).
- **Free surface:** Lite Check (`/scan`) + 6 browser-local tools (incl. AI App Security scanner) + methodology + sample report.
- **Content engine:** 161 authority articles + 13 /compare pages.
- **Engine:** GPT-5.6 Terra/Luna routing, ChatGPT-subscription auth, Docker-sandboxed, telemetry off.
- **The gap:** billing (plans, checkout, metering, gating) — Sprint 10.

## Monetization Architecture

## Monetization architecture — two modes, one account, separate purchases

**A single LyraShield account holds two independent entitlements:**
1. **`localLicense`** — the 1-year Local-mode license (seats/machines, update-eligibility window).
2. **`cloudSubscription`** — the Cloud-mode plan (tier, targets, agent-minutes).

A user can hold either, both, or neither (account exists for the trial / free-tools funnel). **No bundle at v1** (separate purchases; a bundle discount is a future lever once we know the attach rate).

### The funnel
```
Free surface (no account, no cost to us)
  Lite Check  ·  6 browser tools  ·  GitHub Action  ·  161 articles  ·  /compare
        │  (tagged: free-tools → signup → paid attribution)
        ▼
Create account  ──────────────────────────────────────────┐
        │                                                  │
   ┌────┴─────┐                                      ┌─────┴──────┐
   ▼          │                                      ▼            │
CLOUD PATH    │                                 LOCAL PATH        │
14-day full   │                                 Buy 1-yr license  │
trial (no card)│                                (BYOK, offline)    │
   │          │                                   │               │
   │ convert on limits + clock                    │               │
   ▼          │                                   ▼               │
Paid Cloud    │      cloud sync (the bridge)     Paid Local       │
subscription  │ ◄──────────────────────────────  license          │
(targets +    │   Local user wants dashboard/    │               │
agent-minutes)│   history/team/monitoring →      │               │
              │   upgrades to Cloud              │               │
```

**The bridge:** **cloud sync** — included in any Cloud sub, a **$49/yr add-on** for Local-only users. A Local user who wants the dashboard/history/team/monitoring syncs findings to the cloud, then upgrades. This is the in-product Local→Cloud conversion motion.

**Conversion levers (features + limits, per mode):**
- **Cloud:** convert at trial end / agent-minute or target cap. Stay for the platform (history, team, monitoring, CI gating).
- **Local:** convert on full scan depths, machine seats, update eligibility. Renew yearly for updates.

**Sequencing:** build **Cloud billing (Sprint 10)** and **Local-mode packaging** in **parallel** (independent builds sharing the engine); open the **affiliate program** once billing is live.

## Pricing — Cloud Mode (SaaS)

## Pricing — Cloud mode (subscription)

**Opened by a 14-day, full-feature, no-card free trial** (**100 agent-minutes**, **no Deep scans** — Standard/Quick only). Convert on the agent-minute/target limits + the trial clock; the platform features are the reason to stay.

**Self-serve tiers (Polar global MoR + Razorpay India; INR = USD × 100):**

| Tier | Monthly (USD/INR) | Annual (prepaid, USD/INR) | Targets | Agent-min/mo | Deep scans |
|---|---|---|---|---|---|
| **Starter** | $29 / ₹2,900 | **$295 / ₹29,500** (15% off) | 3 | **300** | ❌ (Standard only) |
| **Pro** | $99 / ₹9,900 | **$950 / ₹95,000** (20% off) | 10 | **1,200** | ✅ (3× meter) |
| **Team** | $299 / ₹29,900 | **$2,690 / ₹2,69,000** (25% off) | 30 | **4,000** | ✅ (3× meter) |
| **Agency / Enterprise** | **from $499 / ₹49,900** | custom | custom | custom | ✅ |

**Meter:** protected targets + **agent minutes** (active agent-loop time, published; **Deep/Custom meter at ~3×**). **Overage: $0.15/agent-min.** **Minute top-up packs (valid 12 months):** **100 min / $15 · 250 min / $30 · 500 min / $50** (volume discount). Included monthly pool doesn't roll over. Starter/Pro buy packs; Team can buy packs and/or opt into metered overage + spend limit.

**Tier feature gates (capacity + collaboration + depth, never core detection):**
- **Starter:** Standard scans (no Deep), fix PRs, basic report. *(Role: entry tier / price anchor for Pro.)*
- **Pro:** + **Deep scans**, weekly monitoring, Slack/Discord, MCP, GitHub Action.
- **Team:** + team seats, scheduled scans, Jira/Linear, shared reports.
- **Agency/Enterprise:** + multi-workspace, branded reports, client share links, priority support; SSO/SCIM/private workers/compliance (Phase 4).

**Trial abuse controls (the trial is the front door):** email verification on, **100 agent-min hard cap, no Deep scans**, small target cap, scan-frequency throttle, no auto-convert, no card required (no surprise charges).

## Pricing — Local Mode (BYOK License)

## Pricing — Local mode (one-time 1-year license)

**Model:** one-time payment, **1-year license, all updates included, perpetual fallback** (keep the last eligible build forever after the year; it never deactivates). Renewal for continued updates at a discount.

| SKU | Price | Includes |
|---|---|---|
| **Individual** | **$199 launch / $299 regular** one-time | 1-year license, up to 3 machines, all updates, perpetual fallback. Renewal **$199/yr** |
| **Team (perpetual)** | **$99/seat** one-time (min 3 seats) | 1 year updates, license manager. Renewal **$59/seat/yr** |
| **Team (subscription)** | **$149/seat/yr** annual | includes cloud sync |
| **Cloud-sync add-on** | **$49/yr** (individuals) | sync Local findings/reports to a Cloud workspace (included free in any Cloud sub) |

**Volume:** 10% off at 10+ seats. **No lifetime deal** (standing rule).

**BYOK at launch:** ChatGPT subscription sign-in + Azure OpenAI subscription — **zero LLM COGS to us**. Local/self-hosted models are a **later engine build** (not supported today).

**Why these prices:** $199–299 anchors between generic dev tools ($59–99 one-time) and the Burp Pro security anchor ($475/yr); renewal at ~33–50% off matches the dev-tool norm (JetBrains/Nova/TablePlus/BoltAI). BYOK means margin ≈ license price minus payment/distribution fees — clean, immediate cash with no COGS risk.

**Local vs Cloud positioning (never blurred):** **Local = your machine, your AI, one price. Cloud = our platform, the full loop, a subscription.**

## Affiliate & Partner Program

## Affiliate & partner program

A **custom-built, application-gated** program on our own platform (transparency is the brand), opened **once Cloud billing is live** (recurring commission needs paid subscriptions).

**Terms (founder-confirmed):**
- **Commission (Cloud subscriptions):** **25% recurring for 12 months**; **30% at 10+ active** referrals. Base = net (pre-tax, after discounts). Annual: 25% of the annual amount as paid.
- **Commission (Local licenses) — v1.1:** **20% one-time** on referred Local-license sales. **Minute packs: no commission.**
- **Attribution:** 60-day last-click cookie + promo-code override.
- **Eligibility:** application + manual approval (every deal QA + Ankit approval). No lifetime deals.
- **Dashboard:** transparent partner dashboard (clicks, signups, conversions, commissions, payouts, assets) at `app.lyrashieldai.com/affiliates` (`affiliates.lyrashieldai.com` redirects).

**Payout rail (final v2, 2026-08-16):**
- **Polar cannot pay affiliates** — it's collection-only. Payouts run on dedicated rails under our custom tracking. **Paying entity = the Indian company.**
- **India affiliates:** **RazorpayX Payouts** — INR domestic, ~₹4–9/payout, instant IMPS/UPI; pairs with our existing Razorpay billing.
- **Global (non-India) affiliates:** **Payoneer Enterprise Mass Payouts** (primary) — proven affiliate-network scale, API + webhooks, 190+ countries, recipient KYC/tax portal; funded from our Indian AD bank under RBI's outward-remittance route. **Caveat:** enterprise API access needs partnership approval; mass-payout fee is custom/not public — get a quote. **RBI-native fallback: BriskPe (PA-CB I&O)** (or Cashfree). **Optional at scale: Trolley** for W-8/W-9/1099/withholding automation.
- **Avoid:** Wise India (receive-only for business), Stripe Connect self-serve from India (not eligible), PayPal, manual SWIFT for many affiliates.
- **Threshold/cadence/hold (unchanged):** $100 min, monthly net-30, 30-day hold, tax-form gate, 20–30% new-affiliate reserve (90 days), automatic clawback on refund/chargeback (incl. the Cloud 14-day money-back).
- **India tax (confirm with AD bank + tax advisor):** purpose code for affiliate/marketing commission, Form 15CA/15CB, TDS 194H 2% >₹20k/yr/payee, GST 18% if the affiliate is GST-registered, DTAA/treaty rates for non-residents.

**Fraud controls (designed against the documented vectors):** pay only on paid invoice + activation (never signup/trial), self-referral rejection, disposable-email/proxy/device-fingerprint checks, 30-day hold + reserve, automatic clawback, zero-tolerance brand-bidding clause, FTC/ASA disclosure required, honest-claims-only (LyraShield guardrails extend to affiliates; money-back language only for Cloud).

**Influencer/creator motion:** pure affiliate for micro creators/agencies; **hybrid (small flat fee + affiliate tail)** for mid dev creators; flat-fee sponsorship + affiliate for larger dev YouTube/newsletters. Each deal individually QA + founder-approved. Local-license referrals give creators a clean one-time payout story alongside the recurring Cloud tail.

## Free Tools & Content Funnel

## Free tools & content — the top of funnel (all free, zero/low COGS)

Since there's **no free product tier**, the free surface is the entire acquisition engine. It must be instrumented to prove which surface drives revenue.

**Free surfaces (live today):**
- **Lite Check (`/scan`)** — no-signup passive outside-in check of a public URL. The primary hook.
- **6 browser-local tools** (`/tools`) — launch checklist, headers/CORS checker, secret scanner, Supabase RLS helper, JWT inspector, **AI App Security scanner**. Inputs never leave the browser.
- **GitHub Action** — account-less diff-aware CI gate (secret + risky-pattern, SARIF) running in the user's own runner. Zero our cost, lives in the dev workflow.
- **Content/SEO engine** — 161 authority articles + 13 `/compare` pages (the organic/GEO moat).
- **Methodology + sample report** — trust/turn transparency.

**Funnel mechanics:**
- Every free surface routes to **Create free account** (the trial) and, for local-curious visitors, to the **Local license**.
- **Tag the attribution:** `free-tools → signup → trial → paid` and `free-tools → Local purchase`, so we know which tool/article/comparison actually converts. (Existing waitlist/referral attribution + the affiliate system give us the plumbing.)
- The free tools give **real value but no official score / no full loop** — that boundary (already in the product) is the honest upsell: "want the verified finding → fix → retest → report loop and the dashboard? Start a trial / get Local."

**This funnel has near-zero marginal cost** (static tools, content, the user's own runner for the Action) — it's the most capital-efficient acquisition we have, and it's already built.

## GTM & Launch Sequence

## GTM & launch sequence (fastest path to revenue)

**Guiding principle:** the product is built and open; the only thing between us and revenue is **billing**. Everything sequences around removing that blocker and switching on the already-built funnel.

**Phase 0 — monetization plumbing (in parallel, independent builds):**
- **Track A:** Sprint-10 **Cloud billing** (Polar + Razorpay, plans, metering, gating, billing page, trial logic, email-verification flip). *[LyraShield Developer Agent]*
- **Track B:** **Local-mode packaging** (BYOK ChatGPT/Azure config, local UX CLI/TUI + GUI, license/activation/update server, optional cloud sync). *[LyraShield Developer Agent]*
- **Both harden the shared engine.** Neither blocks the other.

**Phase 1 — open paid Cloud:**
- Flip on the 14-day trial → paid subscriptions. The free tools + content + GitHub Action are already driving signups; now they convert.
- Run the design-partner program (internal dogfood on Lyrafin AI first, then 3–5 external) for proof + case studies.

**Phase 2 — launch Local mode (with a real launch motion):**
Local has no PLG loop (it's a paid download), so it needs a deliberate launch vehicle, not a quiet listing:
- **Show HN + Product Hunt launch** — founder-authored (per standing decision), led with the privacy/BYOK story: *"a real agentic security scanner that runs on your machine, on your own AI, for one honest price — your code never leaves your machine."*
- **A demo video / walkthrough** — install → connect ChatGPT/Azure sub → scan a real repo → a verified finding → a fix. The privacy story made concrete.
- **A "LyraShield Local vs SaaS scanners" page** on the existing `/compare` engine — captures the anti-subscription / local-first search intent.
- **Channels:** HN, r/netsec, r/webdev, dev X, security newsletters, ProductHunt — the audiences that reward local-first/BYOK/one-time-price.
- **Cloud sync bridges** Local users toward Cloud.

**Phase 3 — affiliate program + overage:**
- Open the affiliate program (beta cohort of 5–10 vetted creators → public applications). 25%/12mo drives low-CAC growth. **+ one-time % on Local license referrals (v1.1 — see Affiliate section).**
- Turn on minute packs + metered overage for expansion revenue.

**Phase 4 (later) — enterprise + marketplace:** SSO/SCIM, private workers, compliance, AWS/GCP/Azure marketplaces, annual enterprise contracts.

**Why this order:** Cloud billing unlocks recurring revenue + the affiliate program (which needs subscriptions). Local mode is independent fast cash. The funnel is already live. Parallel builds mean nothing waits.

## Unit Economics & Margins

## Feature → Agent-Minute Billing Map + Cost Analysis (correct rate card, effective 2026-08-06)

**Corrected rate card** (from `apps/worker/src/engine/gpt56-pricing.ts`, effective 2026-08-06): **Luna $0.20 in / $0.02 cached / $1.20 out; Terra $2.00 in / $0.20 cached / $12.00 out** (USD per 1M tokens).

**Planning $/agent-minute** (blended, ~30k input @70% cache + 5k output per agent-minute — a *planning estimate, not measured*): **Luna ≈ $0.008/min, Terra ≈ $0.082/min.** Terra/Luna ≈ 10×, so our 3× Deep multiplier is *conservative* (Deep is under-priced vs true cost — fine; the pool cap still bounds COGS).

### Which features are billed in agent-minutes (Cloud mode)
Agent-minutes meter **anything that runs the LLM engine**. Deterministic checks don't consume agent-minutes.

| Feature / action | Bills agent-minutes? | Meter weight |
|---|---|---|
| Engine repo scan — Safe/Quick (Release Check / Weekly Monitor) | ✅ Yes | 1× (Luna) |
| Engine repo scan — Standard (Code Review / Launch Review) | ✅ Yes | 1× (Luna) |
| Engine repo scan — Deep/Custom (Deep Security Review / pentest) | ✅ Yes | **3×** (Terra) |
| Engine retest (engine-only findings) | ✅ Yes | at originating depth |
| Fix-plan / fix generation (LLM) | ✅ Yes | 1× |
| MCP/copilot LLM actions (explain, fix-plan) | ✅ Yes | 1× |
| AI-03 LLM advisory enrichment | ✅ Yes | 1× |
| Dependency scan (SCA), Secret scan | ❌ No (deterministic) | — |
| URL / API surface scan (pinned deterministic) | ❌ No | — |
| AI App Security deterministic signals (AI-01–08) | ❌ No | — |
| `check_diff` heuristic pre-filter | ❌ No | — |
| GitHub Action diff-aware gate (user's runner) | ❌ No | — |
| **Local mode (all)** | ❌ **No** (BYOK) | — |

### Cost vs price, minus discounts (Cloud — final numbers)
Worst-case = every included agent-minute consumed on Luna (Deep bounded by the 3× pool drain). Allowances are the **final, raised** values.

| Tier | Price/mo | Incl. min | COGS/mo | Gross margin |
|---|---|---|---|---|
| Starter | $29 | 300 | $2.47 | **91.5%** |
| Pro | $99 | 1,200 | $9.86 | **90.0%** |
| Team | $299 | 4,000 | $32.88 | **89.0%** |

**Annual (after discount), monthly-equivalent margin:**
| Tier | Annual | /mo-equiv | COGS/mo | Margin |
|---|---|---|---|---|
| Starter | $295 (15% off) | $24.58 | $2.47 | 90.0% |
| Pro | $950 (20% off) | $79.17 | $9.86 | 87.5% |
| Team | $2,690 (25% off) | $224.17 | $32.88 | 85.3% |

**Discount cost:** the 15/20/25% annual discounts reduce monthly-equivalent margin by only ~1.5–3.7 points. On COGS grounds they're essentially free; their real value is retention + upfront cash. **Keep them.**

**Minute packs (final — volume-discounted):**
| Pack | Price | $/min | COGS/min | Pack COGS | Markup |
|---|---|---|---|---|---|
| 100 min | $15 | $0.150 | $0.008 | $0.82 | ~18× |
| 250 min | $30 | $0.120 | $0.008 | $2.06 | ~15× |
| 500 min | $50 | $0.100 | $0.008 | $4.11 | ~12× |

**Overage:** **$0.15/agent-min** (≈18× Luna COGS, ≈1.8× Terra COGS) — defensible, not steep.

**Local mode (BYOK):** $199/$299 individual, $99/seat team, $49 sync — **COGS ~$0** (license server + CDN + support only). Pure margin.

**Verdict:** the raised allowances trade a few margin points (95%→~90%) for meaningfully better conversion fuel, and the lowered overage/pack rates remove the "steep markup" objection. Margins remain excellent across every tier and mode.

## Risks & Mitigations

## Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **No free tier slows PLG** | Lower top-of-funnel conversion | The free tools + GitHub Action + content carry the free burden; the no-card 14-day full trial is the risk-free on-ramp; instrument the funnel to confirm it converts |
| **Trial abuse (no card)** | COGS burn | Email verification, 100 agent-min hard cap, no Deep, scan-frequency throttle, 80% warning, no auto-charge |
| **Refund abuse on Cloud (14-day window)** | Refund fraud / chargebacks | The affiliate clawback path + hold already handle it; monitor refund rate; the trial reduces "bought-blind" refunds. **Local stays no-refund** (digital goods). |
| **Local-mode support burden** (Docker/env/local issues) | Support cost eats license margin | Clean installer + diagnostics + `doctor` command; community support on Individual, priority on Team; price includes support |
| **Local models deferred** | Some BYOK buyers want local models | Launch on ChatGPT/Azure subs (supported); communicate local models as roadmap; don't overpromise scan quality on weak models |
| **License piracy / sharing** | Lost license revenue | Accept casual sharing (dev-tool norm); seat-count activation, not invasive DRM; **no-refund on Local limits refund farming** |
| **Affiliate fraud** | Direct payout loss | Pay-on-invoice + activation gate, self-referral rejection, holds + reserve, clawback, brand-bid ban, manual approval |
| **Cannibalization (Local vs Cloud)** | Local steals Cloud subs | Cloud sync is the explicit bridge; keep the full loop (CI gating, continuous monitoring, team) Cloud-only; position as modes, not rivals |
| **Engine quality claims** | Trust/compliance | No benchmark/accuracy/coverage claims until measured + founder-approved; honest evidence-state language everywhere |

## Metrics & Targets

## Metrics & targets (instrument these)

**Funnel (per free surface):**
- Free-tool/Action/content → signup rate; signup → trial-start rate; **trial → paid conversion** (the headline metric); free-tools → Local purchase.

**Cloud mode:**
- Trial→paid %, tier mix, MRR/ARR, agent minutes consumed, gross margin per scan, Free-trial→Starter→Pro→Team progression, churn, expansion (packs/overage/upgrades).

**Local mode:**
- License sales (launch vs regular), renewal rate (year 2 — the LTV test), team seat attach, cloud-sync attach rate (Local→Cloud bridge health), support tickets per license.

**Affiliate program:**
- Approved/active affiliates, clicks→signup→paid, MRR attributed, EPC, payout ratio (< target CAC, ~20–40% of LTV), refund/chargeback rate on referred customers, fraud-flag rate.

**North-star for fastest success:** **trial→paid conversion** (Cloud) and **license sales + renewal** (Local) — these two prove the two engines work.

**Targets to set with founder:** first-90-day numbers for trial→paid %, Cloud MRR, Local licenses sold, and affiliate-driven MRR once billing + Local are live.

## Decision Register

## Decision register — everything founder-confirmed (Aug 2026)

**Product structure:**
- One app, two modes (Local BYOK + Cloud SaaS), one account, separate purchases.
- No permanent free product; free lives in the web tools + GitHub Action + content.
- Pricing page: one page, Local/Cloud toggle. Local works without login. Dedicated deployment-mode schema field. No bundle at v1.

**Cloud (SaaS):**
- **Trial: 14-day, full-feature (Standard/Quick), NO card, 100 agent-min, NO Deep scans.** Convert on limits + clock.
- Tiers $29/$99/$299 + $499 contact-led; annual 15/20/25% off; INR = USD×100.
- Meter = targets + agent-minutes (active-loop time, Deep 3×). **Allowances: Starter 300 / Pro 1,200 / Team 4,000 agent-min/mo. Overage $0.15/min. Packs: 100/$15 · 250/$30 · 500/$50 (valid 6 months).** Team metered overage + spend limit.
- **Deep scans gated to Pro and above** (Starter = Standard only — Starter is the price anchor for Pro).
- Polar (global MoR) + Razorpay (India). **Refunds: 14-day money-back window on Cloud subscriptions.** EDU/OSS discounted, not free. Marketplace Phase 2. Support: community free / priority on higher tiers.

**Local (BYOK license):**
- $199 launch / $299 regular (3 machines), renewal $199/yr; team $99/seat (min 3) + $59 renewal or $149/seat/yr sub w/ sync; sync $49/yr individual add-on; 10% off 10+ seats; no lifetime deal.
- BYOK: ChatGPT subscription + Azure at launch; local models later (net-new engine work).
- License server: thin custom activation/update endpoint; offline grace; perpetual fallback; signed updates. UX: CLI/TUI (devs) + desktop GUI (vibe coders).
- **Refunds: no-refund on Local licenses** (digital goods, activated). Local mode bills zero agent-minutes; all scan depths available locally.

**Affiliate:**
- **Cloud:** 25% recurring/12mo (30% at 10+ active); 60-day last-click + promo override; net pre-tax base; annual commissioned as paid; subscriptions only (no pack commission); PayPal/Wise $100 net-30; 30-day hold; 20–30% reserve 90 days; clawback on refund/chargeback (incl. the Cloud 14-day money-back); application + approval; custom in-app dashboard.
- **Local (v1.1):** 20% one-time commission on referred Local-license sales.

**Sequencing:** Cloud billing + Local packaging in parallel; affiliate after billing; enterprise/marketplace Phase 4.

**Standing guardrails:** no LTD, no benchmark/coverage/"only-we" claims, no naming the upstream engine, no FUD, honest evidence-state language, privacy promise must be literally true. **Refund copy: the 14-day money-back applies to Cloud only — never claim it for Local.**
