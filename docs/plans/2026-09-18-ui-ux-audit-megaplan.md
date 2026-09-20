# LyraShield AI — UI/UX Audit Megaplan

Date: September 18, 2026

Status: **in execution** (session 2, 2026-09-18). The founder authorised "fix all issues; Myra/demo
should be live and working; do what's best for UX". Waves 1, 2A–2C, 3F and part of 4 are
implemented on per-wave branches with local verification; 3D/3E are in progress. Nothing is pushed
or merged and this document still does not authorise deployment or production configuration
changes — the enablement steps live in the ledger's "Production enablement" section. Execution state
is tracked in [`2026-09-18-ui-ux-audit-ledger.md`](./2026-09-18-ui-ux-audit-ledger.md) — branches,
commit SHAs, verification results and PR status live there; this document stays a point-in-time plan
record.

## Goal

Close every verified UI/UX defect found by the September 18 production audit of `lyrashieldai.com`
and `app.lyrashieldai.com` and leave behind regression coverage that prevents the same class of
defect from returning — without weakening accessibility contracts, the design system, claim policy,
terminology, tenancy or billing behaviour.

Audit register (severity, repro, evidence paths): [`AUDIT-FINDINGS.md`](../../dogfood-output/ui-ux-audit-2026-09-18/findings/AUDIT-FINDINGS.md).
The register and this plan share the same `UF-nn` identifiers.

## Relationship to previous work

This is the final UI/UX pass after the Deep Review v13/v16/v17 UX sweeps, the post-login dashboard
UX/DX upgrade and the `e2e/visual/uxv2-baseline.spec.ts` visual baselines. Those efforts already
fixed the large structural issues (navigation reachability, terminology, failure-presentation
consolidation, mobile shell). This plan therefore contains **surgical fixes, not redesigns**: no
verified finding requires a layout rebuild.

The audit deliberately re-verified areas previous passes touched (mobile nav, empty states, failure
surfaces, tap targets) and found them sound — see "Verified NOT findings" in the register. Do not
"fix" those.

## Review snapshot

- Audit date: 2026-09-18. Environment: **production** (`lyrashieldai.com`, `app.lyrashieldai.com`).
- Local checkout for this plan: `feat/myra-support-agent` at `d4664ee8`; `origin/main` at `171e225d`.
  The working tree contains user-owned deletions (three `docs/plans/*` files) and one untracked file;
  leave them untouched. Execute fix waves from fresh branches off the approved base, not from this
  tree.
- Accounts: `ankit@fusionwaveai.com` (owner of a near-empty workspace: 1 target, 0 scans/findings)
  plus anonymous browsing. No data-rich or platform-admin login was available.
- Viewports: desktop 1440×900, tablet 768×1024, mobile 393×852 (iPhone 15 emulation). Light + dark
  on representative pages.
- Instrumentation: `agent-browser` 0.37.1 (dogfood workflow), embedded axe-core 4.12.1, console and
  uncaught-error capture, network inspection, custom layout metrics (overflow, tap targets, heading
  order, landmarks, tiny text).
- Volume: 270 page/viewport captures, 289 screenshots, 51 MB evidence under
  `dogfood-output/ui-ux-audit-2026-09-18/` (gitignored). Aggregate:
  `cross-cutting/aggregate-analysis.txt`; per-capture summaries: `<workstream>/raw/summary.jsonl`.
- Protocol: read-only. No form was submitted with valid data; nothing was created, edited, deleted,
  sent or saved.

## Executive verdict

The product is in good visual and structural health. Across 270 captures there were **no critical
layout failures, no broken navigation, no console errors on the dashboard and every one of the 241
sitemap URLs returns 200**.

The defects that matter cluster in four places:

1. **The demo journey is dead.** `/demo` renders a booking widget that cannot load times (endpoint
   404 in production), reports a misleading connection error, offers no alternative contact path and
   throws an uncaught `TurnstileError` on every load. The underlying Turnstile misconfiguration means
   no token can ever be minted, so the moment public Myra/demo is enabled, booking and assistant
   sessions break for every anonymous visitor (UF-01, UF-02).
