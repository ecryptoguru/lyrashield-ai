#!/usr/bin/env node

/**
 * Render the static social/OG cards for the non-blog surfaces.
 *
 * Design-time tool, not a build step: it launches Chromium through the
 * Playwright dependency the browser tests already use, renders one HTML card
 * per entry at exactly 1200x630, and writes the PNGs into `public/og/`. The
 * output is committed, so CI never runs this — re-run it only when the copy or
 * the design tokens change:
 *
 *   node scripts/generate-og-cards.mjs
 *
 * Blog posts keep their own per-post cards from the image catalogue; this
 * script covers the pages that previously all shared /og/og-default.png.
 */

import { readFile, writeFile } from "node:fs/promises"
import { chromium } from "@playwright/test"

const OUT_DIR = new URL("../public/og/", import.meta.url)
const FONT_DIR = new URL("../node_modules/@fontsource-variable/", import.meta.url)

// DESIGN.md tokens — dark surface, single cyan accent, mono machine labels.
const COLORS = {
  bg: "#08111c",
  raised: "#0e1a28",
  border: "#203246",
  text: "#edf6fb",
  muted: "#91a7b8",
  accent: "#54d6df",
}

export const OG_CARDS = [
  {
    slug: "home",
    eyebrow: "RELEASE ASSURANCE",
    title: "Ship AI-built apps with evidence, not hope.",
    path: "lyrashieldai.com",
  },
  {
    slug: "pricing",
    eyebrow: "PRICING",
    title: "Cloud and Local plans",
    path: "lyrashieldai.com/pricing",
  },
  {
    slug: "compare",
    eyebrow: "COMPARISONS",
    title: "LyraShield AI vs security tools",
    path: "lyrashieldai.com/compare",
  },
  {
    slug: "tools",
    eyebrow: "FREE TOOLS",
    title: "Browser-local security tools",
    path: "lyrashieldai.com/tools",
  },
  {
    slug: "docs",
    eyebrow: "DOCS",
    title: "Connect LyraShield to your tools",
    path: "lyrashieldai.com/docs/integrations",
  },
  {
    slug: "agents",
    eyebrow: "FOR CODING AGENTS",
    title: "Release assurance your agent can act on",
    path: "lyrashieldai.com/agents",
  },
  {
    slug: "methodology",
    eyebrow: "METHODOLOGY",
    title: "What a result knows — and what it does not",
    path: "lyrashieldai.com/methodology",
  },
  {
    slug: "webmcp",
    eyebrow: "WEBMCP",
    title: "WebMCP Assurance",
    path: "lyrashieldai.com/webmcp",
  },
  {
    slug: "scan",
    eyebrow: "FREE LITE CHECK",
    title: "A passive URL check, no signup",
    path: "lyrashieldai.com/scan",
  },
  {
    slug: "ai-safety",
    eyebrow: "AI SAFETY",
    title: "Prompt-injection guard evaluation",
    path: "lyrashieldai.com/ai-safety",
  },
  {
    slug: "blog",
    eyebrow: "GUIDES",
    title: "Security guidance for AI-built apps",
    path: "lyrashieldai.com/blog",
  },
  {
    slug: "research",
    eyebrow: "RESEARCH",
    title: "Security patterns in AI-built applications",
    path: "lyrashieldai.com/research",
  },
  {
    slug: "evidence-vault",
    eyebrow: "EVIDENCE VAULT",
    title: "Proof the scan cannot produce",
    path: "lyrashieldai.com/evidence-vault",
  },
  {
    slug: "vibe-security-50",
    eyebrow: "CONTROLS",
    title: "The Vibe Security 50",
    path: "lyrashieldai.com/vibe-security-50",
  },
  {
    slug: "company",
    eyebrow: "COMPANY",
    title: "Evidence over promises",
    path: "lyrashieldai.com/about",
  },
]

