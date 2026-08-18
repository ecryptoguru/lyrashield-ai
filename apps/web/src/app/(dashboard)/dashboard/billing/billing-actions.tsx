"use client"

import { buttonVariants } from "@lyrashield/ui"
import Link from "next/link"

interface BillingActionsProps {
  plan: string
  isTeam: boolean
}

/**
 * Client-side billing action buttons.
 * Shows upgrade/downgrade, monthly↔annual toggle, and pack purchase links.
 * No $ cost values are displayed here per the billing design constraint.
 */
export function BillingActions({ plan, isTeam: _isTeam }: BillingActionsProps) {
  if (plan === "FREE" || plan === "STARTER") {
    return (
      <div className="flex gap-2">
        <Link
          href="/billing/checkout?plan=PRO&interval=monthly"
          className={buttonVariants({ variant: "default", size: "sm" })}
        >
          Upgrade
        </Link>
      </div>
    )
  }

  if (plan === "PRO") {
    return (
      <div className="flex gap-2">
        <Link
          href="/billing/checkout?plan=TEAM&interval=monthly"
          className={buttonVariants({ variant: "default", size: "sm" })}
        >
          Upgrade to Team
        </Link>
        <Link
          href="/billing/portal"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Manage
        </Link>
      </div>
    )
  }

  // Team plan
  return (
    <div className="flex gap-2">
      <Link
        href="/billing/portal"
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Manage Subscription
      </Link>
    </div>
  )
}
