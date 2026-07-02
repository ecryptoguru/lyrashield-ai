# 17. Debug Tricks

> **Impact:** MEDIUM
> **Focus:** Developer experience utilities for faster debugging and iteration.

---

## Overview

Built-in and configuration-based tricks to speed up Next.js debugging.

---

## Rule 17.1: MCP Endpoint for AI Debugging

Next.js provides an MCP endpoint for AI-assisted debugging:

```bash
# Enable MCP server for AI debugging
NEXT_MCP=1 npm run dev
```

This exposes an MCP endpoint that AI tools (like Claude Code) can connect to for:
- Inspecting build output
- Checking route information
- Analyzing bundle composition

## Rule 17.2: Rebuild Specific Routes

```bash
# Debug-build specific paths only
next build --debug-build-paths /dashboard,/settings
```

Useful when you only need to test specific routes without full rebuild.

## Rule 17.3: Turbopack for Faster Dev

```bash
# Use Turbopack in development
next dev --turbopack
```

- 10x faster HMR than Webpack
- Faster cold starts
- Compatible with most projects as of Next.js 15+

## Rule 17.4: Bundle Analysis

```bash
# Analyze bundle size
npm install @next/bundle-analyzer
```

```ts
// next.config.ts
import withBundleAnalyzer from '@next/bundle-analyzer'

export default withBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true'
})({
  // your config
})
```

```bash
ANALYZE=true npm run build
```

## Rule 17.5: Debug Logging

```ts
// next.config.ts
export default {
  logging: {
    fetches: {
      fullUrl: true
    }
  }
}
```

Shows full fetch URLs in server logs, helping trace data fetching.

---

## Anti-Patterns

- ❌ Analyzing bundles in production builds (use local `ANALYZE=true`)
- ❌ Using `--debug-build-paths` in CI/CD
- ❌ Forgetting to disable bundle analyzer after debugging
