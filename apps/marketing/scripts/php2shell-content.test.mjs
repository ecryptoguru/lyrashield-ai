import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { markdownWordCount, parseArticle, validateArticleText } from "./blog-validation-lib.mjs"
import { findMdxHazards } from "./blog-mdx-lib.mjs"

const articles = [
  ["php2shell-explained", "php2shell-overview"],
  ["check-php-version-php2shell", "php2shell-version"],
  ["patch-php2shell-docker-fpm-apache", "php2shell-patching"],
  ["php2shell-wordpress-hosting", "php2shell-wordpress"],
  ["cve-2026-115560-session-upload-progress", "php2shell-session"],
  ["php2shell-still-flagged-after-updating", "php2shell-backports"],
  ["php2shell-investigate-earlier-compromise", "php2shell-investigation"],
]

function article(slug) {
  const path = fileURLToPath(new URL(`../src/content/blog/${slug}.mdx`, import.meta.url))
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Repository-owned slug list determines this fixture path.
  const raw = readFileSync(path, "utf8")
  return { raw, ...parseArticle(raw) }
}

for (const [slug, heroImage] of articles) {
  test(`${slug}: editorial length and publishing contract`, () => {
    const { raw, data, body } = article(slug)
    // Count the authored body alone. Frontmatter, code blocks and any future
    // bibliography cannot satisfy the requested 1,200-1,500 editorial words.
    const editorial = body.replace(/^## (?:Sources|References|Bibliography)\s*$[\s\S]*/m, "")
    const count = markdownWordCount(editorial)
    assert.ok(count >= 1200 && count <= 1500, `${count} editorial words`)
    assert.equal(data.pubDate, "2026-10-24T00:00:00+05:30")
    assert.equal(data.author, "lyrashield-team")
    assert.equal(data.draft, false)
    assert.equal(data.heroImage, heroImage)
    assert.ok(data.faq.length >= 2 && data.faq.length <= 4)
    assert.deepEqual(validateArticleText(raw), [])
    assert.deepEqual(findMdxHazards(body), [])
  })

  test(`${slug}: useful next steps retain their evidence limits`, () => {
    const { body } = article(slug)
    assert.ok(body.includes("](/tools/php2shell-checker)"))
    assert.ok(body.includes("](/scan)"))
    assert.ok(body.includes("](https://app.lyrashieldai.com/sign-up)"))
    assert.match(body, /conditionall?y runs? PHP checks|can conditionally run PHP checks/)
    assert.match(body, /Standard and Deep/)
    assert.match(body, /cannot attest|do not attest/)
  })
}

test("October 23 article retains serializer preconditions and no invented fixed release", () => {
  const { body } = article("cve-2026-115560-session-upload-progress")
  for (const value of ["php_binary", "php_serialize", "ini_set()", "session_start()"])
    assert.ok(body.includes(value), `missing precondition: ${value}`)
  assert.match(body, /does not name a fixed release for CVE-2026-115560/)
  assert.match(body, /before request parsing/)
  assert.match(body, /restart every affected worker/i)
})

test("backport article binds vendor examples to exact package evidence", () => {
  const { body } = article("php2shell-still-flagged-after-updating")
  assert.ok(body.includes("https://cloudlinux.statuspage.io/incidents/zl0vt1yq3dj5"))
  assert.ok(body.includes("ea-php84 8.4.26-2.el8.cloudlinux.1"))
  assert.ok(body.includes("alt-php85 8.5.11-5"))
  assert.match(body, /not a general exemption/)
  assert.match(body, /package family, release revision and operating system/)
  assert.ok(body.includes("](/blog/php2shell-investigate-earlier-compromise)"))
})

test("historical investigation separates attempts, shared indicators and telemetry gaps", () => {
  const { body } = article("php2shell-investigate-earlier-compromise")
  assert.ok(
    body.includes(
      "https://aws.amazon.com/blogs/security/amazon-threat-intelligence-identifies-php2shell-exploitation-prior-to-public-disclosure-in-madpot/"
    )
  )
  assert.match(body, /at least October 17, 2026/)
  assert.match(body, /success of the observed attempts against real-world systems remains unclear/)
  assert.match(body, /shared anonymization infrastructure/)
  assert.match(body, /recommends investigating observations rather than simply blocking/)
  assert.match(body, /without POST bodies/)
  assert.match(body, /quiet log as clearance/)
  assert.ok(body.includes("](/blog/php2shell-still-flagged-after-updating)"))
})
