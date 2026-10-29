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
The current native FAQ keyboard behavior and the opaque journey-intro contrast
protection are also retained; neither changes cinematic timing or media delivery.
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

## Production follow-up

The recovery shipped as `1a219c12fc7d93557f4b1a577ec1c89c44815ec6` through
[release 40861647131](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40861647131).
The public revision and original media hash were read back. Unmodified live tests
passed cold startup, continuous scrolling and wheel reversal. The continuous-frame
p95 was 32.6 ms desktop and 31.8 ms mobile under 4× CPU throttling. A separate
cold-navigation probe at 4 Mbit/s, 150 ms latency and 4× CPU throttling measured
first-frame times of 1498 ms desktop and 1538 ms mobile.

Rapid distant jumps still failed the catch-up target. One desktop trace contained
145 media range requests across 40 jumps; network waits for uncached ranges were
commonly 160–200 ms. Easing a large jump decoded intermediate scenes and caused
extra requests. The focused follow-up seeks directly when one scroll update changes
the target by more than four seconds, retaining easing for ordinary movement.
No encoding, resolution, preload or delivery architecture is changed.

Candidate browser tests using the actual media host measured 40-jump p95 of 367 ms
for the iPhone 13 WebKit profile and 258 ms for the Pixel 7 Chromium profile.
These candidate tests substitute the local HTML and script assets at the canonical
origin; they are not proof of the follow-up being deployed. Production acceptance
must read back the follow-up revision and rerun against the unmodified public page.

## Deployed follow-up and edge-cache verification

PR #1056 shipped as `6c4fb264973a5b807bf6fa10ca220be7dc41cc21` through successful
[release 40864406341](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40864406341).
Required checks passed before the normal protected merge: 627 marketing unit tests
and 291 browser checks passed. Public readback confirmed the merged revision.
Live iPhone 13 WebKit, Pixel 7 Chromium and desktop Chromium profiles passed
navigation, both themes, motion preferences, orientation, FAQ and empty form
validation. Seven Android touch-input gestures at 4× CPU converged without fallback.
These remain emulated profiles, not physical-phone acceptance.

After authenticated inspection showed zero cache rules, the operator-authorized
media repair added rule `4c688df13f824e998f7010d79cb94961`. Only the two current
immutable MP4 paths are eligible. Origin TTL is respected; there is no application
or API cache change. Both files then returned `CF-Cache-Status: HIT` with valid
HTTP 206 range responses. The motion README records scope and rollback.

The subsequent unmodified live performance suite passed 7 of 12 checks. Both cold
startup checks, both wheel-reversal checks and both continuous-frame checks passed.
Mobile 4× CPU catch-up passed; the other five cold distant-jump profiles missed
their p95 limits. Continuous new-frame p95/max were 32.8/109 ms desktop and
25.0/125.9 ms mobile. Excluding the first four cold scene requests, buffered-jump
p95 ranged from 17.4 to 123.1 ms across the six CPU profiles. This buffered subset
does not replace the failed cold-jump acceptance gate.

The trace still showed network waits on uncached browser ranges even when the edge
reported HIT. Cache eligibility is therefore confirmed, but it has not resolved
all cold-jump latency targets. Preserve that distinction; do not claim every
production performance gate passes or introduce a full-download startup barrier.

## Approved buffered-start candidate

On October 29, the founder explicitly approved a longer loading phase so distant
scenes are buffered before motion starts. The candidate fetches only the selected
original film into a size-bounded Blob, then uses the same native decoder and
scroll mapping. A visible progress label and chapter posters accompany loading;
page controls and native scrolling remain usable. Downloads are cancelled on
motion-off, hidden tabs, retired variants and component removal. Download errors
leave static content available. Object URLs are revoked when a decoder is retired.

The first candidate completed all six catch-up, both cold buffering and both wheel
checks against the actual media host. The two continuous checks initially stopped
at their old five-second loading setup timeout; after aligning setup waits with the
approved loading phase, both continuous checks passed. All twelve performance
cases therefore pass without changing seek or frame-interval thresholds. Desktop
catch-up p95 at 1×/4×/6× CPU was 27.2/31.7/41.5 ms; mobile was 18.1/23.9/33.7 ms.
Continuous-frame p95/max was 31.6/51.4 ms desktop and 24.9/34.9 ms mobile.
Cold buffering at 4 Mbit/s and 150 ms RTT took 31.7s desktop and 16.5s portrait.
These candidate tests substitute local HTML/scripts at the canonical origin while
fetching the real immutable film. They do not establish a deployed-source result.

The cold motion-start gate is now 90 seconds, reflecting the explicitly approved
loading tradeoff. The 250/500 ms desktop/mobile seek p95, 60 ms continuous p95 and
150 ms maximum interval gates are retained. LCP and CLS targets are unchanged.
