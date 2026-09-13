# @lyrashield/auth

Authentication, session helpers, permissions, and OAuth providers for LyraShield.

## Purpose

- Wraps `better-auth` with the LyraShield schema and environment config.
- Exports a client-safe auth client (`src/client.ts`) for use in React / server components.
- Defines workspace role permissions in `src/permissions.ts` (`hasPermission`, `hasMinimumRole`, etc.).
- Provides OAuth provider configuration in `src/oauth-providers.ts`.

## Main exports

- `authClient`, `signIn`, `signOut`, `signUp`, `useSession`, `getClientSession`
- `isOAuthProviderConfigured`
- `PERMISSIONS`, `hasPermission`, `hasMinimumRole`, `canGrantRole`, `getRolePermissions`, `isWorkspaceAdmin`, `isWorkspaceOwner`

## Subpath exports

- `@lyrashield/auth` — client-safe exports
- `@lyrashield/auth/server` — server-only exports (session, `requireAuth`, `requirePermission`)
- `@lyrashield/auth/oauth-providers` — provider setup

## See also

- `apps/web` for dashboard usage.
- The former `docs/deployment/PRODUCTION_DEPLOYMENT.md` runbook (auth and email verification notes) was retired on 2026-09-09 and remains recoverable from git history (e.g. `git show <history>`).
