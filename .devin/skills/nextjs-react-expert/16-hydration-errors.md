# 16. Hydration Errors & Suspense Boundaries

> **Impact:** HIGH
> **Focus:** Preventing and fixing hydration mismatches between server and client renders.

---

## Overview

Hydration errors occur when the server-rendered HTML doesn't match what React expects on the client.

---

## Rule 16.1: Common Causes

| Cause | Example |
|-------|---------|
| Browser-only APIs | `window`, `document`, `localStorage` in Server Components |
| Date/Time | `new Date()` renders differently on server vs client (timezone) |
| Random values | `Math.random()` in render path |
| Invalid HTML | `<p>` inside `<div>` (block inside inline) |
| Third-party scripts | Google Analytics injecting elements |

## Rule 16.2: Fixing Browser-Only APIs

```tsx
// Bad: Breaks hydration
export default function Component() {
  return <div>{window.innerWidth}</div>
}

// Good: Use in Client Component with useEffect
'use client'

import { useEffect, useState } from 'react'

export default function Component() {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    setWidth(window.innerWidth)
  }, [])

  return <div>{width}</div>
}
```

## Rule 16.3: Fixing Date/Time Mismatches

```tsx
// Bad: Server timezone vs client timezone
export default function Component() {
  return <div>{new Date().toLocaleString()}</div>
}

// Good: Only render on client
'use client'

import { useEffect, useState } from 'react'

export default function Component() {
  const [date, setDate] = useState<string>()

  useEffect(() => {
    setDate(new Date().toLocaleString())
  }, [])

  return <div>{date ?? 'Loading...'}</div>
}
```

## Rule 16.4: Suspense Boundaries

Wrap dynamic content in `<Suspense>` for progressive rendering:

```tsx
import { Suspense } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

export default function Page() {
  return (
    <main>
      <h1>Static Header</h1>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <SlowComponent />
      </Suspense>
    </main>
  )
}
```

## Rule 16.5: CSR Bailout

Hooks like `useSearchParams` and `usePathname` cause Client-Side Rendering bailout:

```tsx
'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

function Search() {
  const searchParams = useSearchParams()
  return <div>Query: {searchParams.get('q')}</div>
}

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <Search />
    </Suspense>
  )
}
```

Always wrap components using `useSearchParams` in `<Suspense>`.

---

## Anti-Patterns

- ❌ Using `window`/`document` in Server Components
- ❌ Rendering `new Date()` without client-only guard
- ❌ No Suspense around slow components
- ❌ Using `useSearchParams` without Suspense boundary
- ❌ Invalid HTML nesting (`<div>` inside `<p>`)
