import { isRestrictedBillingStaging } from "@/lib/billing-staging-access"
import { notFound } from "next/navigation"

export const dynamic = "force-dynamic"

export default function BillingStagingAccessPage() {
  if (!isRestrictedBillingStaging()) notFound()

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        action="/api/staging/access"
        method="post"
        className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow-sm"
      >
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Restricted billing staging</h1>
          <p className="text-sm text-muted-foreground">
            Enter the disposable staging access code to continue.
          </p>
        </div>
        <label className="block space-y-2 text-sm font-medium">
          <span>Staging access code</span>
          <input
            name="token"
            type="password"
            required
            autoComplete="off"
            className="w-full rounded-md border bg-background px-3 py-2"
          />
        </label>
        <button
          type="submit"
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Continue
        </button>
      </form>
    </main>
  )
}
