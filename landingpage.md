# LyraSec AI — Marketing Site Build Plan (Landing Page + Waitlist + Blog)

**Version:** 1.1 · 2026-07-11 (v1.1: framework pinned to Astro 7 — latest stable verified against astro.build and GitHub releases on 2026-07-11)
**Status:** Founder-approved spec, ready for implementation by a coding agent
**Derived from:** "LyraShield — Landing Page + Waitlist: Dev-Ready Brief" with the founder-authorized mechanical LyraShield→LyraSec AI substitution applied to all copy, title, meta, JSON-LD, and footer (authorized 2026-07-11). Architecture updated per founder direction: **Astro.js**, **separate Cloudflare deployment**, **detailed blog section**, **full SEO + GEO/AEO optimization**.

---

## 0. Executive summary

Build `apps/marketing` — a new Astro app inside the existing pnpm/Turborepo monorepo (`github.com/ecryptoguru/lyrasec-ai`) — deployed **separately** to Cloudflare (independent of the product app `apps/web`). It ships:

1. A single-page pre-launch **landing page** with exact, QA'd copy (7 blocks) and a working **waitlist**.
2. A **blog section** built on Astro content collections, wired for SEO from day one.
3. **Full SEO + GEO/AEO optimization**: metadata, JSON-LD, sitemap, RSS, llms.txt, answer-first content structure, robots/noindex gating until the real domain goes live.

Nothing goes public before founder approval. Preview deploys are `noindex`. Domain `lyrasecai.com` is authorized but **not yet registered** — build fully domain-agnostic.

---

## 1. Hard guardrails (read first, apply everywhere)

These are non-negotiable. Acceptance will fail on any violation.

1. **Landing copy is exact and final.** Implement the copy in §4 verbatim. Do not rewrite, "improve," shorten, or add sections. If something can't be implemented as written, flag it in the PR description — don't silently change it.
2. **Never mention "Strix"** — not in code, comments, copy, meta, commit messages, or docs. The scan engine's upstream is an internal engineering fact.
3. **No pricing numbers anywhere. No free-tier promise.** The FAQ's pricing answer is deliberately vague — keep it that way.
4. **No fake anything:** no fake logos, badges, testimonials, customer counts, "trusted by" walls, or invented metrics/benchmarks. No stock photos. Mockup visuals must read as product UI *illustration*, never passed off as live screenshots.
5. **No third-party logos** (Cursor, Claude Code, GitHub, etc.) — editor/tool names render as **plain text chips** only (no license review has happened).
6. **Naming:**
   - Public-facing product name: **LyraSec AI** (first mention per page); **LyraSec** acceptable for subsequent mentions in blog prose. In the exact landing copy of §4, use the strings exactly as written there.
   - © line: `© {currentYear} LyraSec AI · Building in public` — never invent a company legal name.
   - **Do NOT rename** code-internal `@lyrashield/*` package scopes or `LYRASHIELD_*` env vars anywhere in the repo. The **new** marketing package follows the existing scope convention: `@lyrashield/marketing` (internal name only; never rendered to users). Flag, don't fix, any old-name occurrences you notice elsewhere.
7. **Domain-agnostic build:** no hardcoded absolute URLs anywhere. All canonical/OG/sitemap/RSS URLs derive from a single `PUBLIC_SITE_URL` env var. X/Twitter link from `PUBLIC_X_URL`, and the link is **hidden entirely when unset** (handle not registered yet).
8. **No public claims** beyond the copy: no benchmark numbers, no accuracy percentages, no "only tool that…" claims.
9. **Git workflow:** feature branch + PR against `main` on `ecryptoguru/lyrasec-ai`. Never push to main. No changes to `apps/web`, `apps/worker`, `apps/agent`, or `packages/*` except the minimal root wiring listed in §2.4.
10. **Blog content:** this plan ships blog *infrastructure* plus placeholder/sample content clearly marked `draft: true`. Real posts are authored by marketing and approved by the founder — do not publish (i.e., un-draft) any post in this build.

---

## 2. Architecture & repo placement

### 2.1 Where it lives

```
apps/marketing/            ← NEW Astro app (this build)
apps/web/                  ← Next.js product app (DO NOT TOUCH)
apps/worker/               ← scan worker (DO NOT TOUCH)
apps/agent/                ← (DO NOT TOUCH)
packages/*                 ← shared packages (DO NOT TOUCH)
```

Monorepo facts (verified against the repo, commit `86eb5d5`):
- Package manager: **pnpm 11.6.0**, workspace globs `apps/*` + `packages/*` (new app is picked up automatically — no `pnpm-workspace.yaml` change needed).
- Build orchestration: **Turborepo 2.10.x** (`turbo dev/build/lint/typecheck`). The new app must expose matching scripts so `turbo build` etc. just work.
- Node `>=20`. Prettier + `prettier-plugin-tailwindcss` at root. ESLint 9 flat config at root.
- The product app uses **Tailwind CSS v4** (`@tailwindcss/postcss`) — the marketing app should also use Tailwind v4 (via `@tailwindcss/vite`) for consistency.