2. **Light theme contrast** fails on three shared patterns (hero agent link 4.44:1, docs warn callout
   3.47:1, code comments 3.04:1) (UF-03).
3. **Citation rot**: OWASP ASVS is dead-linked from `/methodology` and ~15 blog posts and the
   GenAI red-teaming link is dead on `/ai-safety` (UF-04).
4. **Accessibility gaps that axe can prove**: keyboard access to the two horizontally scrolling
   marketing tables, five public/app routes missing a `<main>` landmark, one route with no `h1`,
   heading-order skips on six routes and a destructive badge at 3.87:1 (UF-05…UF-09).

Everything else is bounded polish (overflow at 8 px boundaries, tap targets, mobile table
affordances).

The dashboard deep pass (W5, 19 further findings — `findings/dashboard-secondary.md`) adds a fifth
cluster: **design-token drift and information-architecture gaps in the console**. The light theme's
primary action is royal blue `oklch(0.48 0.16 245)` instead of the documented teal, the focus ring is
cyan with no offset instead of amber, `/dashboard/projects` is unreachable from any navigation, the
mobile header labels two routes "Home", invalid ids return HTTP 200 soft 404s and several empty
states duplicate the primary CTA. None of these is a crash; together they are the difference between
a console that follows its own design system and one that only approximates it.

## Prioritization method

Priority combines user impact, reach (how many pages/users), evidence strength and fix cost:

- **P0** — blocks a core conversion or auth journey or will break one the moment a flag flips.
- **P1** — a real accessibility failure (axe-provable or AA contrast), a dead citation on a trust
  page or layout overflow that hides content on a supported viewport.
- **P2** — polish with a workaround (tap-target sizes, scroll affordances, native-validation parity).
- **P3** — record-only; revisit if measurement justifies it.

## Findings register

| ID    | Priority | Surface               | Finding                                                                             | Evidence                                                  | Decision                                           |
| ----- | -------- | --------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| UF-01 | P0       | marketing `/demo`     | Booking dead end: slots 404, misleading error, no fallback; uncaught error per load | `marketing-landing/screenshots/demo-*.png`, network trace | Fix in Wave 1 (founder decision on intended state) |
| UF-02 | P0       | marketing (Myra)      | Turnstile `size:"invisible"` invalid → token can never mint → flows fail closed     | `demo-*-errors.json`; `myra-session.ts:51,111`            | Fix in Wave 1                                      |
| UF-03 | P1       | marketing light theme | 3 contrast failures (4.44:1, 3.47:1, 3.04:1)                                        | `cross-cutting/raw/*light*-a11y.json`                     | Fix in Wave 2                                      |
| UF-04 | P1       | marketing content     | 2 dead external citations (ASVS ×16 files, GenAI red-teaming)                       | `cross-cutting/links-status.txt`                          | Fix in Wave 2                                      |
| UF-05 | P1       | marketing `/pricing`  | Scrollable comparison table not keyboard-focusable (axe serious)                    | `pricing-mobile-a11y.json`                                | Fix in Wave 2                                      |
| UF-06 | P1       | app public/affiliates | Missing `<main>` landmark + uncontained regions (5 routes)                          | `app-auth/raw/*-a11y.json`                                | Fix in Wave 3                                      |
| UF-07 | P1       | dashboard             | `/dashboard/scans/<invalid>` has no `h1`                                            | `scans-invalid-id-*-a11y.json`                            | Fix in Wave 3                                      |
| UF-08 | P1       | both                  | Heading-order skips on 6 routes                                                     | per-page `*-a11y.json`                                    | Fix in Wave 3                                      |
| UF-09 | P1       | dashboard             | Destructive badge 3.87:1 on target detail (dark)                                    | `target-detail-desktop-a11y.json`                         | Fix in Wave 3                                      |
| UF-10 | P1       | marketing docs/blog   | Code blocks overflow mobile (up to 962 px)                                          | `marketing-templates/raw/summary.jsonl`                   | Fix in Wave 2                                      |
| UF-11 | P2       | marketing home        | Lite Scan form overflows tablet by 8 px                                             | `home-tablet-metrics.json`                                | Fix in Wave 2                                      |
| UF-12 | P1       | marketing `/webmcp`   | Table overflow + not keyboard-focusable                                             | `webmcp-mobile-a11y.json`                                 | Fix in Wave 2                                      |
| UF-13 | P2       | marketing tools       | 3 tool pages overflow tablet by 8 px                                                | `marketing-templates/raw/summary.jsonl`                   | Fix in Wave 2                                      |
| UF-14 | P2       | marketing docs        | Sidebar links 31 px tall on mobile                                                  | `marketing-templates/raw/summary.jsonl`                   | Fix in Wave 2                                      |
| UF-15 | P2       | dashboard             | Mobile sheet Close control 16×16                                                    | interaction capture                                       | Fix in Wave 3                                      |
| UF-16 | P2       | app auth              | Native-only field validation (no `aria-invalid`/`aria-describedby`)                 | sign-in interaction probe                                 | Fix in Wave 4                                      |
| UF-17 | P3       | marketing             | Sub-12 px mono text (mostly intentional)                                            | `summary.jsonl` tiny-text counts                          | Review in Wave 4; likely no change                 |
| UF-18 | P3       | dashboard             | Mobile tables scroll without a hint; action columns hidden below `sm` (by design)   | `targets-mobile.png`                                      | Record-only unless a hint is cheap                 |
| UF-19 | P3       | marketing `/scan`     | `aria-label` on a role-less `div`                                                   | `scan-desktop-a11y.json`                                  | Fix opportunistically in Wave 2                    |

