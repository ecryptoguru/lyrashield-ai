# LyraShield AI authority blog program design

Date: 2026-07-17
Status: approved design
Owner: LyraShield Team

## Goal

Publish one definitive authority guide and 99 supporting articles about securing AI-built applications. The library must help developers solve real problems, cite primary sources, state what automated checks cannot prove, and lead readers naturally to the relevant LyraShield AI methodology or free tool.

The work is a publishing program, not a draft exercise. The authority guide publishes first. Each later batch becomes public as soon as every included article and the batch release candidate pass review.

## Readers and voice

The primary readers are solo builders, startup engineering leads, agencies, and developers shipping AI-assisted software. Security engineers are an important secondary audience and should find the technical claims precise.

LyraShield Team is the organizational author. The prose should sound like an engineering team that has built the system and can explain its limits. It should be direct, specific, and readable aloud. It must not imitate a personal expert, invent first-hand incidents, or hide uncertainty.

Every article passes the Humanizer draft, audit, and final rewrite loop. Final prose contains no em or en dashes. Reviewers remove generic signposting, forced three-part lists, vague attribution, promotional filler, repetitive conclusions, manufactured punchlines, uniform sentence rhythm, and prose that talks about the writing process. Technical reference material stays neutral when neutrality is the honest voice.

## Publication sequence

The existing topic and slug map in `docs/plans/2026-07-14-vibe-coder-security-seo-tools-plan.md` remains authoritative. The program has exactly 100 indexable articles. The editorial policy is a separate trust page and does not count toward that total.

1. Authority release: topic 1, `vibe-coding-security-guide`, plus the editorial policy and completed image system.
2. Batch 1: topics 2 through 18, 17 articles covering access, secrets, authentication, input validation, and core web controls.
3. Batch 2: topics 19 through 35, 17 articles covering execution, payment logic, headers, sessions, exposure, logging, and auditability.
4. Batch 3: topics 36 through 52, 17 articles covering monitoring, recovery, dependencies, prompt injection, agent permissions, isolation, and review.
5. Batch 4: topics 53 through 68, 16 articles covering coding tools, app builders, frameworks, data platforms, APIs, and Vercel.
6. Batch 5: topics 69 through 84, 16 articles covering Cloudflare, GitHub Actions, MCP, Stripe, launch checks, scanning, retesting, pull-request gates, and reporting.
7. Batch 6: topics 85 through 100, 16 articles covering operations, incident response, production decisions, privacy, audiences, scores, prioritization, sharing, and key recovery.

Batches are sequential. Articles inside one batch may be produced in parallel lanes of five or six. One lead editor owns voice, search-intent separation, link structure, and final acceptance across the full library.

A batch does not publish until every mapped article in that batch passes. A failed article returns to its review stage, and the batch remains private until the article and its dependent links pass again.

## Research and article contract

Each article begins with a written brief that fixes the primary query, reader problem, unique angle, relevant entities, competing LyraShield URLs, required sources, internal links, tool CTA, FAQ decision, and image concept. The brief must pass cannibalization review before drafting. Store the briefs in one reviewed file per release under `docs/editorial/blog-briefs/authority.md` and `docs/editorial/blog-briefs/batch-1.md` through `batch-6.md`. Store claim-to-source review notes under the matching names in `docs/editorial/blog-research/`.

Technical claims use primary or authoritative sources: OWASP, MITRE CWE, NIST, NCSC, RFCs, official vendor documentation, security advisories, and original research papers. Community research may identify reader language and questions, but it cannot establish prevalence or product performance.

The authority guide is 2,500 to 3,000 words and cites at least eight primary or authoritative references across its six security layers. Each supporting article is 1,200 to 1,500 words and cites at least three authoritative references, including at least two primary or official sources. A source count does not replace claim-by-claim verification.

Every supporting article contains:

1. A 40 to 80 word direct answer.
2. A concrete symptom or minimal vulnerable pattern.
3. An explanation of why AI-generated code can miss the issue.
4. Safe verification steps that do not target a real unpatched system.
5. A minimal corrected pattern and its edge cases.
6. A clear account of what automated checks can and cannot prove.
7. A contextual link to the authority guide in the first third.
8. One relevant free-tool link and at least one related-article link.
9. Two to four FAQs only when they answer distinct questions.
10. Primary sources and a visible publication or material-update date.

