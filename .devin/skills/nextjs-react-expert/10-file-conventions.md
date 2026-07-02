# 10. File Conventions & Project Structure

> **Impact:** HIGH
> **Focus:** Correct project structure prevents framework misconfiguration and routing bugs.

---

## Overview

Next.js uses file-based routing and special file conventions. Understanding these is critical for correct behavior.

---

## Rule 10.1: Route Segments

| File | Purpose |
|------|---------|
| `page.tsx` | Renders a route (required for URL access) |
| `layout.tsx` | Wraps pages in a segment |
| `loading.tsx` | Shows while nested async content loads |
| `error.tsx` | Error boundary for a segment |
| `not-found.tsx` | Rendered when `notFound()` is called |
| `template.tsx` | Re-mounts on navigation (unlike layout) |
| `default.tsx` | Fallback for parallel routes |
| `route.ts` | API endpoint (no React DOM) |

## Rule 10.2: Dynamic Segments

```tsx
// app/blog/[slug]/page.tsx
// Matches: /blog/hello-world

type Props = {
  params: Promise<{ slug: string }>
}

export default async function Page({ params }: Props) {
  const { slug } = await params
  return <article>{slug}</article>
}
```

## Rule 10.3: Catch-All & Optional Catch-All

```
app/docs/[...slug]/page.tsx     // Required: /docs/a/b
app/docs/[[...slug]]/page.tsx   // Optional: /docs or /docs/a/b
```

## Rule 10.4: Route Groups (No URL Segment)

```
app/(marketing)/page.tsx   // URL: /
app/(shop)/page.tsx        // URL: /
```

Use route groups to organize without affecting the URL.

## Rule 10.5: Parallel Routes

```
app/
  @dashboard/
    page.tsx
  @team/
    page.tsx
  layout.tsx   // Receives { dashboard, team } as props
```

Parallel routes enable complex layouts with independent navigation states.

## Rule 10.6: Intercepting Routes

```
app/
  photos/
    [id]/page.tsx       // Regular page
  @modal/
    (.)photos/[id]/page.tsx  // Intercepts /photos/:id within layout
```

Use `(.)` for same-level, `(..)` for one level up, `(...)` for root-level intercepts.

## Rule 10.7: proxy.ts (Next.js 16+)

Next.js 16 renamed `middleware.ts` to `proxy.ts`.

```tsx
// src/proxy.ts or proxy.ts at root
import { type NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  // Your proxy logic
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)']
}
```

---

## Anti-Patterns

- ❌ Using `page.tsx` and `route.ts` in the same folder — they conflict
- ❌ Putting `layout.tsx` in a route group that doesn't need shared UI
- ❌ Using catch-all routes when static segments suffice
- ❌ Using `middleware.ts` in Next.js 16+ (renamed to `proxy.ts`)
