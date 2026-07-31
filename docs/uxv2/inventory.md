# UX V2 Route and Component Inventory

This file is the source of truth for the legacy-to-new route map and the rollout checklist. It is created in Phase 0 and updated as phases land.

## Route tree

- `/` — marketing (out of scope for V2 app changes; Phase 10)
- `/sign-in`, `/sign-up` — auth (Phase 2 may redirect post-GitHub flow)
- `/onboarding` — onboarding wizard (Phase 2)
- `/dashboard` — home / Trust Command Center (Phase 4)
- `/dashboard/scans`, `/dashboard/scans/[id]` — canonical, unchanged; aliased by `/dashboard/runs` (Phase 5)
- `/dashboard/findings`, `/dashboard/findings/[id]` — canonical, unchanged; aliased by `/dashboard/issues` (Phase 6)
- `/dashboard/targets`, `/dashboard/targets/[id]` — redirect to `/dashboard/products` and `/dashboard/products/[id]` (Phase 4)
- `/dashboard/projects` — redirect to `/dashboard/products` (Phase 4)
- `/dashboard/products`, `/dashboard/products/[id]` — Product presentation layer (Phase 4)
- `/dashboard/fixes` — redirect to `/dashboard/issues` (Phase 6)
- `/dashboard/reports` — redirect to `/dashboard/evidence` (Phase 7)
- `/dashboard/evidence` — Evidence home (Phase 7)
- `/dashboard/launch-readiness` — deep link; content promoted into home/product detail (Phase 4)
- `/dashboard/approvals` — Approval Centre (Phase 6)
- `/dashboard/automations` — alias of `/dashboard/schedules` (Phase 4)
- `/dashboard/notifications` — in app list (Phase 8)
- `/dashboard/integrations` — promoted to More menu (Phase 1)
- `/dashboard/team` — promoted to More menu (Phase 1)
- `/dashboard/settings` — settings, including notification preferences (Phase 8)

## Navigation

- Desktop primary: Home, Products, Trust Runs, Issues, Approvals, Evidence, Automations
- Desktop secondary: Notifications, Integrations, Team, Settings
- Mobile bottom: Home, Products, Runs, Issues, More
- Mobile More sheet: Approvals, Evidence, Automations, Notifications, Integrations, Team, Settings

## Terminology map

| Internal | V2 user-facing label |
|---|---|
| Scan | Trust Run |
| Finding | Issue |
| Project | Product |
| Target | Asset |
| Target.environment | Environment |
| FixProposal | Proposed fix |
| Report | Evidence record |
| Schedule | Automation |

## Rollout checklist

- [ ] Phase 0 — feature flags, analytics wrapper, Playwright matrix, baselines
- [ ] Phase 1 — mobile shell, visual refresh, radius change, bottom nav
- [ ] Phase 2 — autonomous GitHub onboarding
- [ ] Phase 3 — trust plan, time estimator, first run
- [ ] Phase 4 — products, home, trust command center
- [ ] Phase 5 — trust runs UX and live progress
- [ ] Phase 6 — issues and Approval Centre
- [ ] Phase 7 — evidence and public verdict disclosure
- [ ] Phase 8 — notifications
- [ ] Phase 9 — sharing and virality
- [ ] Phase 10 — landing page