### 2.2 Stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | **Astro 7.x** — pin `astro@^7.0.7` (latest stable 7.0.7, released 2026-07-08; verified against github.com/withastro/astro/releases and astro.build/blog/astro-7) | Static-first; islands only where needed (waitlist form, FAQ accordion can be plain `<details>` — see §4.6). Scaffold with `pnpm create astro@latest` (create-astro 5.2.x), minimal template. See §2.5 for v7-specific gotchas. |
| Rendering | Static prerender for all pages; **server endpoints** for `/api/waitlist` | Astro `output: 'static'` + `prerender = false` on the endpoint, running on the Cloudflare adapter |
| Adapter/host | `@astrojs/cloudflare@^14` (14.1.2 current) → **Cloudflare Workers** (static assets + Worker for the API route) | Deployed **separately** from the product app; own `wrangler.jsonc` in `apps/marketing`. v14 loads `vars` from Wrangler config so `astro:env`/`PUBLIC_*` vars resolve at build time. |
| Styling | Tailwind CSS v4 | Design tokens in §5 as CSS custom properties |
| Content | Astro **Content Collections** (+ `@astrojs/mdx`) for the blog | Zod-validated frontmatter schema in §8 |
| Integrations | `@astrojs/sitemap`, `@astrojs/rss`, `@astrojs/mdx` | |
| Fonts | Self-hosted via `@fontsource-variable/inter` (UI) + `@fontsource-variable/jetbrains-mono` (code/terminal) | No Google Fonts CDN calls — performance + privacy |
| Waitlist storage | **Cloudflare D1** (recommended — see §6.2 for rationale + Postgres alternative) | |
| Validation | `zod` (already a repo convention) | |
| Analytics | PostHog JS, env-gated (see §7) | |

### 2.3 `apps/marketing` package.json (shape)

```jsonc
{
  "name": "@lyrashield/marketing",   // internal scope convention — never user-visible
  "private": true,
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "lint": "eslint src --max-warnings 0",
    "typecheck": "astro check",
    "deploy": "wrangler deploy",           // prod (gated — see §9)
    "deploy:preview": "wrangler versions upload"
  }
}
```

### 2.4 Root wiring (the ONLY changes outside `apps/marketing`)

- `turbo.json`: add `astro check` outputs if needed; ensure `build` task covers the new app (default `turbo build` already will via workspace glob — verify).
- Root `README`/`NEXT-STEPS.md`: one-line mention of the new app (optional; keep diff minimal).
- Nothing else. No dependency bumps in other packages.

### 2.5 Astro 7 specifics & gotchas (READ before scaffolding)

Astro 7.0 (June 2026) is a major release on **Vite 8 + Rolldown** with a new **Rust compiler**. Facts verified from the official release post and the v7 upgrade guide (`docs.astro.build/en/guides/upgrade-to/v7/`):