async function fontFace(family, file) {
  const data = await readFile(new URL(file, FONT_DIR))
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${data.toString("base64")}) format("woff2")}`
}

export async function renderCards({ write = true } = {}) {
  const faces = [
    await fontFace("Bricolage", "bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2"),
    await fontFace("JetBrains", "jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"),
    await fontFace("Inter", "inter/files/inter-latin-wght-normal.woff2"),
  ].join("")

  const logo = await readFile(new URL("../public/logo.svg", import.meta.url), "utf8")
  const logoData = `data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`

  const browser = await chromium.launch()
  const written = []
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    })

    for (const card of OG_CARDS) {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${faces}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1200px;height:630px;overflow:hidden;background:${COLORS.bg};color:${COLORS.text};
  font-family:Inter,sans-serif;position:relative;display:flex;flex-direction:column;
  justify-content:space-between;padding:64px 72px}
.glow{position:absolute;inset:0;background:
  radial-gradient(ellipse 60% 55% at 12% 0%, rgba(84,214,223,.16), transparent 62%),
  radial-gradient(ellipse 50% 45% at 92% 100%, rgba(84,214,223,.10), transparent 60%)}
.grid{position:absolute;inset:0;opacity:.5;background-image:
  linear-gradient(${COLORS.border} 1px, transparent 1px),
  linear-gradient(90deg, ${COLORS.border} 1px, transparent 1px);
  background-size:120px 120px;mask-image:radial-gradient(ellipse 80% 70% at 50% 40%, #000, transparent 78%)}
.frame{position:absolute;inset:28px;border:1px solid ${COLORS.border};border-radius:20px}
header{position:relative;display:flex;align-items:center;gap:16px}
header img{width:44px;height:44px;border-radius:12px;border:1px solid ${COLORS.border};
  background:${COLORS.raised};padding:6px}
.brand{font-family:Bricolage,sans-serif;font-weight:800;font-size:26px;letter-spacing:-.02em}
.beta{font-family:JetBrains,monospace;font-size:12px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:${COLORS.accent};border:1px solid rgba(84,214,223,.5);
  border-radius:999px;padding:4px 10px}
main{position:relative;max-width:940px}
.eyebrow{font-family:JetBrains,monospace;font-size:15px;font-weight:600;letter-spacing:.22em;
  text-transform:uppercase;color:${COLORS.accent}}
h1{font-family:Bricolage,sans-serif;font-weight:800;letter-spacing:-.045em;line-height:.98;
  margin-top:22px;font-size:${card.title.length > 42 ? 62 : 74}px}
footer{position:relative;display:flex;align-items:center;justify-content:space-between;
  font-family:JetBrains,monospace;font-size:15px;color:${COLORS.muted};letter-spacing:.02em}
.dot{display:inline-block;width:9px;height:9px;border-radius:999px;background:${COLORS.accent};
  margin-right:10px;box-shadow:0 0 14px rgba(84,214,223,.9)}
</style></head><body>
<div class="glow"></div><div class="grid"></div><div class="frame"></div>
<header><img src="${logoData}" alt=""><span class="brand">LyraShield AI</span>
  <span class="beta">Open beta</span></header>
<main><p class="eyebrow">${card.eyebrow}</p><h1>${card.title}</h1></main>
<footer><span><span class="dot"></span>Evidence is limited to the authorized scope.</span>
  <span>${card.path}</span></footer>
</body></html>`

      await page.setContent(html, { waitUntil: "load" })
      await page.evaluate(() => document.fonts.ready)
      const buffer = await page.screenshot({ type: "png" })
      if (write) await writeFile(new URL(`${card.slug}.png`, OUT_DIR), buffer)
      written.push(card.slug)
    }
  } finally {
    await browser.close()
  }
  return written
}

const invoked = process.argv[1]?.endsWith("generate-og-cards.mjs")
if (invoked) {
  const slugs = await renderCards()
  console.log(`Rendered ${slugs.length} OG cards: ${slugs.join(", ")}`)
}