Code examples must label vulnerable snippets clearly and must not provide a working exploit against a named real target. Public copy must keep detected, independently verified, retest-confirmed, and inconclusive states separate. It cannot claim pricing, customers, benchmarks, automatic fix-PR execution, universal verification, or a security guarantee.

## SEO and GEO contract

Every page has one search intent, one H1, a unique title and description, stable H2 and H3 anchors, a self-canonical URL, descriptive internal links, and useful initial HTML without client-side content fetching.

Articles emit `BlogPosting` and `BreadcrumbList` data that match visible content. Index and tag pages emit `CollectionPage`, `ItemList`, and breadcrumb data. LyraShield Team emits Organization authorship, not Person authorship. Article schema includes the canonical image, publication and material-update dates, word count, reading duration, language, section tags, publisher relationship, and main-page relationship.

The library uses six stable tags: `vibe-coding-security`, `access-control`, `web-security`, `supply-chain`, `agent-security`, and `verification`. A post may use no more than five. New tags require an explicit information-architecture review and are not added during this program.

Published articles enter the sitemap, RSS feed, tag archives, related-post graph, and `llms.txt` discovery surface. Drafts enter none of those surfaces. FAQ schema is present only when the same questions and answers are visible on the page.

## Editorial policy and accountability

An indexable editorial-policy page at `/blog/editorial-policy` explains that AI may assist with research organization, drafting, and image creation. LyraShield Team remains accountable for source verification, technical review, prohibited-claim review, image approval, corrections, and publication.

The policy also explains source standards, the difference between guidance and security proof, the correction process, stable URLs and heading anchors, and how material corrections receive a visible note plus `updatedDate`.

The LyraShield Team author block links to this policy. It displays the existing role and bio and does not imply individual credentials that have not been supplied.

## Image system

The program uses exactly 36 text-free source artworks created with Codex Imagegen. The authority guide has one exclusive image. The other 35 images cover the 99 supporting articles: 29 images are used by three articles and 6 images are used by two articles. No image appears on more than three articles.

Each source artwork is square and at least 2048 by 2048, with the meaningful subject kept inside a protected central area. Landscape, Open Graph, and portrait files are derived mechanically from that source rather than generated as separate artworks. Reuse is based on subject fit. Adjacent articles in a release and closely related cards on the same archive page should not use the same image.

The shared visual language extends the premium site: navy atmosphere, graphite geometry, translucent evidence planes, restrained cyan, green, amber, and red signals, controlled depth, and sparse haze.

The 35 supporting images are allocated by cluster: 6 access-control images, 6 web-and-execution images, 5 supply-chain images, 6 agent-security images, 6 verification images, and 6 decision-and-operations images. Cluster motifs provide continuity without forcing one generic composition across unrelated topics:

- Access control uses boundaries, gates, and scoped compartments.
- Web and execution uses request paths, redirect corridors, and controlled inputs.
- Supply chain uses dependency structures, provenance chains, and sealed artifacts.
- Agent security uses permission fields, tool paths, and isolation chambers.
- Verification uses receipts, retest rings, and evidence assembly.
- Decision and operations uses release gates, recovery paths, and report structures.

Each catalog image ships these optimized files under `apps/marketing/public/images/blog/library/<image-id>/`:

- `hero.avif`, `hero.webp`, and `hero.jpg` at 1600 by 900.
- `og.jpg` at 1200 by 630.
- `social-portrait.jpg` at 1080 by 1350.

Source masters remain under `apps/marketing-motion/renders/blog-masters/<image-id>/`, which is ignored. Only optimized web assets enter Git.

Add a `blogImages` content collection loaded from `apps/marketing/src/content/blog-images/images.json`. Each catalog entry uses this exact shape:

```json
{
  "evidence-gate-01": {
    "cluster": "verification",
    "avif": "/images/blog/library/evidence-gate-01/hero.avif",
    "webp": "/images/blog/library/evidence-gate-01/hero.webp",
    "jpeg": "/images/blog/library/evidence-gate-01/hero.jpg",
    "og": "/images/blog/library/evidence-gate-01/og.jpg",
    "socialPortrait": "/images/blog/library/evidence-gate-01/social-portrait.jpg",
    "alt": "A translucent evidence plane passing through a controlled release gate",
    "width": 1600,
    "height": 900
  }
}
```