### Dashboard deep pass (W5) — register additions

Full repro and evidence: `findings/dashboard-secondary.md`. Coordinator re-verified the soft-404
status, the light-theme primary token, the orphaned Projects route and the mobile "Home" header.

| ID    | Priority | Surface   | Finding                                                                                      | Source                                 | Decision                      |
| ----- | -------- | --------- | -------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------- |
| UF-20 | P1       | dashboard | Invalid scan id → unstructured dead end, no `h1`, no recovery (supersedes the UF-07 summary) | `scans/[id]/page.tsx:36-45`            | Wave 3                        |
| UF-21 | P2       | dashboard | Invalid detail routes are HTTP 200 soft 404s while the copy claims 404                       | `targets/[id]`, `scans/[id]`           | Wave 3 (same change as UF-20) |
| UF-22 | P2       | dashboard | 404 card's primary CTA ejects to the marketing site; competing CTAs                          | `app/not-found.tsx`                    | Wave 3                        |
| UF-23 | P1       | dashboard | Billing `h1→h3` skip, root cause `CardTitle` default `h3` (extends UF-08)                    | `packages/ui/src/card.tsx:30`          | Wave 3                        |
| UF-24 | P2       | dashboard | Empty states duplicate the primary CTA; labels disagree                                      | `projects-client.tsx`                  | Wave 4                        |
| UF-25 | P2       | dashboard | Mobile header titles `/dashboard/agents` + `/integrations` as "Home"                         | `mobile-page-header.tsx:20-23`         | Wave 4                        |
| UF-26 | P2       | dashboard | `/dashboard/projects` orphaned; agents/integrations/launch-readiness nav-less                | `lib/nav-items.ts`                     | Wave 4 (needs IA decision)    |
| UF-27 | P1       | dashboard | 768px keeps the 288px sidebar, crushing content to 480px (root cause of tablet overflow)     | `(dashboard)/layout.tsx`               | Wave 3                        |
| UF-28 | P1       | dashboard | Targets table overflows 210–281px at tablet/mobile, inverted column priority, no scroll cue  | targets table                          | Wave 3                        |
| UF-29 | P1       | dashboard | Light-theme primary is royal blue, not the documented teal accent                            | `globals.css:15`                       | Wave 3                        |
| UF-30 | P1       | dashboard | Focus ring is cyan/0-offset, not amber/4px; nav links fall back to UA outline                | `globals.css:27,142`                   | Wave 3                        |
| UF-31 | P2       | dashboard | Sheet close control 16×16 (duplicate of UF-15)                                               | `apps/web/src/components/ui/sheet.tsx` | Wave 3                        |
| UF-32 | P3       | dashboard | GitHub icon/label 0px gap in "Connect GitHub"                                                | integrations page                      | Wave 4                        |
| UF-33 | P2       | dashboard | Literal "target(s)" placeholder in Launch Readiness copy                                     | `lib/launch-readiness.ts:498`          | Wave 4                        |
| UF-34 | P2       | dashboard | "Run a review" terminology drift (5 files)                                                   | `findings/evidence-list.tsx`           | Wave 4                        |
| UF-35 | P3       | dashboard | Scans empty state is self-referential, no inline CTA                                         | scans list                             | Wave 4                        |
| UF-36 | P3       | dashboard | Evidence Vault has zero primary actions despite an outstanding step                          | `ai-assurance/page.tsx`                | Wave 4                        |
| UF-37 | P3       | dashboard | Cancelling an inline create form drops focus to `<body>`                                     | `projects-client.tsx`                  | Wave 4                        |
| UF-38 | P3       | dashboard | Billing plan chooser shows no price/minutes                                                  | `billing-actions.tsx`                  | Wave 4 (product decision)     |