1. **Rust compiler is stricter.** Unclosed non-void HTML/component tags are now **build errors**, and semantically invalid HTML is no longer auto-corrected — markup passes through as-is. Write valid, explicitly-closed markup everywhere.
2. **Whitespace: `compressHTML` now defaults to `'jsx'`** — whitespace between elements is collapsed using JSX rules. If inline-element spacing looks wrong (e.g. links running into text), fix the markup rather than fighting the compiler; only change `compressHTML` as a last resort and note it in the PR.
3. **Markdown/MDX runs on Sätteri**, Astro's native Rust pipeline — `@astrojs/markdown-remark` is no longer installed by default and classic remark/rehype plugins are not assumed. Consequences for this build:
   - **Reading time:** do NOT use the old remark-reading-time recipe. Compute it with a small util (word count on the post's raw body via `post.body`) at render time.
   - **Syntax highlighting:** use Astro's built-in code highlighting config; verify the dark theme via current v7 docs rather than assuming Shiki config shapes from older majors.
   - If any remark/rehype plugin seems necessary, check the v7 docs for the pluggable Markdown processor API first, and flag the dependency in the PR.
4. **`src/fetch.ts` is a RESERVED filename** (Advanced Routing entrypoint). Never create a `src/fetch.ts` util module. We do not need Advanced Routing for this site.
5. **Route caching / CDN cache providers** are stable/experimental in v7 — not needed for a fully prerendered site; do not enable.
6. **Vite 8 / Rolldown:** no custom Vite plugins planned, so no action; if one sneaks in, confirm Rolldown compatibility.
7. **Structured JSON logging + background dev server** exist for AI-agent workflows (`logger` config, agent detection) — optional, may help the implementing agent during dev; not part of the deliverable.
8. **Integration versions:** use the verified matrix below (checked against the npm registry on 2026-07-11). `pnpm astro add` should resolve the same or newer — never copy version numbers from pre-v7 tutorials. Upgrades later via `npx @astrojs/upgrade`. Note in particular that **`@astrojs/mdx` v7 declares a peer dependency on `@astrojs/markdown-satteri`** — install it alongside (or let `astro add mdx` handle it); a missing-peer warning here is a real error, not noise.
9. **Config shapes change across majors** (content collections config location, fonts API, env handling): treat **docs.astro.build (v7)** as the source of truth during implementation, not blog posts or older-major tutorials. Astro's native Fonts API may be used instead of fontsource if it is stable in v7 — implementer's choice, note it in the PR.

10. **React: intentionally NOT used.** The only interactive pieces (waitlist form, FAQ analytics hook) are a small vanilla-TS `<script>` and native `<details>` — shipping a React runtime for that would cost the Lighthouse budget for zero benefit. Do not add a UI framework for this site. *Escape hatch if a future feature genuinely needs it:* `@astrojs/react@6.0.1` was released alongside Astro 7 (peers `react ^17 || ^18 || ^19`; current React is 19.2.7) — verified compatible, but its use requires a flagged justification in the PR.

**Verified dependency matrix (npm registry, 2026-07-11) — all Astro 7 / Vite 8 compatible:**

| Package | Verified latest | Astro 7 compatibility evidence |
|---|---|---|
| `astro` | 7.0.7 | — (the framework itself) |
| `@astrojs/mdx` | **7.0.2** | peer `astro: ^7.0.0`; **also peers `@astrojs/markdown-satteri ^0.3.1`** (Sätteri pipeline) — must be present |
| `@astrojs/sitemap` | 3.7.3 | no restrictive astro peer — compatible |
| `@astrojs/rss` | 4.0.19 | no restrictive astro peer — compatible |
| `@astrojs/cloudflare` | 14.1.2 | peer `astro: ^7.0.0`, peer `wrangler: ^4.83.0`; ships `vite ^8.0.13` |
| `@astrojs/check` | 0.9.9 | peer `typescript ^5 \|\| ^6` (repo uses TS 6 — fine) |
| `wrangler` | 4.110.0 | satisfies the adapter's `^4.83.0` peer |
| `tailwindcss` + `@tailwindcss/vite` | 4.3.2 | `@tailwindcss/vite` peers `vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8` → Vite 8/Rolldown OK |
| `zod` | 4.4.3 | runtime-agnostic; matches repo convention (`zod ^4`) |
| `posthog-js` | 1.399.1 | browser lib, framework-agnostic |
| `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono` | 5.2.8 | static font assets, framework-agnostic |

Pin these as minimums (`^`), run `pnpm install` from the repo root (pnpm 11 workspace), and treat any peer-dependency warning involving `astro` or `vite` as a blocker to resolve, not suppress.

### 2.6 Directory layout

```
apps/marketing/
  astro.config.mjs
  wrangler.jsonc
  tsconfig.json
  package.json
  public/
    favicon.svg
    og/og-default.png          ← 1200×630 placeholder slot (marketing supplies final)
  src/
    styles/global.css          ← Tailwind v4 + design tokens
    layouts/
      Base.astro               ← <head>, meta, JSON-LD slots, analytics, skip-link
      BlogPost.astro
    components/
      landing/ Hero.astro, Problem.astro, Loop.astro, WhereYouWork.astro,
               TwoDepths.astro, Faq.astro, FinalCta.astro
      WaitlistForm.astro       ← island (small vanilla-TS script, no framework needed)
      Footer.astro, Header.astro (minimal), SeoHead.astro, JsonLd.astro
    content/
      blog/                    ← MDX posts (sample posts draft:true)
      authors/                 ← author entries (YAML/JSON collection)
    content.config.ts
    pages/
      index.astro
      blog/index.astro
      blog/[...page].astro     ← pagination
      blog/[slug].astro
      blog/tags/[tag].astro
      rss.xml.ts
      robots.txt.ts            ← env-gated (see §9.3)
      llms.txt.ts              ← GEO (see §10.4)
      api/waitlist.ts          ← POST endpoint (prerender = false)
      404.astro
  migrations/                  ← D1 SQL migrations (0001_waitlist.sql)
```

---

## 3. Environment variables (all of them)

| Var | Scope | Purpose |
|---|---|---|
| `PUBLIC_SITE_URL` | build | Canonical origin, e.g. `https://lyrasecai.com`. Preview: the workers.dev URL. **Never hardcode.** |
| `PUBLIC_X_URL` | build | X/Twitter profile URL. **Unset ⇒ link not rendered at all.** |
| `PUBLIC_INDEXABLE` | build | `"true"` ONLY on the real production domain after founder go-live. Anything else ⇒ `noindex` + disallow robots (§9.3). |
| `PUBLIC_POSTHOG_KEY` | build | Analytics key. **Unset ⇒ zero analytics code executes** (§7). |
| `PUBLIC_POSTHOG_HOST` | build | Default `https://eu.i.posthog.com` (or chosen host). |
| `WAITLIST_IP_SALT` | Worker secret | Salt for `ip_hash` (§6.3). Random 32+ chars. |
| D1 binding `DB` | wrangler | Waitlist database (§6.2). |
| Rate-limit binding `WAITLIST_RL` | wrangler | Cloudflare Workers rate-limiting binding (§6.5). |

Add an `apps/marketing/.env.example` documenting all `PUBLIC_*` vars. Do not touch the root `.env.example`.

---

## 4. Landing page — structure & EXACT copy

Single page at `/`, 7 blocks in order. **Copy below is final** (LyraSec AI substitution already applied — do not re-substitute or edit). One `<h1>` on the page; heading levels exactly as marked.

### 4.1 Block 1 — HERO

- Badge (small, above H1): `Early access — pre-launch`
- **H1:** `Secure AI-built apps before they ship.`
- Sub: `AI wrote your code in minutes. LyraSec AI finds the vulnerabilities it shipped with, verifies they're real, opens the fix PR, and retests until they're gone. One loop, from vibe-coded to verified.`
- CTA primary: `Join the waitlist` → scrolls to the waitlist form (block 7)
- CTA secondary: `See how the loop works ↓` → anchor `#how-it-works`
- Trust line (small, under CTAs): `No spam. One email when your invite is ready.`
- Visual: terminal/IDE-style product illustration — **labeled placeholder slot** (marketing supplies the asset). Style it as an obvious illustration frame (e.g. terminal chrome with `product illustration` caption); never fake a live screenshot.

### 4.2 Block 2 — THE PROBLEM

- **H2:** `AI writes code faster than anyone reviews it.`
- Body: `Copilots and coding agents ship features in minutes, and quietly ship the classic mistakes with them: SSRF checks that string-match instead of resolving DNS, role matrices that exist but never get enforced, secrets that land in commits. Not exotic zero-days. The ordinary bugs attackers look for first, produced at machine speed.`
- Body 2: `Traditional scanners weren't built for this loop. They run after the fact, flood you with unverified findings, and speak a language only security teams read.`

### 4.3 Block 3 — THE LOOP (anchor: `#how-it-works`)

- **H2:** `One loop: scan → verify → fix → retest.`
- 5 numbered steps (icon + title + one-liner):
  1. `Point it at a target.` / `A repo, a PR diff, or a running app.`
  2. `It scans like an attacker.` / `An AI security agent probes your app the way a pentester would, not just pattern-matching your source.`
  3. `Findings are verified, not guessed.` / `A finding only reaches you when it can be demonstrated, with the evidence attached.`
  4. `It opens the fix PR.` / `Plain-language explanation, exact diff, your review.`
  5. `It retests.` / `The loop isn't done until the vulnerability is provably gone, with a report you can share.`

### 4.4 Block 4 — WHERE YOU WORK

- **H2:** `Security inside the AI coding loop, not after it.`
- Body: `LyraSec AI plugs into Cursor, Claude Code, Windsurf, Codex, and OpenCode over MCP. Check a diff before you merge. Scan a PR from your editor. Ask why a finding matters and get an answer written for your level, from "explain like I'm new to this" to full CWE/OWASP detail.`
- Visual: row of editor names as **plain text chips** (no third-party logos).

### 4.5 Block 5 — TWO DEPTHS (two columns)

- **H2:** `Built for how you ship.`
- Col A title: `Shipping your first AI-built app?` / body: `Plain-language findings, one-click fix PRs, no security background needed.`
- Col B title: `Running an engineering org?` / body: `Pre-merge gates, role-based access, audit logs, and reports your security team will actually accept. On the enterprise roadmap: SSO/SCIM, policy engine, private workers.`

### 4.6 Block 6 — FAQ (accordion, 4 items)

Use native `<details>/<summary>` (zero JS, accessible, works with reduced motion) with a small enhancement script only for the `faq_open` analytics event.

1. `Is this live today?` → `We're pre-launch, building in the open. The waitlist gets first invites and early design-partner access.`
2. `Another scanner that cries wolf?` → `The core design rule: a finding must be verified before it reaches you. If it can't be demonstrated, it doesn't ping you.`
3. `Does it replace my existing tools?` → `No. LyraSec AI is one loop for AI-built code, from scan to verified fix. Many teams will run it alongside their existing SAST and SCA.`
4. `What does it cost?` → `Pricing lands with early access.` *(Deliberately no free-tier promise — do not add one.)*

### 4.7 Block 7 — FINAL CTA + FOOTER

- **H2:** `Be first in the loop.`
- Waitlist form (spec §6) — this is the single form instance the hero CTA scrolls to.
- Footer: `© {currentYear} LyraSec AI · Building in public` + X link (`PUBLIC_X_URL`, hidden entirely if unset). Footer also links `/blog` and `/rss.xml`.

---

## 5. Design direction & tokens

**Register:** dark-mode developer aesthetic — a serious engineering tool, not a security vendor. Terminal-adjacent: near-black canvas, ONE restrained accent, monospace for code/terminal fragments, clean grotesk for UI text. High contrast, generous spacing, zero clutter.

**Tokens** (CSS custom properties in `global.css`; dev may fine-tune shades but keep the family):

```css
:root {
  --bg: #0a0c0e;            /* near-black canvas */
  --bg-raised: #101418;
  --border: #1d232a;
  --text: #e6e9ec;          /* AA on --bg */
  --text-muted: #8a949e;    /* AA-large on --bg; check usage */
  --accent: #2dd4a7;        /* green-cyan family — THE one accent */
  --accent-dim: #17453a;
  --danger: #e5534b;        /* sparing, e.g. "vulnerability" markers in illustration */
  --font-ui: 'Inter Variable', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono Variable', ui-monospace, monospace;
}
```

**Explicitly banned:** glowing padlocks, hoodie hackers, matrix rain, shield clip-art, circuit-board textures, stock photos, fake dashboard screenshots presented as real.

**Motion:** subtle only — scroll-reveal on the 5 loop steps is enough. Respect `prefers-reduced-motion` (disable reveals entirely). No parallax, no animated backgrounds. Performance budget beats animation.

**Accessibility (hard requirements):** WCAG AA contrast throughout; full keyboard navigation; visible focus states (`:focus-visible` ring in `--accent`); semantic landmarks (`header/main/footer/nav`); skip-to-content link; form inputs with real `<label>`s; accordion via `<details>`; `aria-live="polite"` on the form status region.

---

## 6. Waitlist — form, storage, API

### 6.1 Form fields (exactly three — every extra field costs signups)

| Field | Type | Rules |
|---|---|---|
| `email` | required | client + server validation |
| `role` | optional `<select>` | options exactly: `Indie builder` / `Startup CTO⁄eng lead` / `Security engineer` / `Agency⁄dev shop` / `Other` |
| `building` | optional, one line | label `What are you building?`, placeholder `e.g. a Next.js SaaS, mostly AI-generated` |

Hidden inputs populated client-side: `utmSource`, `utmMedium`, `utmCampaign` (from URL params, persisted in `sessionStorage` so they survive scroll/navigation), `referrer` (`document.referrer`), `source` (constant `landing`).

Plus a honeypot field (e.g. `website`, visually hidden, must be empty) — cheap bot filter.

**Success state (inline, replaces form):**
- `You're on the list. One email when your invite is ready.`
- Secondary line: `Building in public on X in the meantime.` — the "on X" fragment links via `PUBLIC_X_URL`; when unset, render the line **without** a link (or drop the line — dev's pick, flag in PR).

**Privacy line under the form:** `We store your email to send exactly one invite notification. No sharing, no marketing blasts.` (A full privacy page is out of scope for v1 — already flagged to founder.)

**Error states:** invalid email → inline error near the field; rate-limited → friendly message (`Too many attempts — try again in a minute.`); server error → generic retry message. Never leak whether an email already exists.

### 6.2 Storage — Cloudflare D1 (recommended)

**Recommendation: D1** (SQLite at the edge), because the marketing site deploys standalone on Cloudflare, the product Postgres has **no production host yet** (open item), and coupling the public landing page to unlaunched product infra adds risk for zero benefit. D1 is SQL, exportable (`wrangler d1 export`), and trivially migrated into the product Postgres later.

**Alternative (flag in PR if chosen instead):** shared Postgres via Prisma driver adapter + Hyperdrive — only sensible once the product DB is actually hosted. The original brief assumed this; the founder's "separate Cloudflare deployment" direction supersedes it. Design the table to mirror the brief's Prisma model so a later `WaitlistSignup` migration is a straight copy.

`migrations/0001_waitlist.sql`:

```sql
CREATE TABLE waitlist_signups (
  id           TEXT PRIMARY KEY,            -- crypto.randomUUID()
  email        TEXT NOT NULL UNIQUE,        -- stored lowercased/trimmed
  role         TEXT,
  building     TEXT,
  source       TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  referrer     TEXT,
  ip_hash      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  -- confirmed_at TEXT  ← reserved for Phase 2 double-opt-in (Listmonk); add via migration then
);
CREATE INDEX idx_waitlist_created_at ON waitlist_signups(created_at);
```

### 6.3 API — `POST /api/waitlist` (`src/pages/api/waitlist.ts`, `prerender = false`)

Behavior, in order:
1. Method guard: only POST (405 otherwise). Accept JSON body; also accept form-encoded as progressive-enhancement fallback (the form must work with JS disabled — plain form POST → redirect back with `?joined=1` rendering the success state).
2. Rate limit (§6.5) → on limit, `429` + friendly JSON.
3. Honeypot filled → return the generic success response (silently drop).
4. Validate with zod: `email` trimmed, lowercased, `z.string().email()`, max 254; `role` must be one of the five options (else null); `building` max 200 chars; utm/referrer max 200 each, stored as-is (never rendered unescaped anywhere).
5. Compute `ip_hash = SHA-256(WAITLIST_IP_SALT + clientIP)` (from `CF-Connecting-IP`). Never store the raw IP.
6. `INSERT ... ON CONFLICT(email) DO NOTHING` → **always return the same generic success** `{ ok: true }` whether inserted or duplicate (idempotent, non-leaking).
7. No confirmation email in v1 (no ESP live). Double-opt-in via Listmonk is Phase 2.
8. Log failures via `console.error` with no PII (no raw email in error logs).

### 6.4 Client island (`WaitlistForm.astro`)

Small vanilla-TS `<script>` — no framework runtime needed. Handles: UTM capture, fetch submit, inline states, analytics events (§7), focus management (move focus to success message on success — a11y).

### 6.5 Rate limiting

Use the Cloudflare **Workers rate-limiting binding** (`unsafe.bindings` type `ratelimit`): namespace `WAITLIST_RL`, limit **5 requests / 60s per ip_hash key**. If the binding is unavailable on the account plan, fall back to a D1-based sliding window (single UPSERT per request on a `rate_limits` table) — keep it inside the endpoint, ~30 lines, and note the choice in the PR.

---

## 7. Analytics & events

Minimal and first-party-friendly. This audience runs ad-blockers — expect undercounting; **the D1 row count is the source of truth for signups** (report both).

- Implementation: PostHog JS via snippet in `Base.astro`, loaded **only when `PUBLIC_POSTHOG_KEY` is set** (unset ⇒ zero analytics code in the bundle — preview builds stay clean). `autocapture: false`, no session recording, respect Do Not Track.
- Events (names exact):

| Event | Trigger | Props |
|---|---|---|
| `landing_view` | page load of `/` | `utm_source, utm_medium, utm_campaign, referrer` |
| `waitlist_form_start` | first focus on email field | — |
| `waitlist_submit_success` | 2xx from API | `role` |
| `waitlist_submit_error` | validation/429/5xx | `error_type` ∈ `invalid_email, rate_limited, server` |
| `cta_click` | any CTA | `cta_id` ∈ `hero_primary, hero_secondary, final` |
| `faq_open` | `<details>` toggle → open | `question_id` ∈ `live_today, cries_wolf, replace_tools, cost` |

- Blog pageviews come free with the pageview event; no extra blog events in v1.
- Dashboard (weekly signups by source) is a later, separate task — not this build.

---

## 8. Blog section (infrastructure, SEO-first)

### 8.1 Content model (`content.config.ts`)

`blog` collection (MDX), zod schema:

```ts
{
  title: z.string().max(70),           // also the SEO title unless seoTitle set
  description: z.string().min(70).max(160),  // meta description — enforced length
  pubDate: z.coerce.date(),
  updatedDate: z.coerce.date().optional(),
  author: reference('authors'),
  tags: z.array(z.string()).max(5),
  draft: z.boolean().default(true),    // DRAFT BY DEFAULT — publishing is a deliberate act
  heroImage: z.string().optional(),    // optional; never stock photos
  canonical: z.string().url().optional(),
  faq: z.array(z.object({ q: z.string(), a: z.string() })).optional() // → FAQPage JSON-LD (AEO)
}
```

`authors` collection: `name`, `role`, `xUrl?`, `bio` (one line). Seed with a single generic author `LyraSec AI Team` — real author entries are a marketing decision.

### 8.2 Routes & features

- `/blog` — index with post cards (title, description, date, tags, reading time); pagination at 10 via `[...page].astro`.
- `/blog/[slug]` — post layout: breadcrumb (Home → Blog → Post), H1, byline + dates (`<time datetime>`), reading time (computed from `post.body` word count — see §2.5 item 3, no remark plugin), TOC (from h2/h3, desktop sidebar), code highlighting per Astro 7's built-in config (dark theme matching tokens), tags footer, prev/next links, related posts (by tag overlap, max 3), and the **waitlist CTA block** reused at the end of every post (the blog's job is feeding the waitlist).
- `/blog/tags/[tag]` — tag archive pages.
- `rss.xml` — full-content RSS via `@astrojs/rss` (excludes drafts).
- Drafts: excluded from build output, sitemap, RSS, and tag pages when `draft: true` (and in production builds entirely).
- Sample content: 2–3 sample MDX posts, all `draft: true`, demonstrating every feature (code blocks, FAQ frontmatter, images) — clearly titled as samples (e.g. `_sample-post-structure`).

### 8.3 Content clusters (structure now, content later)

The blog is the base of the SEO/GEO cluster strategy (pillar pages like `/learn/*`, comparison pages, glossary are **Phase 2** — do not build routes for them now). What this build must do: keep URL space clean (`/blog/...` only), make internal linking easy (related posts, tag hubs), so cluster pages can slot in later without restructuring.

---

## 9. Deployment (Cloudflare, separate from product app)

### 9.1 Wrangler

`apps/marketing/wrangler.jsonc`: Workers + static assets (Astro Cloudflare adapter output), D1 binding `DB`, rate-limit binding `WAITLIST_RL`, secret `WAITLIST_IP_SALT`. Name the Worker `lyrasec-marketing`.

### 9.2 Environments

| Env | URL | `PUBLIC_INDEXABLE` | Notes |
|---|---|---|---|
| Preview | `*.workers.dev` (or versioned preview URLs) | unset ⇒ noindex | This is what marketing Vision-QAs and the founder reviews |
| Production | `lyrasecai.com` (once registered — **open item**) | `"true"` only after founder go-live approval | Custom domain attached in Cloudflare after registration |

CI: GitHub Actions workflow may be added in a **follow-up PR** (deploy needs Cloudflare account secrets that don't exist yet). For this build, document manual deploy commands in `apps/marketing/README.md`. Do not add repo secrets or workflows that assume credentials.

### 9.3 Index gating (hard requirement)

- `PUBLIC_INDEXABLE !== "true"` ⇒ every page gets `<meta name="robots" content="noindex, nofollow">` AND `robots.txt` returns `Disallow: /`; sitemap link omitted.
- `PUBLIC_INDEXABLE === "true"` ⇒ robots allows all, points at `/sitemap-index.xml`; no noindex meta.
- Implement `robots.txt` as a dynamic route (`robots.txt.ts`) reading the env at build time.

---

## 10. SEO + GEO/AEO specification

### 10.1 Per-page metadata (via `SeoHead.astro`, all URLs from `PUBLIC_SITE_URL`)

Landing page:
- `<title>`: `LyraSec AI — Secure AI-built apps before they ship`
- Meta description: `LyraSec AI scans AI-built apps like an attacker, verifies every finding, opens the fix PR, and retests until it's gone. Join the early-access waitlist.`
- Canonical, OG (`og:type=website`, `og:title`, `og:description`, `og:image` = `/og/og-default.png` 1200×630 placeholder, `og:url`, `og:site_name = LyraSec AI`), Twitter card `summary_large_image`.

Blog posts: title pattern `{post title} | LyraSec AI Blog` (≤60 chars ideally), description from frontmatter, canonical (frontmatter override supported), `og:type=article` with `article:published_time` / `article:modified_time` / `article:tag`.

### 10.2 JSON-LD (via a `JsonLd.astro` component; `@graph` per page)

Landing page:
1. `Organization` — name `LyraSec AI`, `url` from env, `sameAs`: [X URL] only when set. No logo claim until a real logo asset exists (placeholder OK to omit).
2. `WebSite` — name `LyraSec AI`, url. (No SearchAction — no site search.)
3. `SoftwareApplication` — `name: "LyraSec AI"`, `applicationCategory: "SecurityApplication"`, `operatingSystem: "Web"`, description = meta description. **`offers` omitted entirely** (no pricing).
4. `FAQPage` — exactly the 4 FAQ items from §4.6, text verbatim.

Blog:
- `BlogPosting` (headline, description, datePublished, dateModified, author as `Person` or `Organization`, publisher `Organization` LyraSec AI, mainEntityOfPage).
- `BreadcrumbList` (Home → Blog → Post).
- `FAQPage` when the post's `faq` frontmatter is present.

Validate all JSON-LD with the Schema.org validator before PR; paste results in the PR description.

### 10.3 Technical SEO checklist (all must hold)

- One `<h1>` per page; heading hierarchy without skips; semantic landmarks.
- `@astrojs/sitemap` → `sitemap-index.xml` (drafts excluded), referenced from robots.txt (prod only).
- Clean URLs, no trailing-slash inconsistency (pick Astro default and set `trailingSlash` explicitly).
- `<html lang="en">`; `<meta name="viewport">`; canonical on every page.
- Images: explicit `width`/`height` (no CLS), `loading="lazy"` below the fold, descriptive `alt`.
- Performance budget: Lighthouse mobile **Performance ≥ 90, Accessibility ≥ 95, SEO ≥ 95** on the preview deploy. Astro static + self-hosted fonts + zero framework runtime should land well above this — treat regressions as failures.
- `font-display: swap` (fontsource default), preload the two variable font files used above the fold.

### 10.4 GEO/AEO (Generative-Engine / Answer-Engine Optimization)

The goal: when AI search (Google AI Overviews, Perplexity, ChatGPT Search, etc.) answers "how do I secure AI-generated code," LyraSec AI's pages are citable, extractable, and correctly attributed.

1. **`llms.txt`** (dynamic route, prod only — noindex environments return 404): concise markdown per the llms.txt convention — one-paragraph description of LyraSec AI (from the approved copy only — no new claims), links to `/` and `/blog` and RSS. Keep it in sync with real pages; no aspirational content.
2. **Answer-first content structure** (encode in the sample posts + a `BLOG_AUTHORING.md` guide for marketing): H1 as the question/topic, first 2–3 sentences directly answer it (the extractable snippet), then depth; descriptive H2s phrased as questions where natural; every claim consistent with the no-overclaim guardrails.
3. **FAQ blocks** on posts (frontmatter → visible `<details>` section + FAQPage JSON-LD) — the highest-yield AEO surface.
4. **Stable anchors:** heading `id` slugs auto-generated and stable (AI engines deep-link to fragments).
5. **Entity consistency:** the product is always the exact string `LyraSec AI` in headings/JSON-LD (entity disambiguation from "Lyrafin AI" matters — different product, same founder; never cross-reference on the site).
6. **Crawlability for AI bots:** do NOT block GPTBot / ClaudeBot / PerplexityBot / Google-Extended in robots.txt on production (being crawled is the point of GEO). Document this choice in the PR for founder visibility.
7. **RSS full-content** (already in §8.2) — several AI engines ingest via feeds.

`BLOG_AUTHORING.md` (in `apps/marketing/`) captures rules 2–5 for the marketing agent, plus frontmatter reference and the draft→publish flow (founder approval required to un-draft).

---

## 11. Acceptance criteria

1. `/` renders all 7 blocks with the **exact** copy from §4 — no rewrites, no additions, LyraSec AI naming exactly as written.
2. Waitlist: valid email ⇒ D1 row persisted + success state; duplicate email ⇒ identical success (idempotent, non-leaking); invalid email ⇒ inline error; rate limit ⇒ 429 + friendly message; works without JS (form POST fallback); honeypot drops silently.
3. UTM params + referrer captured when present; `ip_hash` stored, raw IP never stored or logged.
4. All 6 analytics events fire with the specified props when `PUBLIC_POSTHOG_KEY` is set; **zero analytics requests** when unset.
5. Guardrails hold: no pricing numbers, no free-tier promise, no fake logos/badges/testimonials, no third-party logos, **no "Strix" anywhere** (grep the diff: code, comments, meta, sample posts).
6. No hardcoded domain anywhere (grep for `lyrasec` URLs); site URL + X link from env; X link absent from DOM when env unset.
7. Preview deploy is `noindex` + robots-disallowed; the `PUBLIC_INDEXABLE="true"` path verified locally (build twice, diff the head/robots output).
8. Blog: index, post, tag, RSS, sitemap all build; drafts excluded everywhere; sample posts are `draft: true`; JSON-LD (all types in §10.2) validates clean.
9. Lighthouse (mobile, preview URL): Performance ≥ 90, Accessibility ≥ 95, SEO ≥ 95.
10. Repo hygiene: only `apps/marketing/` + minimal root wiring changed; `pnpm turbo build lint typecheck` and `pnpm test` green from repo root; branch + PR with desktop **and** mobile screenshots of every landing block and the blog templates.
11. PR description lists every deviation from this plan (and there will be some — that's expected and fine, hiding them is not).

**Review flow after PR:** marketing runs Vision QA on the rendered preview → fixes → founder final approval → only then domain attach + `PUBLIC_INDEXABLE` flip. Nothing public before that.

**Out of scope for v1:** pricing page, docs, auth-gated anything, confirmation emails (Phase 2: Listmonk double-opt-in via `confirmed_at`), privacy/terms pages (flagged to founder), pillar/comparison/glossary cluster pages, CI deploy workflow, signup dashboard, custom OG-image generation per post.

---

## 12. Open items (founder-level, not blockers for the build)

| Item | Status 2026-07-11 | Impact on this build |
|---|---|---|
| `lyrasecai.com` registration | **Not registered** (NXDOMAIN) | Build domain-agnostic; deploy to workers.dev preview only |
| Cloudflare account / deploy target | Not confirmed | Manual deploy docs only; CI later |
| Analytics key (PostHog) | None exists | Env-gated; events verified with a temp key or local PostHog |
| X handle | Not registered | `PUBLIC_X_URL` unset ⇒ link hidden (already handled) |
| OG image + hero illustration | Marketing to supply | Labeled placeholder slots |
| Trademark | Cleared as gating blocker (founder, 2026-07-11) — LyraSec AI name authorized for public use | Proceed; internal `lyrashield` scopes still unchanged by explicit instruction |
| Launch date | **July 23, 2026** | Preview must be QA-ready well before |
