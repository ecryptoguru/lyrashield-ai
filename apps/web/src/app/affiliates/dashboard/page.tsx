import { redirect } from "next/navigation"
import { prisma, Prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"
import { PageHeader } from "@/components/page-header"
import { AffiliateKpiCards } from "./kpi-cards"
import { DateFilter } from "./date-filter"

export const metadata = {
  title: "Affiliate Dashboard — LyraShield AI",
}

export default async function AffiliateDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>
}) {
  const session = await getCachedSession()
  if (!session) return null

  const affiliate = await prisma.affiliate.findUnique({
    where: { userId: session.userId },
    select: {
      id: true,
      status: true,
      promoCode: true,
      activeReferrals: true,
      baseRateBps: true,
      tierRateBps: true,
      tierThreshold: true,
      reservePct: true,
      reserveUntil: true,
    },
  })

  if (!affiliate || affiliate.status !== "APPROVED") {
    redirect("/affiliates/apply")
  }

  const params = await searchParams
  const range = params.range ?? "30d"
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30
  // eslint-disable-next-line react-hooks/purity -- server component, Date.now() is safe here
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Fetch aggregates
  const [
    clicksAgg,
    uniqueClicksAgg,
    signups,
    conversions,
    activeSubs,
  ] = await Promise.all([
    prisma.click.count({
      where: { affiliateId: affiliate.id, clickedAt: { gte: since } },
    }),
    prisma.click.findMany({
      where: { affiliateId: affiliate.id, clickedAt: { gte: since } },
      select: { visitorId: true },
      distinct: ["visitorId"],
    }),
    prisma.user.count({
      where: { affiliate: { id: affiliate.id }, createdAt: { gte: since } },
    }),
    prisma.conversion.count({
      where: {
        affiliateId: affiliate.id,
        occurredAt: { gte: since },
        commissions: { some: { status: { not: "EXPIRED" } } },
      },
    }),
    prisma.affiliateSubscription.count({
      where: { affiliateId: affiliate.id, isActive: true },
    }),
  ])

  // Commission status breakdown
  const [pending, available, paid, lifetime] = await Promise.all([
    prisma.commission.aggregate({
      where: { affiliateId: affiliate.id, status: "PENDING" },
      _sum: { amount: true },
    }),
    prisma.commission.aggregate({
      where: { affiliateId: affiliate.id, status: "AVAILABLE" },
      _sum: { amount: true },
    }),
    prisma.commission.aggregate({
      where: { affiliateId: affiliate.id, status: "PAID" },
      _sum: { amount: true },
    }),
    prisma.commission.aggregate({
      where: {
        affiliateId: affiliate.id,
        status: { in: ["PAID", "AVAILABLE", "PENDING"] },
      },
      _sum: { amount: true },
    }),
  ])

  const uniqueClicks = uniqueClicksAgg.filter((c) => c.visitorId !== null).length
  const conversionRate = clicksAgg > 0 ? ((conversions / clicksAgg) * 100).toFixed(2) : "0"
  const epc = clicksAgg > 0
    ? (Number((lifetime._sum.amount ?? new Prisma.Decimal(0)).toString()) / clicksAgg).toFixed(2)
    : "0"

  const tierProgress = Math.min(affiliate.activeReferrals, affiliate.tierThreshold)
  const atTier = affiliate.activeReferrals >= affiliate.tierThreshold

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader
        title="Affiliate Dashboard"
        description="Track your referral performance and earnings."
      />

      <DateFilter current={range} />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <AffiliateKpiCards
          clicks={clicksAgg}
          uniqueClicks={uniqueClicks}
          signups={signups}
          conversions={conversions}
          conversionRate={conversionRate}
          activeReferred={activeSubs}
          pending={Number((pending._sum.amount ?? new Prisma.Decimal(0)).toString()).toFixed(2)}
          available={Number((available._sum.amount ?? new Prisma.Decimal(0)).toString()).toFixed(2)}
          paid={Number((paid._sum.amount ?? new Prisma.Decimal(0)).toString()).toFixed(2)}
          lifetime={Number((lifetime._sum.amount ?? new Prisma.Decimal(0)).toString()).toFixed(2)}
          epc={epc}
          tierProgress={tierProgress}
          tierThreshold={affiliate.tierThreshold}
          atTier={atTier}
          tierRatePct={(affiliate.tierRateBps / 100).toFixed(0)}
          baseRatePct={(affiliate.baseRateBps / 100).toFixed(0)}
        />
      </div>
    </div>
  )
}
