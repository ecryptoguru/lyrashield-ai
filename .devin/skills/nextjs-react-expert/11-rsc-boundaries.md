# 11. React Server Component Boundaries

> **Impact:** CRITICAL
> **Focus:** Correctly separating Server and Client Components prevents hydration errors and unnecessary JavaScript bundles.

---

## Overview

Next.js App Router defaults to Server Components. Understanding when and how to use Client Components is essential.

---

## Rule 11.1: Server Components Are the Default

```tsx
// This is a Server Component by default
export default async function ProductList() {
  const products = await db.product.findMany()
  return <ul>{products.map(p => <li key={p.id}>{p.name}</li>)}</ul>
}
```

**Benefits:**
- Zero client JavaScript shipped
- Direct backend access (DB, filesystem)
- Automatic caching with `use cache`

## Rule 11.2: Add `'use client'` Only When Needed

Mark as Client Component ONLY when using:
- Browser APIs (`window`, `document`, `localStorage`)
- React hooks (`useState`, `useEffect`, `useContext`)
- Event handlers (`onClick`, `onSubmit`)
- Custom hooks that use browser APIs

```tsx
'use client'

import { useState } from 'react'

export default function Counter() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>
}
```

## Rule 11.3: Async Client Components Are Invalid

```tsx
// INVALID — Client Components cannot be async
'use client'
export default async function BadComponent() {
  const data = await fetchData()  // ❌ Hydration error
}

// VALID — Keep async in Server Components
export default async function GoodServerComponent() {
  const data = await fetchData()  // ✅ Runs on server
  return <ClientView data={data} />
}
```

## Rule 11.4: Props Must Be Serializable

Server Components can pass props to Client Components, but props must be serializable:

```tsx
// Server Component
import ClientButton from './ClientButton'

export default async function Page() {
  const user = await getUser()
  return <ClientButton user={user} />  // ✅ JSON-serializable
}

// INVALID
<ClientButton onClick={() => alert('hi')} />  // ❌ Functions aren't serializable
```

## Rule 11.5: Server Actions with `'use server'`

```tsx
// Server action file
'use server'

export async function createPost(formData: FormData) {
  // Runs securely on the server
  await db.post.create({ data: Object.fromEntries(formData) })
}
```

```tsx
// Client Component
'use client'

import { createPost } from './actions'

export default function PostForm() {
  return <form action={createPost}>...</form>
}
```

---

## Decision Tree

```
Does it need browser APIs or interactivity?
  → YES → 'use client'
  → NO → Server Component (default)

Is it fetching data?
  → YES → Must be Server Component (or use SWR in Client)
  → NO → Could be either
```

## Anti-Patterns

- ❌ `'use client'` at the top of every file
- ❌ `useEffect` + `fetch` in Client Components when Server Component works
- ❌ Passing functions/non-serializable data from Server to Client Components
- ❌ Making Client Components async
