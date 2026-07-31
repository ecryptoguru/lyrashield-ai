# LyraShield Web

Next.js 16 dashboard for the authenticated LyraShield workspace.

## Purpose

- The authenticated application at `app.lyrashieldai.com`.
- Handles sign-in, workspace onboarding, target management, scans, findings, fix proposals, retests, reports, schedules, notifications, scorecards, and agent approvals.
- Exposes the public scorecard pages and Open Graph image endpoints under `/score/:slug` and `/api/og/*`.
- Hosts the remote MCP endpoint at `/api/mcp`.
- Enforces workspace-scoped permissions, rate limits, and audit logging.

## Tech stack

- Next.js 16 with React 19 and Tailwind CSS 4
- `better-auth` for authentication
- `@lyrashield/db`, `@lyrashield/auth`, `@lyrashield/ui`, `@lyrashield/types`, `@lyrashield/integrations`, `@lyrashield/security`, `@lyrashield/score`

## Scripts

```bash
pnpm dev
pnpm build
pnpm start
pnpm typecheck
pnpm lint
```

## Environment

Copy `apps/web/.env.example` to `apps/web/.env` and set at least `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_MARKETING_URL`, `BETTER_AUTH_SECRET`, and database credentials.

## See also

- `docs/deployment/LOCAL_SETUP.md`
- `packages/cli/README.md`
- `userguide.md`