### Findings raised during fix verification (2026-09-18, session 2)

Executing Wave 1 exposed three defects that only appear once the public Myra surface is actually
enabled — the reason "make it live" was not just a flag flip. All three are fixed with regression
coverage in Wave 1; the rest are recorded for the owner of the shell.

| ID    | Priority | Surface           | Finding                                                                                                                                                                                                                                                                                                          | Decision                                |
| ----- | -------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| UF-39 | **P0**   | app CORS          | No `Access-Control-Allow-Credentials` while every marketing Myra call sends `credentials: "include"` → opaque "Failed to fetch" before the endpoint ran. Public Myra/demo could never work.                                                                                                                      | Fixed in Wave 1 + `public-cors.test.ts` |
| UF-40 | P1       | marketing Myra    | `/demo` bootstrapped the session twice; two Turnstile challenges raced one widget, one caller timed out and minted an unauthenticated session.                                                                                                                                                                   | Fixed in Wave 1 (single-flight)         |
| UF-41 | P1       | marketing Myra    | Challenge hosts were unusable (`empty:hidden` = `display:none` when empty; `offsetParent` is null inside the fixed panel), so the widget always fell back to a hidden holder.                                                                                                                                    | Fixed in Wave 1                         |
| UF-42 | P2       | dashboard Myra    | `myra-panel.tsx` still uses `md:` breakpoints; with the sidebar now collapsing below `lg` it docks a 352px column at 768px.                                                                                                                                                                                      | Open — needs an owner                   |
| UF-43 | P2       | dashboard         | `webmcp-activity-drawer.tsx:76` `md:bottom-6` overlaps the mobile bottom bar at 768px.                                                                                                                                                                                                                           | Open — needs an owner                   |
| UF-44 | P3       | marketing docs    | Docs pages exceed the viewport at 768px (`docW=800`), `.nav-card__sub` unwrapped text.                                                                                                                                                                                                                           | Open — one-line fix                     |
| UF-45 | P3       | marketing docs    | `DocsLayout.astro` duplicates the `.callout--warn` rule with higher specificity; the light-theme override reaches it via an explicit selector.                                                                                                                                                                   | Open — tidy-up                          |
| UF-46 | P3       | test suite        | Visual baselines need intentional re-rendering after the tablet-shell, table and light-primary changes (tablet ×8, mobile `targets-list`, desktop `targets-list`, plus every light-theme snapshot).                                                                                                              | Open — part of the wave PRs             |
| UF-47 | P2       | app tokens        | The amber focus ring is 1.70:1 against the **light** `--bg` (11.49:1 in dark) — below the 3:1 guidance for focus indicators; `DESIGN.md` documents one amber for both themes, so Wave 3E flagged rather than changed it.                                                                                         | Open — light-theme ring colour decision |
| UF-48 | P2       | dashboard routing | Dashboard detail routes still answer **HTTP 200** for an invalid id even though they now render the 404 card. Wave 3D proved the cause: `(dashboard)/loading.tsx` and `dashboard/loading.tsx` flush a 200 shell before the page resolves (delete them → 404; restore → 200). Public routes now return real 404s. | Open — streaming-UX decision            |

