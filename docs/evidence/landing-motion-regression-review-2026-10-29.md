# Landing motion regression review — 2026-10-29

## Source comparison

The first-parent history of the homepage, hero, motion controller, mapping and media
contract was inspected back through the original scroll-world introduction in PR #88.
The current V3 implementation began in PR #979. The pre-#1049 homepage remained
substantially unchanged through the recent product PRs, including #1039 and #1048.

The recovery source is `bb4c6c3c3387c4b73c9d02322efa9e96aa68f885` (PR #1048).
This is a source recovery baseline, not a new claim that every phone has been tested.

## Earlier motion lineage

- #88 introduced the original scroll-world landing.
- #290 introduced responsive Motion V2 and its shared media contract.
- #291 and #292 revised the mobile story layout and scroll behavior.
- #979 introduced the current continuous V3 world and native-video controller,
  including the mobile reveal fix in `f48daa0d0`.
- #996 changed hero copy; it did not replace that controller.
- #1021 added lifecycle guards and static-poster protection. Those guards are
  included in the recovered #1048 source.

## Confirmed regressions

| Change                               | Evidence and effect                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #979 mobile reveal fix (`f48daa0d0`) | Reserved a visible mobile scene window and removed the covering hero veil. This behavior was later removed in #1049.                                                                                                           |
| #1049 (`30eacd028`)                  | Replaced the hero and its mobile reveal rules. Mobile chapter minimum height changed from `max(520px, 95svh)` to `max(360px, 58svh)` while keeping the same 56-second film. This increased camera movement per unit of scroll. |
| #1051 (`e2bac9b3a`)                  | Replaced scroll scrubbing with native autoplay. This changed the requested interaction.                                                                                                                                        |
| #1052 (`23e4b2834`)                  | Introduced paused-video canvas presentation. The original native compositor path was replaced.                                                                                                                                 |
| #1053 (`283df26f0`)                  | Reduced desktop delivery to 800×450 and portrait to 450×800 at CRF 38. Startup waited for the complete film download.                                                                                                          |
| #1054 (`46fe45081`)                  | Restored resolution but introduced one-second fragmented media and MediaSource buffering. Real-host tests still showed cold-scene stalls despite passing local controller checks.                                              |

The recovery restores the original native-video controller, presented-frame
confirmation, mobile scene reveal, original scroll spacing and immutable media
`74787c7fe35196b2`. Desktop uses 1440×810 / GOP 2 / CRF 28. Native portrait uses
720×1280 / GOP 4 / CRF 24. Reduced-motion and Save-Data poster modes remain.

Unrelated application fixes, shared navigation fixes and blog changes are retained.
Homepage regression tests are aligned with the recovered behavior. Tests specific
to the retired segmented/canvas renderer are replaced by the earlier controller's
startup, priming, reversal, resize and stale-callback regression checks. The mobile
scene window is checked explicitly so the #1049 visibility regression cannot recur.

## Validation boundary

The recovered source builds and typechecks. Marketing unit tests: 627 passed.
Motion pipeline tests: 30 passed. Device-profile screenshots show the restored
mobile scene window, touch-sized CTAs and an operable mobile menu on Android Chrome
and iPhone WebKit profiles. These are emulated browser profiles; physical-device
acceptance remains unverified. Browser and CI results are recorded in the recovery PR.
