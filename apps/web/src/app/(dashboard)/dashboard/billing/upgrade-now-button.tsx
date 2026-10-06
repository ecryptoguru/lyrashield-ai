import Link from "next/link"
import { buttonVariants } from "@lyrashield/ui"
import { TrendingUp } from "lucide-react"

/**
 * Sends trial users to the shared plan picker with their Pro preference selected.
 * Checkout starts only after they choose a plan and billing interval there.
 */
export function UpgradeNowButton() {
  return (
    <Link
      href="/dashboard/billing?plan=PRO"
      className={`${buttonVariants({ variant: "default" })} w-full`}
    >
      <TrendingUp className="mr-2 h-4 w-4" aria-hidden="true" />
      Upgrade Now
    </Link>
  )
}
