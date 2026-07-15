# BLOG_AUTHORING.md — Writing for the LyraShield AI Blog

**Audience of this guide:** whoever writes or edits posts (the LyraShield Marketing Agent, the founder, future contributors).
**Companion to:** `README.md` (local/deploy operations) and the implemented Astro site. This guide covers _content_; code and `codebase.md` cover infrastructure.

The blog has one job pre-launch: earn trust with developers, CTOs, and security engineers, and feed the waitlist. Every post ends at the waitlist CTA. Write like an engineering blog, not a content farm.

---

## 1. Hard guardrails (same as everywhere else — zero exceptions)

1. **Never mention "Strix"** or the scan engine's upstream, in any form.
2. **No pricing numbers, no free-tier promise.** If a post must reference cost, the only sanctioned line is: pricing lands with early access.
3. **No overclaims.** A detected candidate, an independently verified finding, a retest-confirmed fix, and an inconclusive result are different states. Do not collapse them into "verified" or imply every finding receives exploit proof. Banned phrasings: "only we verify," "only we auto-fix," "the only tool with MCP/IDE integration," "first ever," "we open the fix PR," and "provably fixed." The moat is the **combination**, and even that is stated as design philosophy, not supremacy.
4. **No benchmark or accuracy numbers about LyraShield AI, ever.** No "catches 94% of…," no detection-rate claims, no false-positive-rate claims. Third-party industry research may be cited _with a source link_ and exact figures — never rounded up, never paraphrased into a stronger claim.
5. **No fake anything:** no invented customers, quotes, incidents, or "we scanned X and found Y" stories unless the scan actually happened and the founder approved publishing it. No stock photos.
6. **Honest status.** Pre-launch means pre-launch. Posts may say "building in public," describe design decisions, and share real progress. They may not imply the product is live, has users, or has results it doesn't have.
7. **Product name:** exact string **LyraShield AI** on first mention (title or first paragraph) and in all headings/metadata; **LyraShield** is fine for subsequent prose mentions. Never LyraSec in new content. Never mention Lyrafin AI — separate product; no cross-references on this site.
8. **Security content responsibility:** when a post explains a vulnerability class, show the _pattern_ (minimal snippet, clearly labeled vulnerable vs. fixed). Never publish a working exploit against a real, named, unpatched target.

Anything that violates these does not get published, no matter how good the SEO story is.

---

## 2. Voice

- **Evidence-first engineering-blog register.** The reader is a developer or security engineer with a working BS detector. Claims carry evidence or hedges; opinions are labeled as opinions.
- Plain, direct sentences. Technical precision over marketing adjectives — "records the detection, coverage, and retest state" beats "revolutionary AI-powered validation." Do not promise sandbox exploitation; intrusive replay is not implemented.
- First person plural ("we") for design decisions; second person ("you") for the reader's workflow.
- CWE/OWASP references welcome where accurate — link them.
- Humor allowed, hype not.

---

## 3. Frontmatter reference

Every post is an `.mdx` file in `src/content/blog/`. Schema (zod-enforced at build — the build **fails** on violations):

```yaml
---
title: "Why AI-generated SSRF checks fail" # ≤70 chars; becomes the SEO title
description:
  "AI assistants often generate SSRF protection that string-matches URLs instead of resolving DNS. Here's the failure pattern and the fix."
  # 70–160 chars — this is the meta description; write it as the answer snippet
pubDate: 2026-07-20
updatedDate: 2026-07-22 # only when materially updated
author: lyrashield-team # reference into the authors collection
tags: ["ai-code", "ssrf", "verification"] # max 5, lowercase-kebab
draft: true # ALWAYS true until founder approves publish
heroImage: ./images/ssrf-pattern.png # optional; never stock photos
faq: # optional but HIGH VALUE (→ FAQPage JSON-LD)
  - q: "Why does string-matching fail for SSRF protection?"
    a: "Because the check runs against the URL text, not the resolved address — DNS rebinding and redirects bypass it."
---
```

Rules of thumb:

- **title:** front-load the topic; no clickbait, no colons-with-puns. It should read like a Stack Overflow question someone actually has.
- **description:** it's doing triple duty — meta description, index-card blurb, the AI-extractable answer, and the RSS feed summary. Write it as a complete, standalone answer to the title.
- **tags:** reuse existing tags before inventing new ones (each tag spawns an archive page; five posts across five orphan tags helps nobody).

---

## 4. Answer-first structure (the AEO core)

AI search engines (Google AI Overviews, Perplexity, ChatGPT Search) extract and cite passages, not pages. Structure every post so the extraction is correct and attributed:

