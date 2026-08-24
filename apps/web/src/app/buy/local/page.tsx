import Link from "next/link"
import { headers } from "next/headers"
import { Check, ShieldCheck } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@lyrashield/ui"
import { LOCAL_SKU_MAP, formatINR, formatUSD } from "@lyrashield/pricing"
import { resolveProvider } from "@lyrashield/billing"
import { env } from "@lyrashield/config"
import { LocalCheckoutButton } from "./local-checkout-button"

export default async function BuyLocalPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const sku = LOCAL_SKU_MAP.individual_launch
  const requestHeaders = await headers()
  const { provider } = resolveProvider(
    new Request("https://app.lyrashieldai.com/buy/local", { headers: requestHeaders })
  )
  const available =
    provider === "polar"
      ? env.POLAR_LOCAL_BILLING_ADMISSION === "public"
      : env.RAZORPAY_LOCAL_BILLING_ADMISSION === "public"
  const received = (await searchParams).status === "received"

  return (
    <main className="min-h-screen bg-background px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-xl space-y-6">
        <Link
          href="https://lyrashieldai.com/pricing?mode=local"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to pricing
        </Link>
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-8 w-8 text-primary" aria-hidden="true" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight">LyraShield AI Local</h1>
            <p className="text-muted-foreground">Individual Launch license</p>
          </div>
        </div>

        {received && (
          <div
            role="status"
            className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
          >
            Payment received. Your license is pending signed webhook confirmation. Check your email
            for the one-time retrieval link; do not submit payment again.
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-baseline justify-between gap-4">
              <span>{sku.name}</span>
              <span>
                {provider === "razorpay" ? formatINR(sku.priceInr!) : formatUSD(sku.priceUsd)}
              </span>
            </CardTitle>
            {provider === "razorpay" && (
              <p className="text-sm text-muted-foreground">GST included</p>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            <ul className="space-y-3 text-sm">
              {[
                "Perpetual single-user Local license",
                "Updates included for 12 months",
                "Bring your own model credentials",
                "Activation on up to three machines",
              ].map((item) => (
                <li key={item} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <LocalCheckoutButton available={available} />
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