Each article frontmatter references one catalog entry:

```yaml
heroImage: evidence-gate-01
```

Images cannot contain generated text, people, logos, stock-photo imitation, fake dashboards, security guarantees, exploit instructions, or essential information available only in pixels. Alt text describes the visible concept instead of repeating the headline.

File budgets are 220 KB for the AVIF hero, 320 KB for each WebP or JPEG hero, and 350 KB for each social JPEG. Image QA checks concept relevance, artifacts, factual implications, responsive crop, social safe area, contrast, alt text, and file size.

One image manifest per release records each article slug, assigned image ID, concept, prompt, alt text, source hash, crop notes, usage count, and approval status under `docs/editorial/blog-image-manifests/authority.json` and `batch-1.json` through `batch-6.json`. The validator rejects missing IDs, cluster mismatches, more than three uses, and any final count other than the required 29 three-use images plus 6 two-use images.

## Production workflow

Each article moves through these gates:

1. Brief and search-intent approval.
2. Research and claim-to-source notes.
3. Outline and direct-answer approval.
4. Full draft with code, limitations, and links.
5. Security-truth and product-claim review.
6. Humanizer draft, remaining-pattern audit, and final rewrite.
7. Catalog image assignment, crop generation, optimization, and visual approval.
8. Desktop and mobile rendering plus metadata, schema, link, accessibility, and performance review.
9. Individual publication approval.

The batch gate then checks cross-article voice repetition, search cannibalization, link graph, images, schema, sitemap, RSS, tag archives, local browser rendering, and release readiness.

The existing Astro content collection remains the publishing system. No CMS, React runtime, client-side filter library, or new content framework is added.

The two existing sample drafts, `ai-built-security` and `verified-findings`, are development placeholders rather than mapped articles. Remove them before the authority release so the collection contains only the approved 100-topic program.

The collection schema gains `heroImage: reference("blogImages")`, the `blogImages` catalog above, and an author-kind field that supports `Organization` and `Person`. The blog layout resolves the referenced image, renders the responsive `<picture>`, uses the Open Graph image in metadata and schema, and links organizational authorship to the editorial policy.

A deterministic content validator checks article count, mapped slugs, unique titles and descriptions, word ranges, stable tags, body heading hierarchy, required internal links, authoritative-source counts, image variants and dimensions, file budgets, prohibited product claims, prohibited punctuation, unresolved placeholders, and unpublished link dependencies. Human prose quality and technical truth remain review decisions, not automated pass conditions.

## Testing and release

Every article must render with one H1 and one main landmark. Keyboard navigation, visible focus, 200 percent zoom, dark and light themes, 390 pixel mobile layout, tablet layout, desktop layout, and no-JavaScript reading must work.

Every batch must pass formatting, lint, typecheck, all tests, production build, structured-data parsing, sitemap and RSS assertions, internal-link crawling, external-source link checks, image-budget checks, and `git diff --check`.

Representative batch pages must score at least 90 for Lighthouse performance and 100 for accessibility, best practices, and SEO. LCP must be at most 2.5 seconds and CLS below 0.1.

Publication follows this sequence: local completion, individual approvals, batch approval, focused PR, green CI, merge, guarded Cloudflare deployment, and live verification. Live verification covers URLs, canonicals, images, structured data, sitemap, RSS, links, console, mobile rendering, and privacy-safe analytics.

Search Console and Bing data may guide later title or description improvements. Published URLs and heading anchors remain stable unless a factual correction requires a change. No ranking, citation, or traffic outcome is promised.

## Completion criteria

The program is complete when all 100 mapped articles are public, each article has its approved image set, all batches have passed their release gates, the editorial policy is live, the sitemap and RSS contain the intended pages, and the production library has passed final link, schema, browser, performance, and privacy verification.

The premium homepage media deployment and its R2 gate remain separate work. This blog program does not broaden authorization to provision Cloudflare resources or alter DNS outside the existing guarded marketing deployment.
