interface AffiliateKpiCardsProps {
  clicks: number
  uniqueClicks: number
  signups: number
  conversions: number
  conversionRate: string
  activeReferred: number
  pending: string
  available: string
  paid: string
  lifetime: string
  epc: string
  tierProgress: number
  tierThreshold: number
  atTier: boolean
  tierRatePct: string
  baseRatePct: string
}

export function AffiliateKpiCards(props: AffiliateKpiCardsProps) {
  return (
    <>
      <div className="rounded-lg border p-4">
        <div className="text-sm text-muted-foreground">Clicks</div>
        <div className="mt-1 text-2xl font-bold">{props.clicks}</div>
        <div className="text-xs text-muted-foreground">
          {props.uniqueClicks} unique
        </div>
      </div>

      <div className="rounded-lg border p-4">
        <div className="text-sm text-muted-foreground">Signups</div>
        <div className="mt-1 text-2xl font-bold">{props.signups}</div>
      </div>

      <div className="rounded-lg border p-4">
        <div className="text-sm text-muted-foreground">Paid Conversions</div>
        <div className="mt-1 text-2xl font-bold">{props.conversions}</div>
        <div className="text-xs text-muted-foreground">
          {props.conversionRate}% conversion rate
        </div>
      </div>

      <div className="rounded-lg border p-4">
        <div className="text-sm text-muted-foreground">Active Referred</div>
        <div className="mt-1 text-2xl font-bold">{props.activeReferred}</div>
      </div>

      <div className="rounded-lg border p-4">
        <div className="text-sm text-muted-foreground">Pending Earnings</div>
        <div className="mt-1 text-2xl font-bold">${props.pending}</div>
      </div>

      <div className="rounded-lg border p-4">
        <div className="text-sm text-muted-foreground">Available Earnings</div>
        <div className="mt-1 text-2xl font-bold">${props.available}</div>
      </div>

      <div className="rounded-lg border p-4">
        <div className="text-sm text-muted-foreground">Paid Earnings</div>
        <div className="mt-1 text-2xl font-bold">${props.paid}</div>
      </div>

      <div className="rounded-lg border p-4">
        <div className="text-sm text-muted-foreground">Lifetime Earnings</div>
        <div className="mt-1 text-2xl font-bold">${props.lifetime}</div>
        <div className="text-xs text-muted-foreground">EPC: ${props.epc}</div>
      </div>

      <div className="rounded-lg border p-4 sm:col-span-2 lg:col-span-4">
        <div className="text-sm text-muted-foreground">Tier Progress</div>
        <div className="mt-2 flex items-center gap-3">
          <div className="flex-1">
            <div className="h-3 rounded-full bg-muted">
              <div
                className="h-3 rounded-full bg-primary transition-all"
                style={{
                  width: `${Math.min((props.tierProgress / props.tierThreshold) * 100, 100)}%`,
                }}
              />
            </div>
          </div>
          <span className="text-sm font-medium">
            {props.tierProgress}/{props.tierThreshold} active to unlock {props.tierRatePct}%
          </span>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Current rate: {props.atTier ? props.tierRatePct : props.baseRatePct}%
          {!props.atTier && ` → ${props.tierRatePct}% at ${props.tierThreshold} active referrals`}
        </div>
      </div>
    </>
  )
}
