---
name: next-upgrade
description: Upgrade Next.js to the latest version following official migration guides and codemods. Use when migrating between Next.js major versions, running codemods, or updating peer dependencies after a framework bump.
when_to_use: "When upgrading a Next.js project to a newer major version, running codemods, or resolving breaking changes after a version bump. NOT for day-to-day development."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
effort: medium
---

# Next.js Upgrade Skill

> Systematic migration from one Next.js version to another using official guides, codemods, and incremental steps.

---

## Upgrade Protocol

### 1. Detect Current State

Read `package.json` to identify:
- Current `next` version
- Current `react` and `react-dom` versions
- TypeScript types versions
- Any Next.js plugin versions

### 2. Determine Upgrade Path

| From → To | Strategy |
|-----------|----------|
| Same major (e.g., 15.0 → 15.2) | Direct dependency update |
| One major (e.g., 14 → 15) | Codemods + guide + test |
| Two+ majors (e.g., 13 → 15) | Incremental: 13 → 14 → 15 |

### 3. Fetch Official Guides

Use the official Next.js upgrade documentation:
- Codemods: https://nextjs.org/docs/app/guides/upgrading/codemods
- Version-specific guides:
  - v16: https://nextjs.org/docs/app/guides/upgrading/version-16
  - v15: https://nextjs.org/docs/app/guides/upgrading/version-15
  - v14: https://nextjs.org/docs/app/guides/upgrading/version-14

### 4. Run Codemods First

```bash
npx @next/codemod@latest <transform> <path>
```

| Transform | When to Use |
|-----------|-------------|
| `next-async-request-api` | Next.js 15+ async params/cookies/headers |
| `next-request-geo-ip` | Migrates geo/ip properties (v15) |
| `next-dynamic-access-named-export` | Dynamic import named exports (v15) |
| `next-image-to-legacy-image` | Migrates next/image import (v13) |

### 5. Update Dependencies

```bash
# Core framework
npm install next@latest react@latest react-dom@latest

# TypeScript types (if applicable)
npm install @types/react@latest @types/react-dom@latest
```

### 6. Review Breaking Changes

Check for manual changes:
- API changes (e.g., async `params` in v15, `cookies()` async in v15)
- `next.config.js` option renames/removals
- Deprecated features (e.g., `unstable_cache` → `use cache` in v16)
- Middleware → `proxy.ts` rename (Next.js 16)

### 7. Build & Test

```bash
npm run build     # Check for build errors
npm run lint      # Check for lint/type errors
npm run test      # Run test suite
npm run dev       # Manual smoke test
```

---

## Common Breaking Changes by Version

### Next.js 15 → 16
- `unstable_cache` deprecated → use `use cache` directive
- `middleware.ts` → `proxy.ts` (with `config` matcher)
- Cache Components (`use cache`, `cacheLife`, `cacheTag`) become stable
- Partial Prerendering (PPR) stabilized

### Next.js 14 → 15
- `params`, `searchParams` are now `Promise<T>` (async)
- `cookies()`, `headers()`, `draftMode()` are now async
- `use()` hook for unwrapping promises in Client Components
- `next/after` for post-response tasks

### Next.js 13 → 14
- Turbopack for dev (stable)
- Server Actions stable
- `next/image` sizing changes

---

## Anti-Patterns

- **Skipping codemods** → Manual migration is error-prone
- **Jumping two majors at once** → Incremental upgrades catch issues early
- **Not testing after each step** → Compound errors are hard to debug
- **Forgetting peer dependencies** → React and Next.js must stay in sync

---

## Decision Checklist

- [ ] Detected current versions from package.json
- [ ] Identified correct upgrade path (incremental if jumping majors)
- [ ] Ran applicable codemods
- [ ] Updated all peer dependencies together
- [ ] Reviewed breaking changes in official guide
- [ ] Build passes
- [ ] Tests pass
- [ ] Manual smoke test completed
