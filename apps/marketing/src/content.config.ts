import { defineCollection, reference } from "astro:content"
import { glob, file } from "astro/loaders"
import { z } from "astro/zod"

const blog = defineCollection({
  loader: glob({ base: "./src/content/blog", pattern: "**/*.{md,mdx}" }),
  schema: z.object({
    title: z.string().max(70),
    description: z.string().min(70).max(160),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: reference("authors"),
    tags: z.array(z.string()).max(5),
    draft: z.boolean().default(true),
    heroImage: z.string().optional(),
    canonical: z.url().optional(),
    faq: z.array(z.object({ q: z.string(), a: z.string() })).optional(),
  }),
})

const authors = defineCollection({
  loader: file("src/content/authors/authors.json"),
  schema: z.object({
    name: z.string(),
    role: z.string(),
    xUrl: z.url().optional(),
    bio: z.string(),
  }),
})

export const collections = { blog, authors }