## Constraints that must remain explicit

Every fix wave must preserve these; a wave that cannot is rejected:

- **Design system** (`DESIGN.md`): dark-first tokens, single cyan accent, **no purple/violet**, mono
  labels for machine states, one primary action per surface, honest empty/negative states, no emoji.
- **Claims policy** (`docs/claims-policy.md`): no certification, compliance, guarantee, universal
  detection or robustness claims; evidence-limited wording only.
- **Terminology**: customer copy says **Scan** and **Finding** — never the noun "run" or "issue".
- **Accessibility contracts**: focus restoration on dialogs/sheets, `aria-live` status regions,
  reduced-motion honouring, visible focus rings, skip links, labelled controls.
- **Failure surfaces**: structured `OperationFailurePresentation` (cause / effect / recovery + href),
  never raw error strings.
- **Tenancy/billing/security**: no changes to RLS scopes, billing ownership, queue identity, evidence
  encryption or provider integrations. This plan touches presentation only.
- **Marketing build**: content validators (`blog:validate*`, `compare:validate`, `validate-redirects`)
  and the generated `dist/server/wrangler.json` deploy path must keep passing.
- **Visual baselines**: `e2e/visual/uxv2-baseline.spec.ts` snapshots are the regression net. Update
  them only in a dedicated commit inside the wave that intentionally changes the pixels, with the
  reason recorded in the ledger.
- Repository rules: never push to `main`; one focused branch + PR per wave; preserve unrelated work;
  add focused regression coverage for changed behaviour.

## Fix waves

Each wave = one focused branch + PR off the approved base, one verification pass, one ledger entry.
Waves are ordered so that later work rebases on earlier fixes rather than racing them.

### Wave 0 — Regression harness (no product change)

Scope: make the audit reproducible in CI before touching pixels.

- Add an audit spec (Playwright) that, for a fixed page list (marketing: `/`, `/pricing`, `/docs/*`,
  `/blog/*`, `/webmcp`, `/demo`; app: `/dashboard`, `/dashboard/targets`, `/dashboard/scans`,
  `/dashboard/findings`, `/sign-in`, `/sign-up`, `/affiliates`, `/score/methodology`), asserts at
  393/768/1440 px:
  1. no horizontal overflow (`scrollWidth ≤ clientWidth` for `documentElement` and no element
     crossing the viewport edge except declared scroll containers);
  2. axe violation budget = 0 for `wcag2a,wcag2aa` (excluding documented, justified exemptions);
  3. no uncaught JS errors.
- Add a dead-link check for page-level citations (extend `check-external-blog-links.mjs` to
  `/methodology`, `/ai-safety`, `/docs/*`).
- Freeze the current light-theme state as an explicit baseline so Wave 2's contrast work is visible.
- Verification: `pnpm --filter @lyrashield/marketing test:browser`, `pnpm test:e2e`, CI green.
- Done when: the harness fails on today's production-like build for exactly the UF-03/05/06/07/08/09
  cases (proving it detects them) and passes on a build with those fixed.

### Wave 1 — P0: demo journey + Turnstile (marketing)

Scope:

