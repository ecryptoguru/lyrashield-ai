# Production readiness after the cross-repository merge

Checked on 2026-09-30. Source merge, release compatibility and deployed runtime are separate gates. The new hardening is merged, but its production transition is not complete.

## Merged source

| Repository  | Main revision                              | Evidence                                                                                                                                                   |
| ----------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product     | `c948aa1b33e8ca367b85ca46122710f35968559e` | Required main CI `36698346105` passed.                                                                                                                     |
| Engine      | `12daa1d4c2b012826c4df576a66b3d7bf99057c3` | Verify, locked dependency audit and sandbox build/smoke checks passed. Its tree matches the reviewed candidate `c0cf936b4c3ee6f8f331681802645cc044d60911`. |
| Marketplace | `5f126be739c2201011d40e3947683c797e5c65d4` | Validation `36694005039` passed. Its manifest still binds product checkpoint `58cc2e46ec6c60f46f2d7ed9a8059205394aae88`.                                   |

The engine reverse consumer pin still names product `9b548984fcecd0a2a5c675800af79ec057a9969a`. Advance it only to the exact final merged product after compatibility verification. Regenerate final marketplace identities from that approved clean product source before publication.

## Prepared release correction

The release at merged product `c948aa1b` failed at startup in [run 36698540141](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36698540141), before any production job started. GitHub reported that the nested workflow requested `actions: read` while its caller allowed `actions: none`. The prepared correction preserves read access through the automatic release, Azure caller and protected runtime job. Read access also supports the same-run maintenance recovery proof. No write permission or approval bypass is added.

Cloud and Desktop source pins advance together to the exact merged engine `12daa1d4`. The temporary unmerged-candidate CI job is removed; the required pinned engine/worker contract remains authoritative. Desktop publication remains deferred.

Local release validation: 82 Node deployment tests passed with zero skips; the nested permission regression passed; workflow actionlint, pin parity, engine merge/provenance checks, formatting and diff checks passed. Final branch CI and the pinned consumer contract must pass before merge.

## Live runtime readback

At 2026-09-30 09:55:43 UTC, the current worker remained healthy on engine `c2fb19595bdefa0eda52d09ccd2aaeabcca575ae`. The billing claims protocol was `UNAVAILABLE`; migration `20260930120000_webhook_track_claims` was absent. App revision `lyrashield-app--0000455`, scanner `lyrashield-scanner--0000430` and egress `lyrashield-egress-proxy--0000296` each retained 100% traffic. The live scan-readiness endpoint returned HTTP 200 with worker ready. No deployment or migration was performed during these checks.

Worker storage had 47 GB free on a 61 GB host disk, with 24% used. Bounded Redis INFO readback showed 262,503 exposed processed commands, 6 instantaneous operations per second, 17,726 bytes used memory and 10 connected clients. These fields do not establish Upstash billing-quota usage or sustained capacity; provider history and a longer observation window remain required.

## Remaining production gates

1. Merge the corrected release source only after fresh required CI and exact merged-engine compatibility pass.
2. Complete reverse consumer pin and final marketplace source identity after the final product merge.
3. Authorize and run the protected [webhook-claims maintenance cutover](webhook-production-cutover.md). Ordinary release deliberately rejects the current legacy-writer baseline. The cutover drains paid work, excludes old ingress and consumers, applies the additive migration, starts compatible writers and resumes only its owned admission stop. Failure retains maintenance; it never resumes legacy writers after migration.
4. Verify exact deployed product/engine/image digests, app/scanner/egress traffic, writer protocol, migration, readiness and rollback baseline after promotion.
5. Retain longer-window Redis capacity evidence and separate provider/payment, payout/tax and authenticated-client receipts. No paid transaction, Deep acceptance, public package publication or signed Desktop release is established by source CI or local Docker tests.
