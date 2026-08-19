import { redirect } from "next/navigation"
import { prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"
import { PageHeader } from "@/components/page-header"
import { CreateLinkForm } from "./create-link-form"
import { CopyButton } from "./copy-button"

export const metadata = {
  title: "Referral Links — Affiliate Dashboard — LyraShield AI",
}

export default async function AffiliateLinksPage() {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in?callbackURL=/affiliates/links")

  const affiliate = await prisma.affiliate.findUnique({
    where: { userId: session.userId },
    select: { id: true, status: true, promoCode: true, links: true },
  })

  if (!affiliate || affiliate.status !== "APPROVED") {
    redirect("/affiliates/apply")
  }

  const primaryLink = affiliate.links[0]
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.lyrashieldai.com"

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <PageHeader
        title="Referral Links"
        description="Your primary referral link, campaign variants, and promo code."
      />

      <section className="mt-6 space-y-6">
        <div className="rounded-lg border p-6">
          <h2 className="mb-2 text-lg font-semibold">Primary Referral Link</h2>
          {primaryLink ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm">
                  {baseUrl}/?ref={primaryLink.code}
                </code>
                <CopyButton text={`${baseUrl}/?ref=${primaryLink.code}`} />
              </div>
              <p className="text-sm text-muted-foreground">
                Short link:{" "}
                <code className="rounded bg-muted px-2 py-0.5">
                  {baseUrl}/r/{primaryLink.code}
                </code>
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No primary link yet. Contact support to generate one.
            </p>
          )}
        </div>

        {affiliate.promoCode && (
          <div className="rounded-lg border p-6">
            <h2 className="mb-2 text-lg font-semibold">Promo Code</h2>
            <div className="flex items-center gap-2">
              <code className="rounded-md bg-muted px-3 py-2 text-lg font-bold">
                {affiliate.promoCode}
              </code>
              <CopyButton text={affiliate.promoCode} />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Customers enter this code at checkout. Promo code attribution overrides cookie
              attribution.
            </p>
          </div>
        )}

        <div className="rounded-lg border p-6">
          <h2 className="mb-4 text-lg font-semibold">Campaign Variants</h2>
          <div className="space-y-2">
            {affiliate.links.slice(1).map((link) => (
              <div
                key={link.id}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <div>
                  <div className="font-medium">{link.campaign ?? "Untitled campaign"}</div>
                  <code className="text-xs text-muted-foreground">
                    {baseUrl}/?ref={link.code}
                    {link.subid ? `&subid=${link.subid}` : ""}
                  </code>
                </div>
                <CopyButton
                  text={`${baseUrl}/?ref=${link.code}${link.subid ? `&subid=${link.subid}` : ""}`}
                />
              </div>
            ))}
            {affiliate.links.length <= 1 && (
              <p className="text-sm text-muted-foreground">
                No campaign variants yet. Create one below.
              </p>
            )}
          </div>

          <div className="mt-4">
            <CreateLinkForm affiliateId={affiliate.id} />
          </div>
        </div>

        <div className="rounded-lg border p-6">
          <h2 className="mb-2 text-lg font-semibold">Click Test Tool</h2>
          <p className="text-sm text-muted-foreground">
            Test your referral link by visiting it in a new incognito window. The click will appear
            in your Activity tab within a few minutes.
          </p>
        </div>
      </section>
    </div>
  )
}