1. **UF-02** `apps/marketing/src/components/myra/myra-session.ts` — replace `size: "invisible"` with
   Turnstile's real invisibility mechanism (`appearance: "interaction-only"`, valid `size`) and fix
   the `TurnstileGlobal` type. Verify a token is actually minted and accepted by
   `/api/myra/session` and `/api/myra/identity/request` in a preview environment.
2. **UF-01** `apps/marketing/src/pages/demo.astro` — implement the founder decision:
   - if booking is paused: remove the dead widget and render an honest, structured unavailability
     surface with a working contact path (no "check your connection" language);
   - if booking is intended to work: enable the endpoint path and prove the full flow end-to-end in
     a preview environment.
3. **Founder decision required before this wave merges**: intended public Myra/demo posture.
   Record the decision in the ledger.

Verification: no uncaught errors on `/demo`; a browser test that `/demo` never shows a bare spinner
or a connection-error message; a booking attempt in preview reaches a real confirmation or a real
unavailability surface. Rollback: revert the branch (no schema, no data).

### Wave 2 — P1/P2: marketing content, contrast, keyboard access, overflow

Scope (file sets are disjoint — parallelisable, see orchestration):

- **UF-04** citations: replace the two dead URLs across `apps/marketing/src/pages/methodology.astro`,
  `apps/marketing/src/pages/ai-safety.astro` and the ~15 `src/content/blog/*.mdx` files that carry
  the ASVS link (working URLs are recorded in the register).
- **UF-03** contrast: light-theme accent text colour (hero agent link), warn-callout text token in
  `apps/marketing/src/styles/global.css` (used by `DocsLayout.astro`/`AgentSnippet.astro`) and the
  code-comment colour emitted by the build-time highlighter (inline `#6A737D` on `#24292e`; locate
  the theme used by `@astrojs/markdown-satteri`). Target ≥4.5:1 in both themes.
