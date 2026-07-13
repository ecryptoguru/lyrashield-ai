import { getPublicScorecard } from "@lyrashield/db"

export async function GET(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const scorecard = await getPublicScorecard(slug)
  if (!scorecard) return new Response(null, { status: 404 })

  const grade = scorecard.payload.grade.replace("_PLUS", "+")
  const label = "LyraShield scanned"
  const labelWidth = 124
  const gradeWidth = grade === "A+" ? 38 : 32
  const width = labelWidth + gradeWidth
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28" role="img" aria-label="${label}: grade ${grade}">
  <title>${label}: grade ${grade}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-opacity=".08"/></linearGradient>
  <clipPath id="r"><rect width="${width}" height="28" rx="6"/></clipPath>
  <g clip-path="url(#r)"><rect width="${labelWidth}" height="28" fill="#14211e"/><rect x="${labelWidth}" width="${gradeWidth}" height="28" fill="#178f70"/><rect width="${width}" height="28" fill="url(#s)"/></g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Arial,sans-serif" font-size="11" font-weight="600"><text x="${labelWidth / 2}" y="18">${label}</text><text x="${labelWidth + gradeWidth / 2}" y="18">${grade}</text></g>
</svg>`
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=60",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  })
}
