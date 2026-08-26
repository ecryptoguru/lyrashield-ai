# Launch assurance status — 2026-08-26

This is the current revision-bound production receipt. The 2026-08-24 status document is retained as historical evidence. Running code, provider consoles, Azure state, and CI override this summary.

## Exact production release

- Product revision: `16a1fb7014ce3cbf9e56b69bff5074a5d0d8e0dd`.
- CI run `32966602739` and production release run `32967467190` completed successfully.
- App `lyrashield-app--0000195` and scanner `lyrashield-scanner--0000176` run web digest `sha256:b5cf3bbdb6c6b82dcb571642e754ee8b2b95cb48ce7207e5e1a91ce306198869` at 100% traffic.
- Egress proxy `lyrashield-egress-proxy--0000045` runs digest `sha256:910c20cecb8456c2cb505ab9598c1c8c5215806ad5e688f603b2c492f6bf0119` at 100% traffic.
- Worker digest `sha256:cb0f836eb54825517e900468a87c6d09b5e9df636121b49d8683b1766849fceb` is healthy and binds product `16a1fb7014ce3cbf9e56b69bff5074a5d0d8e0dd` to engine `852b1ed7ff76d177cef4db5aa1cfbd3bbe6d2664`.
- `/api/health` and `/api/ready/scans` returned `200` after promotion and after the controlled recovery drill.

## Closed production gates

- Evidence storage returned `EVIDENCE_STORAGE_PROOF_OK` and `EVIDENCE_STORAGE_FAIL_CLOSED_OK` for encrypted upload, checksum round trip, tamper denial, unauthenticated and wrong-workspace denial, cleanup, and missing-KEK failure.
- Azure Key Vault license signing passed managed-identity retrieval, in-memory sign/verify, denied-identity `403`, missing-secret failure, least-privilege readback, and Desktop public-key fingerprint `2b425098d95141a5bbe251b7d295cec78cadcca8a6c71f65e2f0ca3ae2642d06`. This is Key Vault secret retrieval, not non-exportable remote signing.
- Both named administrators received the Azure test notification and acknowledged it. The terminal-cost alert was resolved from exact zero-request Azure OpenAI evidence; receipt hash `f952706e6ced8105f8d12f530186939f33b0074b6ff17f4eb17a04afd81eeb84` records the two dispositions without changing money columns.
- The controlled orphan drill stopped admission and the worker with no paid or scheduled work, allowed synthetic scan `cmta574d50004fef1nbydufai` to become `FAILED/QUEUE_ORPHANED` without execution or replay, retained verification audit `cmta5do640007fef1dmyj1a3y`, cleaned the fixture under audit `cmta5dohs0008fef1rx1tecpi`, restored the exact worker digest, reconciled both queues to zero, and resumed admission.
- Exact-two admin preflight `32925726620` and apply `32925979621` passed. `ecryptoguru@gmail.com` and `ankit@lyrashieldai.com` are unique, verified, TOTP-enrolled `PLATFORM_OPERATOR` accounts. Fresh independent Google-plus-TOTP sessions opened overview, users, workspaces, scans, audit, and affiliates for both accounts. Unauthenticated, bearer-only, and workspace-header-only overview requests returned `401` with `Cache-Control: private, no-store`.

## Provider readiness boundary

- Razorpay Live is activated with complete account access, six Cloud plans matching the INR catalog and intervals, and one enabled production webhook subscribed to eight events. Hosted-checkout payment-method availability above INR 15,000 remains transaction-unproven.
- Polar Live has an active production API token, fifteen private products covering six Cloud intervals, three minute packs, and six Local products, plus an enabled production webhook for the expected order, refund, customer, and subscription lifecycle events. Payout settlement readiness was not re-proven.
- Production sets `POLAR_ENVIRONMENT=production`; every Polar/Razorpay Cloud and Local purchase admission and billing-staging admission remains `off`. No live charge, subscription, refund, provider mutation, or new financial acceptance occurred during this review.
- Restricted Polar Sandbox and Razorpay Test Mode hosted-checkout, signed-webhook, cancellation, refund, license, database-effect, and 100-replay receipts remain a separate staging gate.

## Public, SEO, and scorecard proof

- Marketing home, pricing, integrations, `robots.txt`, sitemap index, `llms.txt`, and `agents.md` returned `200`. The home canonical, JSON-LD, answer-engine crawler policy, app health, and scan readiness were present; exact-revision CI also passed browser, accessibility, and Lighthouse gates.
- Temporary scorecard `5ZYRLTEPTRB4F53T` was published from the internal `OnboardingAI2` workspace, then revoked. Before revocation its page was `noindex,nofollow`, contained no target/repository identifiers, retained referral code `5MFPHSG9`, and rendered wide `1200x630`, square `1080x1080`, portrait `1080x1350`, and script-free SVG badge responses with `Cache-Control: no-store`.
- Human-view and share events recorded once and deduplicated repeat requests; DNT and GPC returned empty `204` responses. LinkedIn Post Inspector fetched the real HTTPS URL with `200`, displayed `LyraShield Score: F`, cached the generated image, and read the bounded non-guarantee description.
- After revocation the page, all three cards, badge, and event endpoint returned `404`.
- The live pass found that scorecard canonical and OG URLs were baked to `scanner.lyrashieldai.com` even when the page was opened on `app.lyrashieldai.com`. This change makes server metadata prefer the runtime authenticated-app origin and adds a regression test. Merge, exact-SHA deployment, and live canonical readback remain required before the scorecard gate is fully closed.
- Natural expiry, a newer real eligible snapshot superseding an active older share, and webmaster indexing are not claimed. Unit coverage remains green for the seven-field disclosure allowlist, expiry, supersession, referral, and deduplication behavior.

## Remaining controlled gates

1. Merge and deploy the scorecard-origin fix, then repeat the live canonical/OG readback.
2. Run restricted billing staging end to end; keep every production purchase admission off until a separate founder go-live decision.
3. Retain longer-window Redis command/capacity evidence and complete payout/tax-form operations before paid scale.
4. Independently triage the 25 findings from Standard scan `cmt9el7p7000001hdjnjo90wk`; absence in an engine rerun alone remains `INCONCLUSIVE`.
5. Run the founder-approved Deep/Terra acceptance later with its separate $5/45-minute cap and evidence contract.

## Launch classification

The open beta and controlled Standard scanning surface are operational on the exact production revision above. Broader paid admission is **not enabled**. Do not describe live billing, payout operations, public scorecard metadata, or Deep/Terra as launch-proven until their remaining gates are closed.
