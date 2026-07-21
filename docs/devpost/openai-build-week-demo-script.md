# LyraShield AI — OpenAI Build Week demo

**Length:** under 3 minutes (current final export: 2 minutes 19.0 seconds).
**Delivery:** public YouTube video with spoken narration.
**Rule-critical:** show a working project and explain both Codex and GPT-5.6 use.

## Recording flow

1. **0:00–0:11 — problem and impact**

   Show `https://lyrashieldai.com`.

   > AI-built software can reach production before anyone can answer a basic question: what was actually tested? LyraShield AI turns that uncertainty into an evidence-backed release decision.

2. **0:11–0:44 — working public product**

   Show the homepage Lite Check form, then the retained authorized result for `https://lyrashieldai.com`.

   > The working public Lite Check is passive and read-only. The real retained result shows zero needs attention, zero worth reviewing, and five checks look okay while keeping its limitation visible.

3. **0:44–1:09 — novel evidence model**

   Show the result, methodology page, then the report/sample-report page.

   > A detected candidate is not automatically verified. Independent verification needs a separate receipt, a fresh deterministic retest can be retest-confirmed, and incomplete evidence remains inconclusive. The sample report is visibly sanitized and illustrative.

4. **1:09–1:34 — authenticated product experience**

   Show the local production-like authenticated workspace: the configured public target, blank score, `Needs evidence` launch verdict, and real scan setup. Do not start a full scan or present this local workspace as production evidence.

   > The product never turns an unrun scan into a confident number. Release Check, Code Review, and Deep Security Review are visible, while full-scan execution remains separately authorized, budget-bounded, and healthy-worker-gated.

5. **1:34–2:10 — Build Week, Codex, and GPT-5.6**

   Show the repository-backed architecture card, the exact Luna/Terra routing excerpt from `apps/worker/src/engine/runner.ts`, and the current-revision verification card with the Codex task ID and passing test counts.

   > Public URL checks stay deterministic while repository reviews use the controlled GPT-5.6 runtime. The worker routes focused work to Luna and deep coordination to Terra. During Build Week, GPT-5.6-powered Codex sessions traced cross-package flows, implemented evidence boundaries, diagnosed failures, reviewed the real UX, and hardened the release path. On the current verified revision, 933 core tests, 80 marketing tests, 16 motion tests, and 4 Chromium end-to-end tests pass.

6. **2:10–2:19 — close**

   Show the LyraShield AI end card and canonical domain.

   > LyraShield AI does not promise that everything is secure. It shows what evidence exists, what remains uncertain, and whether an AI-built app is ready to ship.

## Before upload

- Record at 1080p with audible narration.
- Verify the public YouTube URL in a private/incognito browser.
- Keep the final video under three minutes.
- Do not show API keys, database URLs, user email addresses, or unredacted target details.
- Paste the YouTube URL into the Devpost project only after the private-window check passes.
- Generate the submission Session ID by running `/feedback` in the primary Codex build thread; do not substitute the visible task UUID unless `/feedback` returns it.
