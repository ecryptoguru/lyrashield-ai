import { redirect } from "next/navigation"
import { prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"
import { PageHeader } from "@/components/page-header"

export const metadata = {
  title: "Marketing Assets — Affiliate Dashboard — LyraShield AI",
}

const ASSETS = [
  {
    category: "Logos",
    items: [
      { name: "LyraShield Logo (PNG, transparent)", url: "/assets/lyrashield-logo.png" },
      { name: "LyraShield Logo (SVG)", url: "/assets/lyrashield-logo.svg" },
      { name: "LyraShield Mark (icon only)", url: "/assets/lyrashield-mark.svg" },
    ],
  },
  {
    category: "Banners",
    items: [
      { name: "1200×630 OG banner", url: "/assets/banner-1200x630.png" },
      { name: "1080×1080 Square banner", url: "/assets/banner-1080x1080.png" },
      { name: "300×250 Medium rectangle", url: "/assets/banner-300x250.png" },
      { name: "728×90 Leaderboard", url: "/assets/banner-728x90.png" },
    ],
  },
  {
    category: "Screenshots",
    items: [
      { name: "Dashboard overview", url: "/assets/screenshot-dashboard.png" },
      { name: "Scan results", url: "/assets/screenshot-scan.png" },
      { name: "Evidence Vault", url: "/assets/screenshot-evidence.png" },
      { name: "Assurance Report", url: "/assets/screenshot-report.png" },
    ],
  },
  {
    category: "Email Swipes",
    items: [
      { name: "Launch announcement email", url: "/assets/email-launch.md" },
      { name: "Newsletter mention template", url: "/assets/email-newsletter.md" },
      { name: "Tutorial / how-to email", url: "/assets/email-tutorial.md" },
    ],
  },
]

export default async function AffiliateAssetsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const affiliate = await prisma.affiliate.findUnique({
    where: { userId: session.userId },
    select: { id: true, status: true },
  })

  if (!affiliate || affiliate.status !== "APPROVED") {
    redirect("/affiliates/apply")
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <PageHeader
        title="Marketing Assets"
        description="Logos, banners, screenshots, email swipes, and brand guidelines."
      />

      <section className="mt-6 space-y-8">
        {ASSETS.map((group) => (
          <div key={group.category}>
            <h2 className="mb-4 text-lg font-semibold">{group.category}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.items.map((item) => (
                <a
                  key={item.url}
                  href={item.url}
                  className="flex items-center justify-between rounded-md border p-3 hover:bg-muted"
                >
                  <span className="text-sm">{item.name}</span>
                  <span className="text-xs text-muted-foreground">Download →</span>
                </a>
              ))}
            </div>
          </div>
        ))}

        <div>
          <h2 className="mb-4 text-lg font-semibold">Brand Guidelines</h2>
          <div className="rounded-lg border p-6 text-sm text-muted-foreground">
            <ul className="space-y-2">
              <li>
                <strong>Brand name:</strong> Always use &quot;LyraShield AI&quot; (with space).
                Never &quot;LyraShieldAI&quot; or &quot;Lyra Shield&quot;.
              </li>
              <li>
                <strong>Logo usage:</strong> Maintain clear space around the logo equal to the
                height of the shield mark. Never stretch, recolor, or add effects.
              </li>
              <li>
                <strong>Colors:</strong> Primary #0066FF, Dark #0A0A0A, Light #FAFAFA. Do not use
                unauthorized color variations.
              </li>
              <li>
                <strong>Tone:</strong> Evidence-backed, technical, honest. Avoid hyperbolic claims,
                security guarantees, or benchmark comparisons.
              </li>
              <li>
                <strong>Prohibited:</strong> Do not bid on the brand name &quot;LyraShield&quot; in
                search ads. Do not use misleading coupons or discounts not provided by LyraShield.
              </li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  )
}