1. **H1 = the question or topic** the post answers, phrased how a person would ask it.
2. **First 2–3 sentences answer it directly.** No throat-clearing ("In today's fast-moving world of AI development…" — delete). A reader who stops after the first paragraph should leave with the correct short answer.
3. **Then the depth:** evidence, code, edge cases, the "why," the disagreements.
4. **H2s as sub-questions** where natural ("How does DNS rebinding bypass the check?"), descriptive statements otherwise. Never decorative headings ("Diving deeper").
5. **One idea per section.** Sections should be independently extractable — an AI engine quoting any single section should not produce a misleading claim.
6. **FAQ block** (frontmatter `faq:`) for 2–4 genuinely-asked questions that didn't fit the main flow. This renders as a visible FAQ section _and_ FAQPage JSON-LD — the highest-yield AEO surface we have. Don't restate the H1 answer as FAQ #1.
7. **Anchors are stable:** heading slugs are auto-generated from heading text. After publish, treat heading text as an API — editing a heading breaks inbound deep links and AI citations. If a heading must change, note it in the PR/update.

---

## 5. SEO mechanics per post

- Exactly one H1 (the title — the layout renders it; don't add another `#` in the body).
- Heading hierarchy without skips (H2 → H3, never H2 → H4).
- Internal links: every post links to ≥1 other post (or the landing page) with descriptive anchor text — never "click here."
- External links: link primary sources (CWE entries, advisories, official docs), not aggregator blogspam.
- Images: descriptive `alt` text (what the image shows, not "image of"); explicit width/height; no text-in-image for anything essential.
- Code blocks: language-tagged fences; keep snippets minimal and runnable-looking; label vulnerable examples clearly (`// VULNERABLE — do not copy`).
- Dates: real `pubDate`; set `updatedDate` on material changes (both render and feed JSON-LD `dateModified`).

---

## 6. What to write (pre-launch content lanes)

Stay in lanes where we have standing and evidence:

1. **Vulnerability patterns in AI-generated code** — the classic mistakes copilots ship (SSRF string-matching, unenforced role matrices, committed secrets). Concrete, reproducible patterns with fixes.
2. **Building in public** — real engineering decisions from building LyraShield AI (coverage receipts, evidence-state boundaries, approval-gated fix proposals, MCP integration design). Honest about tradeoffs and unfinished work.
3. **Explainers** — CWE/OWASP concepts translated for developers who ship AI-built apps without a security background.
4. **Workflow content** — securing code inside Cursor/Claude Code/Windsurf-style loops; MCP as an integration surface.

Out of bounds: competitor teardowns (punching at competitors invites scrutiny we don't need pre-launch), vendor comparisons, anything requiring product claims we can't demonstrate yet, commentary on active incidents at named companies.

---

## 7. Draft → publish flow

1. Author writes the post with `draft: true`. Drafts never appear in builds, sitemap, RSS, or tag pages.
2. Self-check against §1 guardrails + §4 structure (literally re-read the lists).
3. Marketing QA: rendered-preview review; visual assets go through the Vision QA Agent.
4. **Founder approval** — explicit, per post. Only then flip `draft: false`.
5. Publish = PR to main (the deploy follows the site's normal branch + PR flow). Never edit published posts silently — material corrections get `updatedDate` and, where the error was substantive, a visible correction note.

### Distribution after publish

- Share the canonical published URL so the site's approved Open Graph metadata is the source of truth. Do not upload a modified screenshot that changes a headline, result, grade, or product state.
- A product scorecard may accompany a post only when it is a real, still-public scorecard generated by the app. Use its grade/fixes card or badge as rendered; revoked, expired, or superseded artifacts are not reusable marketing assets.
- Keep channel copy scope-qualified. “We earned a scoped grade B on this review” is acceptable when the linked frozen card says so; “LyraShield makes apps secure” is not.
- Use referral links only through the implemented waitlist or scorecard flows. Do not hand-edit codes, add email addresses to URLs, or attach private finding/repository context.
- External-platform previews are caches. Validate the canonical page first, then refresh the platform cache when supported; do not change canonical metadata merely to work around one stale cache.

---

## 8. Pre-publish checklist (copy into every post PR)

- [ ] Title ≤70 chars, reads as a real question/topic
- [ ] Description 70–160 chars, standalone answer
- [ ] First paragraph answers the H1 directly
- [ ] No "Strix", no pricing, no benchmark/accuracy claims, no overclaim phrasings (§1)
- [ ] Product named exactly "LyraShield AI" on first mention; no Lyrafin references
- [ ] Headings: one H1, no level skips, no decorative headings
- [ ] ≥1 internal link with descriptive anchor text
- [ ] External claims linked to primary sources
- [ ] Images have alt text + dimensions; no stock photos
- [ ] Vulnerable code snippets labeled; no working exploits against real targets
- [ ] FAQ block present (or consciously skipped)
- [ ] Tags: ≤5, reused where possible
- [ ] Canonical URL and social preview render the approved title/description/image
- [ ] Any linked scorecard is real, public, unmodified, scope-qualified, and not revoked/expired
- [ ] Share copy contains no private target/finding detail, invented proof, or hand-edited referral code
- [ ] `draft: true` until founder approval is on record
