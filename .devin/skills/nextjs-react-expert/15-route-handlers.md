# 15. Route Handlers

> **Impact:** MEDIUM-HIGH
> **Focus:** API routes with `route.ts` and when to use them vs Server Actions.

---

## Overview

Route handlers let you create API endpoints in the App Router using `route.ts` files.

---

## Rule 15.1: Basic Route Handler

```tsx
// app/api/users/route.ts
import { NextResponse } from 'next/server'

export async function GET() {
  const users = await db.user.findMany()
  return NextResponse.json(users)
}

export async function POST(request: Request) {
  const body = await request.json()
  const user = await db.user.create({ data: body })
  return NextResponse.json(user, { status: 201 })
}
```

## Rule 15.2: Dynamic Route Handlers

```tsx
// app/api/users/[id]/route.ts
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await db.user.findUnique({ where: { id } })

  if (!user) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json(user)
}
```

## Rule 15.3: Route Handler vs Server Action

| Use Route Handler When | Use Server Action When |
|------------------------|------------------------|
| External API consumers need access | Only internal app usage |
| You need full Request/Response control | Form submission from Client Component |
| CORS or custom headers required | Direct database mutation from UI |
| File uploads with multer-like handling | Simple CRUD from forms |

## Rule 15.4: GET Handler Conflicts with page.tsx

A folder cannot have both `page.tsx` and `route.ts` with a GET handler:

```
app/api/users/
  page.tsx     // ❌ Conflicts with route.ts GET
  route.ts     // API endpoint
```

**Solution:** Use separate folders:

```
app/
  api/
    users/
      route.ts    // GET /api/users
  users/
    page.tsx       // Renders /users page
```

## Rule 15.5: Environment Behavior

Route handlers run in the Node.js runtime by default. They do NOT have access to React DOM or browser APIs.

```tsx
export const runtime = 'edge'  // Optional: switch to Edge runtime
```

---

## Anti-Patterns

- ❌ `page.tsx` and `route.ts` in the same folder
- ❌ Using Route Handlers for internal-only operations (use Server Actions)
- ❌ Not validating input in Route Handlers
- ❌ Returning generic 500 errors without proper error handling
