# 13. Directives Reference

> **Impact:** HIGH
> **Focus:** Correct use of `'use client'`, `'use server'`, and `'use cache'` directives.

---

## Overview

Next.js/React directives control where code runs and how it's cached.

---

## Rule 13.1: `'use client'`

Marks a file as a Client Component.

```tsx
'use client'

import { useState } from 'react'

export default function Interactive() {
  const [open, setOpen] = useState(false)
  return <button onClick={() => setOpen(!open)}>Toggle</button>
}
```

**When to use:**
- Browser APIs needed
- React hooks (`useState`, `useEffect`)
- Event handlers
- Custom hooks using browser APIs

## Rule 13.2: `'use server'`

Marks functions as Server Actions.

```tsx
// actions.ts
'use server'

export async function submitForm(formData: FormData) {
  'use server'
  // Runs on server, never sent to client
  await db.create({ data: Object.fromEntries(formData) })
}
```

**Inline in Client Components:**

```tsx
'use client'

export default function Form() {
  async function handleSubmit(formData: FormData) {
    'use server'
    await db.create({ data: Object.fromEntries(formData) })
  }

  return <form action={handleSubmit}>...</form>
}
```

## Rule 13.3: `'use cache'` (Next.js 16+)

Replaces `unstable_cache`. Caches Server Components or functions.

```tsx
async function getData(id: string) {
  'use cache'
  cacheLife('minutes')
  return await db.findById(id)
}
```

**File-level:**

```tsx
'use cache'

export default async function Page() {
  const data = await fetchData()  // Entire component cached
  return <div>{data}</div>
}
```

**With cacheTag:**

```tsx
async function getProducts() {
  'use cache'
  cacheTag('products')
  return await db.product.findMany()
}
```

---

## Quick Reference

| Directive | Scope | Runs On |
|-----------|-------|---------|
| `'use client'` | File | Browser |
| `'use server'` | Function | Server |
| `'use cache'` | Function/File | Server + Cache |

## Anti-Patterns

- ❌ `'use client'` in a file that only renders static content
- ❌ `'use server'` on a function that returns JSX (use Server Component instead)
- ❌ `'use cache'` on functions with side effects
- ❌ Mixing `'use client'` and server data fetching without `use()` or Suspense
