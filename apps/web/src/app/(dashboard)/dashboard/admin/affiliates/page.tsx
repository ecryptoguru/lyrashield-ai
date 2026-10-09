import Link from "next/link"
import { buttonVariants } from "@lyrashield/ui"
import { parseAdminCursor } from "@/lib/platform-admin-lists"
import { prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/page-header"
import { EmailText } from "@/components/email-text"
import { LocalTime } from "@/components/local-time"
import { isPlatformOperator } from "@lyrashield/auth/server"
import { AffiliateAdminActions } from "./admin-actions"

export const metadata = {
  title: "Affiliate Admin",
}

const PAGE_SIZE = 25
const CURSOR_KEYS = ["pending", "approved", "suspended", "payouts"] as const
type CursorKey = (typeof CURSOR_KEYS)[number]
type Cursors = Partial<Record<CursorKey, string>>

function listPage<T extends { id: string }>(rows: T[]) {
  const items = rows.slice(0, PAGE_SIZE)
  return { items, nextCursor: rows.length > PAGE_SIZE ? items.at(-1)!.id : null }
}

function AffiliatePages({
  name,
  cursors,
  nextCursor,
}: {
  name: CursorKey
  cursors: Cursors
  nextCursor: string | null
}) {
  function href(cursor: string | null) {
    const params = new URLSearchParams()
    for (const key of CURSOR_KEYS) {
      const value = key === name ? cursor : cursors[key]
      if (value) params.set(key, value)
    }
    return `/dashboard/admin/affiliates?${params.toString()}#${name}`
  }
  if (!cursors[name] && !nextCursor) return null
  return (
    <nav aria-label={`${name} pages`} className="mt-4 flex flex-wrap gap-2">
      {cursors[name] && (
        <Link href={href(null)} className={buttonVariants({ variant: "secondary" })}>
          First page
        </Link>
      )}
      {nextCursor && (
        <Link href={href(nextCursor)} className={buttonVariants({ variant: "secondary" })}>
          Next page
        </Link>
      )}
    </nav>
  )
}

async function getAffiliateAdminData(searchParams: Partial<Record<CursorKey, string>>) {
  const cursors: Cursors = {}
  for (const key of CURSOR_KEYS) cursors[key] = parseAdminCursor(searchParams[key])
  const pagination = (name: CursorKey) => ({
    take: PAGE_SIZE + 1,
    ...(cursors[name] ? { cursor: { id: cursors[name] }, skip: 1 } : {}),
  })
  const [
    pendingRows,
    approvedRows,
    suspendedRows,
    payoutRows,
    pendingCount,
    approvedCount,
    suspendedCount,
    payoutCount,
  ] = await Promise.all([
    prisma.affiliate.findMany({
      where: { status: "PENDING" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pagination("pending"),
      include: { user: { select: { email: true, name: true } } },
    }),
    prisma.affiliate.findMany({
      where: { status: "APPROVED" },
      orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
      ...pagination("approved"),
      include: {
        user: { select: { email: true, name: true } },
        _count: { select: { commissions: true, payouts: true, clicks: true } },
      },
    }),
    prisma.affiliate.findMany({
      where: { status: "SUSPENDED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pagination("suspended"),
      include: { user: { select: { email: true, name: true } } },
    }),
    prisma.payout.findMany({
      where: { status: { in: ["PENDING", "PROCESSING"] } },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      ...pagination("payouts"),
      include: { affiliate: { include: { user: { select: { email: true, name: true } } } } },
    }),
    prisma.affiliate.count({ where: { status: "PENDING" } }),
    prisma.affiliate.count({ where: { status: "APPROVED" } }),
    prisma.affiliate.count({ where: { status: "SUSPENDED" } }),
    prisma.payout.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
  ])
  return {
    cursors,
    pending: listPage(pendingRows),
    approved: listPage(approvedRows),
    suspended: listPage(suspendedRows),
    payouts: listPage(payoutRows),
    pendingCount,
    approvedCount,
    suspendedCount,
    payoutCount,
  }
}

export default async function AffiliateAdminPage({
  searchParams,
}: {
  searchParams: Promise<Partial<Record<CursorKey, string>>>
}) {
  const session = await getCachedSession()
  if (!session) return null

  // Global affiliate administration is platform-operator authority — it never
  // derives from workspace membership or tenant roles.
  if (!(await isPlatformOperator(session.userId))) {
    redirect("/dashboard")
  }

  const data = await getAffiliateAdminData(await searchParams)
  const { cursors, pendingCount, approvedCount, suspendedCount, payoutCount } = data
  const {
    pending: pendingPage,
    approved: approvedPage,
    suspended: suspendedPage,
    payouts: payoutPage,
  } = data
  const pending = pendingPage.items
  const approved = approvedPage.items
  const suspended = suspendedPage.items
  const payouts = payoutPage.items

  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8">
      <PageHeader
        title="Affiliate Admin"
        description="Review applications, affiliates and payouts. Changes remain disabled until one-time authorization and atomic audit controls are connected."
      />

      <section id="pending" className="mt-6 scroll-mt-24">
        <h2 className="mb-4 text-lg font-semibold">Approval Queue ({pendingCount})</h2>
        <div className="space-y-3">
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending applications on this page.</p>
          ) : (
            pending.map((aff) => (
              <div
                key={aff.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
              >
                <div className="min-w-0">
                  <div className="font-medium wrap-break-word">
                    <EmailText value={aff.user.name ?? aff.user.email} />
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Applied <LocalTime value={aff.createdAt} />
                  </div>
                </div>
                <AffiliateAdminActions affiliateId={aff.id} />
              </div>
            ))
          )}
        </div>
        <AffiliatePages name="pending" cursors={cursors} nextCursor={pendingPage.nextCursor} />
      </section>

      <section id="approved" className="mt-8 scroll-mt-24">
        <h2 className="mb-4 text-lg font-semibold">Approved Affiliates ({approvedCount})</h2>
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="pb-2 pr-4">
                  Affiliate
                </th>
                <th scope="col" className="pb-2 pr-4">
                  Active Referrals
                </th>
                <th scope="col" className="pb-2 pr-4">
                  Commissions
                </th>
                <th scope="col" className="pb-2 pr-4">
                  Clicks
                </th>
                <th scope="col" className="pb-2 pr-4">
                  Payouts
                </th>
                <th scope="col" className="pb-2 pr-4">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {approved.map((aff) => (
                <tr key={aff.id} className="border-b">
                  <td className="py-2 pr-4">
                    <EmailText value={aff.user.name ?? aff.user.email} />
                  </td>
                  <td className="py-2 pr-4">{aff.activeReferrals}</td>
                  <td className="py-2 pr-4">{aff._count.commissions}</td>
                  <td className="py-2 pr-4">{aff._count.clicks}</td>
                  <td className="py-2 pr-4">{aff._count.payouts}</td>
                  <td className="py-2 pr-4">
                    <AffiliateAdminActions
                      affiliateId={aff.id}
                      showSuspend
                      showTierOverride
                      showPayoutProfileVerification
                      currentPayoutMethodVerified={Boolean(aff.payoutMethodVerifiedAt)}
                      currentTaxStatus={
                        aff.taxFormStatus as
                          "PENDING_REVIEW" | "VERIFIED" | "REJECTED" | "NOT_SUBMITTED"
                      }
                      currentBaseRate={aff.baseRateBps}
                      currentTierRate={aff.tierRateBps}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {approved.length === 0 && (
          <p className="text-muted-foreground py-4 text-sm">No approved affiliates on this page.</p>
        )}
        <AffiliatePages name="approved" cursors={cursors} nextCursor={approvedPage.nextCursor} />
      </section>

      <section id="payouts" className="mt-8 scroll-mt-24">
        <h2 className="mb-4 text-lg font-semibold">Pending Payouts ({payoutCount})</h2>
        <div className="space-y-3">
          {payouts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending payouts on this page.</p>
          ) : (
            payouts.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
              >
                <div className="min-w-0">
                  <div className="font-medium wrap-break-word">
                    <EmailText value={p.affiliate.user.name ?? p.affiliate.user.email} />
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {p.amount.toString()} {p.currency} · Requested{" "}
                    <LocalTime value={p.requestedAt} />
                  </div>
                </div>
                <AffiliateAdminActions
                  payoutId={p.id}
                  showPayoutReconcile
                  currentProviderPayoutId={p.providerPayoutId}
                />
              </div>
            ))
          )}
        </div>
        <AffiliatePages name="payouts" cursors={cursors} nextCursor={payoutPage.nextCursor} />
      </section>

      {(suspendedCount > 0 || cursors.suspended) && (
        <section id="suspended" className="mt-8 scroll-mt-24">
          <h2 className="mb-4 text-lg font-semibold">Suspended Affiliates ({suspendedCount})</h2>
          <div className="space-y-3">
            {suspended.map((aff) => (
              <div
                key={aff.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
              >
                <div className="min-w-0">
                  <div className="font-medium wrap-break-word">
                    <EmailText value={aff.user.name ?? aff.user.email} />
                  </div>
                </div>
                <AffiliateAdminActions affiliateId={aff.id} showReactivate />
              </div>
            ))}
          </div>
          {suspended.length === 0 && (
            <p className="text-muted-foreground text-sm">No suspended affiliates on this page.</p>
          )}
          <AffiliatePages
            name="suspended"
            cursors={cursors}
            nextCursor={suspendedPage.nextCursor}
          />
        </section>
      )}
    </div>
  )
}
