# 12. Async Patterns (Next.js 15+)

> **Impact:** CRITICAL
> **Focus:** Next.js 15+ makes `params`, `searchParams`, `cookies()`, and `headers()` asynchronous. Incorrect usage causes build and runtime errors.

---

## Overview

Breaking API change in Next.js 15+: several APIs now return Promises.

---

## Rule 12.1: Async Params and SearchParams

```tsx
type Props = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ query?: string }>
}

export default async function Page({ params, searchParams }: Props) {
  const { slug } = await params
  const { query } = await searchParams
  return <div>{slug}: {query}</div>
}
```

## Rule 12.2: Async Cookies and Headers

```tsx
import { cookies, headers } from 'next/headers'

export default async function Page() {
  const cookieStore = await cookies()
  const headersList = await headers()

  const theme = cookieStore.get('theme')
  const userAgent = headersList.get('user-agent')

  return <div>Theme: {theme?.value}</div>
}
```

## Rule 12.3: Client Component with React.use()

```tsx
'use client'

import { use } from 'react'

type Props = {
  params: Promise<{ slug: string }>
}

export default function Page({ params }: Props) {
  const { slug } = use(params)
  return <div>{slug}</div>
}
```

## Rule 12.4: generateMetadata is Async

```tsx
import type { Metadata } from 'next'

type Props = {
  params: Promise<{ slug: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  return { title: slug }
}
```

## Rule 12.5: Route Handler Params

```tsx
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const data = await db.findById(id)
  return Response.json(data)
}
```

---

## Migration Codemod

```bash
npx @next/codemod@latest next-async-request-api .
```

## Anti-Patterns

- ❌ Accessing `params.slug` directly without `await`
- ❌ Calling `cookies().get()` without `await cookies()` first
- ❌ Using `useEffect` to read params in Client Components (use `use()` instead)
- ❌ Forgetting to make `generateMetadata` async