- **UF-05 / UF-12** keyboard access: make the `overflow-x-auto` wrappers in
  `apps/marketing/src/pages/pricing.astro:256` and `webmcp.astro:145` focusable regions with
  accessible names (mirror the dashboard's `tabindex="0"` pattern).
- **UF-10** code-block overflow: ensure docs/blog `pre` blocks scroll inside a focusable container or
  wrap below `sm`; verify at 393 px.
- **UF-11 / UF-13** tablet overflow: fix the 8 px overflows (home Lite Scan form; three tool pages'
  two-column grids at 768 px).
- **UF-14** docs sidebar tap targets: raise hit areas to ≥44 px on touch viewports.
- **UF-08 (marketing part)**: heading order on `/pricing` and `/tools/webmcp-security-checker`.
- **UF-19**: drop the role-less `aria-label` on `/scan` or give the element a role.
- **UF-17**: review sub-12 px mono text; change only where it carries content.

Verification: Wave 0 harness green for the marketing page list; `pnpm --filter @lyrashield/marketing`
lint/typecheck/test; all content validators; light+dark axe runs on home/docs/blog/pricing/webmcp;
screenshot re-capture at three viewports.

### Wave 3 — P1/P2: app + dashboard accessibility, failure surfaces and design tokens

Scope:

- **UF-06** landmarks: add `<main id="main-content">` (and correct surrounding landmarks) to the
  public/app surfaces missing it — `/affiliates`, `/reports/shared/[id]`, `/score/[slug]`,
  `/lite-check/[token]`, `/onboarding` — and contain stray content in landmarks.
- **UF-07 / UF-20 / UF-21** failure surfaces: replace the inline `!scan` branch in
  `dashboard/scans/[id]/page.tsx:36-45` with `notFound()` (or the shared
  `OperationFailurePresentation`), which fixes the missing `h1`, adds a recovery link and returns a
  real 404 status + correct document title. Apply the same treatment to the targets route so both
  error classes render identically. Verify with an authenticated `fetch` that the status is 404.
- **UF-22** `app/not-found.tsx`: make "Go to dashboard" the single primary action, drop "Go home"
  (or demote it) and add a contextual back link.
- **UF-08 / UF-23** heading order: `/dashboard/reports`, `/dashboard/findings/reports`,
  `/dashboard/billing`, `/buy/local`, `/pricing` (marketing part already in Wave 2) — fix the shared
  `CardTitle` default (`packages/ui/src/card.tsx:30`) rather than patching call sites, then re-check
  every consumer.
- **UF-27** tablet shell: raise the sidebar breakpoint to `lg` (or collapse it to a rail between
  768–1023px) in `(dashboard)/layout.tsx`; this is the root cause of UF-28 and the wrapped step
  strips.
- **UF-28** targets/products table: responsive `min-w`, correct column priority below `sm` (show
  Status, drop Domain verification) and a scroll affordance.
- **UF-29 / UF-30** design tokens: set the light `--color-primary` to the documented teal band
  (hue 175–215) with contrast-checked foreground and set `--color-ring` to amber `#f5b84b` with a
  visible offset; give sidebar/nav links the same `focus-visible` treatment. Re-check contrast for
  every primary button and the focus indicator on accent-coloured controls.
- **UF-09** destructive badge contrast on `/dashboard/targets/[id]` (shared UI token; review every
  consumer).
- **UF-15 / UF-31** sheet close control: ≥44px hit area in `apps/web/src/components/ui/sheet.tsx`.

Verification: Wave 0 harness green for the app page list; `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:e2e`; axe runs on the affected routes at three viewports; authenticated status-code checks
for the not-found routes; visual baselines updated only if pixels intentionally move (documented in
the same PR).

### Wave 4 — P2/P3: console IA, copy and validation parity

Scope:

- **UF-16** field-level validation attributes on sign-in/sign-up (`aria-invalid`, `aria-describedby`,
  message elements) without changing server behaviour.
- **UF-24** empty-state CTA duplication on `/dashboard/projects` and `/dashboard/scans?tab=monitoring`
  — one primary action per surface, unified labels.
- **UF-25** mobile page-header title resolution (`usePageTitle` prefix match) — add the missing
  routes to `NAV_TITLE_ITEMS` and/or require a segment-boundary match so unlisted sub-routes fall
  back neutrally.
- **UF-26** orphaned routes — **product decision required**: either add Projects / Launch Readiness /
  Coding Agents / Integrations to a secondary nav group (and fix the missing active-item cue) or
  remove/redirect them. Record the decision in the ledger before implementing.
- **UF-33 / UF-34 / UF-35** copy: plural-aware "target(s)" fix, "review" → "scan" terminology sweep
  (5 files) and a self-explaining Scans empty state with an inline CTA.
- **UF-36 / UF-37** Evidence Vault primary action for the outstanding step; focus restoration on
  inline create-form cancel (and consistent initial focus).
- **UF-38** billing plan chooser content — **product decision required** (prices/minutes in-app vs a
  link to pricing).
- **UF-32** GitHub icon/label gap; **UF-18** mobile table scroll affordance; **UF-17** sub-12px mono
  text review.

Verification: as Wave 3, plus manual keyboard pass on the forms and a copy review against
`lib/terminology.ts`.

### Wave 5 — Close-out

- Re-run the full audit harness on the exact merged SHA at 1440/768/393 in both themes; the register
  must reconcile to zero open P0/P1 items or carry explicit, reasoned deferrals.
- Update `AGENTS.md` "Immediate execution queue" and remove branch-only wording after merge.
- Ledger: record final SHAs, PR links and the residual P2/P3 list.

## Subagent orchestration for execution

Parallelise by **file ownership**, never by hope. One writer per file set per wave; the coordinator
reviews every PR against the register.

| Wave   | Agents (profiles)                                        | Disjoint file sets                                                                                                                                                                                                                              | Serialisation rule                                                                                                                             |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | 1 × `qa-automation-engineer`                             | `e2e/`, `apps/marketing/scripts/`                                                                                                                                                                                                               | Must land first; other waves rebase on it                                                                                                      |
| 1      | 1 × `frontend-specialist`                                | `myra-session.ts`, `demo.astro`                                                                                                                                                                                                                 | Single writer (both files interact)                                                                                                            |
| 2      | 3 × `frontend-specialist` + 1 × `seo-specialist`         | (a) content/MDX citations; (b) `styles/global.css` + highlighter theme; (c) `pricing.astro`/`webmcp.astro`/docs layout/tool pages; (d) docs sidebar                                                                                             | (b) and (c) both touch shared styles — coordinate the token change first, then the layout work; (a) is fully independent                       |
| 3      | 3 × `frontend-specialist`                                | (a) failure surfaces + not-found (`scans/[id]`, `targets/[id]`, `app/not-found.tsx`); (b) design tokens (`globals.css`) + shared `CardTitle`; (c) shell/table (`(dashboard)/layout.tsx`, targets table, `apps/web/src/components/ui/sheet.tsx`) | (b) must land first — (a) and (c) depend on the token/heading decisions; (c)'s table change must not fight (b)'s token change in the same file |
| 4      | 2 × `frontend-specialist` + 1 × `qa-automation-engineer` | (a) forms/validation; (b) console IA + copy; (c) keyboard/focus verification                                                                                                                                                                    | IA decisions (UF-26, UF-38) must be recorded in the ledger before (b) starts; (c) is read-only                                                 |
| Verify | 1 × `qa-automation-engineer` per wave                    | read-only                                                                                                                                                                                                                                       | Verification agents must not trust implementation summaries — re-run the harness and inspect screenshots                                       |

Coordinator duties (per the repo's orchestration skill): write the worker brief with exact files and
line references from the register; keep ≤4 workers per round; synthesise results; reject any PR whose
diff touches files outside its declared set; ensure the ledger is updated before the next wave starts.

## Verification protocol (every wave)

1. `pnpm lint`, `pnpm typecheck`, `pnpm format:check`.
2. `pnpm test:core`; marketing `vitest` + `blog:validate*`, `compare:validate`, `validate-redirects`.
3. `pnpm test:e2e` (grep-invert `@visual`) and `pnpm --filter @lyrashield/marketing test:browser`.
4. Wave 0 audit harness on the changed surface at 393/768/1440, light + dark.
5. `pnpm build` (web) and `pnpm --filter @lyrashield/marketing build` when the wave touches them.
6. Visual baselines: intentional updates only, in the wave's PR, with the reason in the ledger.
7. Browser re-capture on the exact SHA for the pages in the wave; attach the summary lines to the PR.

## Out of scope / not a fix

- Populated-data dashboard views, platform-admin console and real-id share surfaces — untested in
  this audit (no account); a follow-up audit is required before claiming coverage.
- OAuth provider completion, password-reset completion, account creation, purchases, settings
  mutations — excluded by the read-only protocol.
- `apps/desktop` (Tauri) and `apps/worker` — not part of this UI audit.
- Third-party vendor behaviour (LinkedIn's bot-block `999`, PostHog/Turnstile CDN internals) beyond
  the one configuration bug in UF-02.
- Any billing, tenancy, RLS, queue, evidence or provider change.

## Evidence index

| Path                                                               | Contents                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `dogfood-output/ui-ux-audit-2026-09-18/findings/AUDIT-FINDINGS.md` | Full register with repro and source traces                                                 |
| `.../cross-cutting/aggregate-analysis.txt`                         | Cross-workstream aggregation (violations, overflow, errors, tap targets)                   |
| `.../cross-cutting/links-status.txt`, `sitemap-status.txt`         | Link integrity + sitemap results                                                           |
| `.../cross-cutting/raw/*light*-a11y.json`                          | Light-theme axe results                                                                    |
| `.../<workstream>/raw/summary.jsonl`                               | Per-capture machine-readable summaries                                                     |
| `.../<workstream>/screenshots/*.png`                               | 289 captures at three viewports                                                            |
| `.../scripts/`                                                     | Audit harness (capture, metrics, summarise, aggregate) — reusable for Wave 0 and re-audits |
