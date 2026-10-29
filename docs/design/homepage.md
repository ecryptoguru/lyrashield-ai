# Homepage

The homepage uses the pre-#1049 layout and scroll configuration recovered from
PR #1048 (`bb4c6c3c3387c4b73c9d02322efa9e96aa68f885`). The detailed regression
review is in [the recovery evidence](../evidence/landing-motion-regression-review-2026-10-29.md).

## Cinematic behavior

Native document scrolling controls a paused native video. The controller coalesces
seeks and confirms presented frames. A short muted prime permits compositor
presentation; it does not turn the journey into autoplay. A stale callback or
retired watchdog must not control a replacement source.

Wheel and touch movement retain the 180 ms easing. A single scroll update that
changes the target by more than four seconds of film seeks directly to its final
position. This avoids fetching intermediate scenes during distant chapter or
scrollbar jumps; it does not change native document scrolling or the film mapping.

Use immutable media `74787c7fe35196b2`: desktop 1440×810, GOP 2, CRF 28; native
portrait 720×1280, GOP 4, CRF 24. Preserve the 56-second timeline and seven chapters.
The native controller uses range-capable media delivery. No canvas or segmented
MediaSource player is mounted.

Mobile reserves a visible scene window above readable hero content. The hero
veil must not cover that window in either theme. The original mobile chapter
minimum is `max(520px, 95svh)`; shortening this distance without retiming the film
accelerates the camera relative to scrolling.

Motion Off, reduced motion, Save-Data and unavailable media retain the static
story. The primary action, consent-bound Lite Check, coverage limitations and
shared pricing remain available independently of motion. All product claims
must remain consistent with the retained evidence states and methodology.

## Verification

Check actual rendered phone profiles in both themes, including the mobile scene
window, touch controls, native scrolling, chapter navigation and reversing direction.
Also check orientation, browser-chrome resizing, no JavaScript and enlarged text.
Synthetic CI media tests do not establish physical-device or production smoothness.
