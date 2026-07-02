# 14. Metadata, Images, and Fonts

> **Impact:** HIGH
> **Focus:** SEO, performance, and visual consistency through built-in Next.js optimizations.

---

## Overview

Next.js provides built-in optimizations for metadata, images, and fonts.

---

## Rule 14.1: Metadata

### Static Metadata

```tsx
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'My Page',
  description: 'Page description',
  openGraph: {
    title: 'My Page',
    images: ['/og-image.jpg']
  }
}
```

### Dynamic Metadata

```tsx
import type { Metadata } from 'next'

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const post = await getPost(slug)
  return { title: post.title }
}
```

### OG Image Generation

```tsx
// app/opengraph-image.tsx
import { ImageResponse } from 'next/og'

export default async function Image() {
  return new ImageResponse(
    <div style={{ display: 'flex', fontSize: 40 }}>Hello</div>
  )
}
```

## Rule 14.2: Image Optimization

### Always Use `next/image`

```tsx
import Image from 'next/image'

<Image
  src="/photo.jpg"
  alt="Description"
  width={800}
  height={600}
  priority  // For above-the-fold images
/>
```

### Remote Images

```tsx
// next.config.ts
export default {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.example.com' }
    ]
  }
}
```

```tsx
<Image
  src="https://cdn.example.com/photo.jpg"
  alt="Description"
  width={800}
  height={600}
  sizes="(max-width: 768px) 100vw, 50vw"
/>
```

### Key Attributes

| Attribute | Purpose |
|-----------|---------|
| `priority` | Preload LCP images |
| `sizes` | Responsive breakpoints |
| `placeholder="blur"` | Blur placeholder |
| `quality` | JPEG/WebP quality (1-100) |

## Rule 14.3: Font Optimization

```tsx
import { Inter } from 'next/font/google'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter'
})

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className={inter.className}>{children}</body>
    </html>
  )
}
```

**With Tailwind:**

```ts
// tailwind.config.ts
export default {
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif']
      }
    }
  }
}
```

---

## Anti-Patterns

- ❌ Using native `<img>` instead of `next/image`
- ❌ Forgetting `alt` attributes
- ❌ Not configuring `sizes` for responsive images
- ❌ Loading Google Fonts via `<link>` instead of `next/font`
- ❌ Hardcoding meta tags in `head.tsx` instead of `metadata` export
