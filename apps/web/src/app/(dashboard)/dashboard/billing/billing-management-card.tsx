import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@lyrashield/ui"

export function BillingManagementCard({
  workspaceId,
  opensBillingSupport,
}: {
  workspaceId: string
  opensBillingSupport: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">
          {opensBillingSupport ? "Billing support" : "Manage Subscription"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {opensBillingSupport && (
          <p className="mb-3 text-sm text-muted-foreground">
            Contact billing support for cancellation and payment help.
          </p>
        )}
        <Link
          href={`/billing/portal?workspaceId=${encodeURIComponent(workspaceId)}`}
          className={`${buttonVariants({ variant: "outline" })} w-full`}
        >
          {opensBillingSupport ? "Open billing support" : "Open Customer Portal"}
        </Link>
      </CardContent>
    </Card>
  )
}
