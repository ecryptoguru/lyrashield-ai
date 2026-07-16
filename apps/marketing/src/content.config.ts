import { defineCollection, reference } from "astro:content"
import { glob, file } from "astro/loaders"
import { z } from "astro/zod"

const blogImages = defineCollection({
  loader: file("src/content/blog-images/images.json"),
  schema: z.object({
    cluster: z.enum([
      "authority",
      "access-control",
      "web-execution",
      "supply-chain",
      "agent-security",
      "verification",
      "decision-operations",
    ]),
    avif: z.string().startsWith("/images/blog/library/"),
    webp: z.string().startsWith("/images/blog/library/"),
    jpeg: z.string().startsWith("/images/blog/library/"),
    og: z.string().startsWith("/images/blog/library/"),
    socialPortrait: z.string().startsWith("/images/blog/library/"),
    alt: z.string().min(20).max(180),
    width: z.literal(1600),
    height: z.literal(900),
  }),
})

const blog = defineCollection({
  loader: glob({ base: "./src/content/blog", pattern: "**/*.{md,mdx}" }),
  schema: z.object({
    title: z.string().max(70),
    description: z.string().min(70).max(160),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: reference("authors"),
    tags: z
      .array(
        z.enum([
          "vibe-coding-security",
          "access-control",
          "web-security",
          "supply-chain",
          "agent-security",
          "verification",
        ])
      )
      .min(1)
      .max(5),
    draft: z.boolean().default(true),
    heroImage: reference("blogImages"),
    canonical: z.url().optional(),
    faq: z
      .array(z.object({ q: z.string(), a: z.string() }))
      .min(2)
      .max(4)
      .optional(),
  }),
})

const authors = defineCollection({
  loader: file("src/content/authors/authors.json"),
  schema: z.object({
    name: z.string(),
    kind: z.enum(["Organization", "Person"]),
    role: z.string(),
    xUrl: z.url().optional(),
    profileUrl: z.string().startsWith("/").optional(),
    bio: z.string(),
  }),
})

export const collections = { blog, authors, blogImages }
