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
  schema: z
    .object({
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
      // Optional technical-review attribution. Both fields must appear together
      // (or neither): a reviewer with no date is an unverifiable claim and a
      // review date with no reviewer is a meaningless stamp. Only set them when a
      // real named technical review happened — see /blog/editorial-policy.
      reviewer: reference("authors").optional(),
      reviewedDate: z.coerce.date().optional(),
    })
    .superRefine((data, ctx) => {
      if ((data.reviewer === undefined) !== (data.reviewedDate === undefined)) {
        ctx.addIssue({
          code: "custom",
          message: "reviewer and reviewedDate must be set together or not at all",
        })
      }
    }),
})

const compare = defineCollection({
  loader: glob({ base: "./src/content/compare", pattern: "**/*.{md,mdx}" }),
  schema: z.object({
    title: z.string().min(20).max(90),
    description: z.string().min(70).max(160),
    competitor: z.string().min(2).max(60),
    heading: z.string().min(10).max(70),
    disclaimer: z.string().min(80),
    updatedDate: z.coerce.date(),
    draft: z.boolean().default(true),
    pricingLadder: z.literal(true),
    // Wave 8 (D9): a compare page is the canonical home for competitor facts, so
    // it declares that it carries competitor claims and names the competitor's
    // own domain. The compare validator then requires a `## Sources` block with a
    // citation on that domain. See scripts/compare-validation-lib.mjs.
    competitorClaims: z.boolean().default(true),
    competitorDomain: z.string().min(3).optional(),
    canonical: z.url().optional(),
    faq: z
      .array(z.object({ q: z.string(), a: z.string() }))
      .min(2)
      .max(4),
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

export const collections = { blog, authors, blogImages, compare }
