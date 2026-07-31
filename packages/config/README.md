# @lyrashield/config

Environment validation and shared configuration for the LyraShield monorepo.

## Purpose

- Validates required and optional environment variables using Zod.
- Exports the typed `env` object, plus `isProd`, `isDev`, and `isTest` helpers.
- Shared TSConfig files live under `tsconfig/` and are referenced by other packages.

## Main exports

- `env` — the validated, typed environment object.
- `isProd`, `isDev`, `isTest`
- `type Env`

## See also

- `.env.example` in the repository root.
- `docs/deployment/LOCAL_SETUP.md`
