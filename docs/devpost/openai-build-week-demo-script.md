# LyraShield AI — OpenAI Build Week demo

**Length:** 2 minutes 30 seconds to 2 minutes 55 seconds.  
**Delivery:** public or unlisted YouTube video with spoken narration.  
**Rule-critical:** show a working project and explain both Codex and GPT-5.6 use.

## Recording flow

1. **0:00–0:15 — problem and impact**

   Show `https://lyrashieldai.com`.

   > AI-assisted software can ship faster than teams can justify a release decision. LyraShield AI makes the evidence boundary visible: what was detected, independently verified, retest-confirmed, or remains inconclusive.

2. **0:15–0:50 — working public product**

   Open the homepage Lite Check and run it against `https://lyrashieldai.com`.

   > This is the working public Lite Check. It reviews an authorized public surface with deterministic checks and does not pretend it is a full authenticated scan. The progress UI shows what is being checked without inventing a completion percentage.

3. **0:50–1:20 — novel evidence model**

   Show the result, methodology page, then the report/sample-report page.

   > The core product distinction is evidence state. A detected finding is not automatically verified. A clean deterministic retest is retest-confirmed only when its applicable coverage is complete; otherwise it remains inconclusive. That prevents an AI confidence score from becoming a security claim.

4. **1:20–1:48 — complete product experience**

   Show a recorded session from `https://app.lyrashieldai.com`: target list, scan detail, immutable manifest or coverage receipt, and report/scorecard view. Do not show credentials or customer data. If a retained scan is unavailable, use the public Lite Check and the synthetic sample report rather than presenting a local fixture as a production scan.

   > The authenticated workspace connects targets, findings, receipts, score snapshots, reports, schedules, and approval-gated actions. Scan admission fails closed when a worker is unavailable, and risky actions do not accept client-authored patches.

5. **1:48–2:33 — Build Week, Codex, and GPT-5.6**

   Show the README's dated Build Week section, the pull-request links, a recent green GitHub Actions run, and a safe excerpt of the worker model-routing or result-integrity code.

   > The product existed before Build Week, so the README identifies the exact baseline and every meaningful extension added after it. GPT-5.6-powered Codex sessions helped trace the system, implement and test evidence receipts, build the public scanner and product UX, and harden CI and deployment. I made the product decisions: evidence state instead of confidence-as-proof, deterministic public checks, and risky paths failing closed. In the controlled full-scan contract, GPT-5.6 Luna handles focused work while Terra coordinates deep reviews. Before requests run, the system bounds context, agents, output, concurrency, and spend.

6. **2:33–2:53 — close**

   Return to the public site and repo.

   > LyraShield AI is release assurance for AI-built software: not a claim that every issue is fixed, but a clear record of what evidence exists and what still needs review. The public Lite Check is live today; the authenticated workspace is an open-registration production beta.

## Before upload

- Record at 1080p with audible narration.
- Verify the YouTube URL in a private/incognito browser; public or unlisted is acceptable.
- Keep the final video under three minutes.
- Do not show API keys, database URLs, user email addresses, or unredacted target details.
- Paste the YouTube URL into the Devpost project only after the private-window check passes.
- Generate the submission Session ID by running `/feedback` in the primary Codex build thread; do not substitute the visible task UUID unless `/feedback` returns it.
