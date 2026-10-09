"use client"

import { useState, useTransition } from "react"
import { EmailText } from "@/components/email-text"
import { useRouter } from "next/navigation"
import { Search, ShieldX, CheckCircle2, AlertTriangle } from "lucide-react"
import { LocalTime } from "@/components/local-time"
import Link from "next/link"
import { buttonVariants } from "@lyrashield/ui"

interface LicenseRow {
  id: string
  ownerEmail: string
  sku: string
  seatCount: number
  machinesActivated: number
  machineIds: string[]
  updateEligibleUntil: string
  perpetualFallbackBuild: string | null
  revoked: boolean
  revokedAt: string | null
  revocationReason: string | null
  issuedAt: string
  createdAt: string
  hasLicenseKey: boolean
}

export function LicensesClient({
  initialData,
  query,
  statusFilter,
  cursor = null,
  nextCursor = null,
}: {
  initialData: LicenseRow[]
  query: string
  statusFilter: "active" | "revoked"
  cursor?: string | null
  nextCursor?: string | null
}) {
  const [search, setSearch] = useState(query)
  const [filter, setFilter] = useState<"active" | "revoked">(statusFilter)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function pageHref(next: string | null) {
    const params = new URLSearchParams({ status: statusFilter })
    if (query) params.set("q", query)
    if (next) params.set("cursor", next)
    return `/dashboard/licenses?${params.toString()}`
  }

  function navigate(nextSearch: string, nextFilter: "active" | "revoked") {
    startTransition(() => {
      const params = new URLSearchParams()
      if (nextSearch.trim()) params.set("q", nextSearch.trim())
      params.set("status", nextFilter)
      router.replace(`/dashboard/licenses?${params.toString()}`)
    })
  }

  function updateFilter(value: "active" | "revoked") {
    setFilter(value)
    navigate(search, value)
  }

  return (
    <div className="space-y-4">
      {/* Search + filter controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <form
          className="flex w-full max-w-sm gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            navigate(search, filter)
          }}
        >
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search licenses by owner email</span>
            <Search
              className="text-muted-foreground absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              type="search"
              maxLength={320}
              placeholder="Search by owner email..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="border-input bg-background min-h-11 w-full rounded-md border py-2 pl-9 pr-3 text-base outline-none focus:ring-2 focus:ring-ring md:text-sm"
            />
          </label>
          <button type="submit" disabled={isPending} className={buttonVariants()}>
            Search
          </button>
        </form>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => updateFilter("active")}
            disabled={isPending}
            aria-pressed={filter === "active"}
            className={`focus-visible:ring-ring min-h-11 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 ${
              filter === "active"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            Active
          </button>
          <button
            type="button"
            onClick={() => updateFilter("revoked")}
            disabled={isPending}
            aria-pressed={filter === "revoked"}
            className={`focus-visible:ring-ring min-h-11 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 ${
              filter === "revoked"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            Revoked
          </button>
        </div>
      </div>

      {/* Licenses table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" aria-busy={isPending}>
          <caption className="sr-only">
            {filter === "active" ? "Active" : "Revoked"} Local and Desktop licenses
          </caption>
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th scope="col" className="px-4 py-3 font-medium">
                License ID
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Owner Email
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                SKU
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Seats
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Machines
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Update Eligible Until
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {initialData.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-muted-foreground px-4 py-8 text-center">
                  No {filter} licenses found{search.trim() ? " for this owner search" : ""}.
                </td>
              </tr>
            ) : (
              initialData.map((license) => {
                const eligible = new Date(license.updateEligibleUntil) > new Date()
                return (
                  <tr key={license.id} className="hover:bg-muted/30">
                    <td className="max-w-[120px] truncate px-4 py-3 font-mono text-xs">
                      {license.id}
                    </td>
                    <td className="px-4 py-3">
                      <EmailText value={license.ownerEmail} />
                    </td>
                    <td className="px-4 py-3">
                      <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{license.sku}</code>
                    </td>
                    <td className="px-4 py-3">{license.seatCount}</td>
                    <td className="px-4 py-3">
                      {license.machinesActivated}
                      {license.machineIds.length > 0 && (
                        <span className="text-muted-foreground ml-1 text-xs">
                          ({license.machineIds.length} IDs)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {eligible ? (
                          <CheckCircle2 className="text-success h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <AlertTriangle className="text-warning h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        <span className={eligible ? "" : "text-muted-foreground"}>
                          <LocalTime value={license.updateEligibleUntil} />
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {license.revoked ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                          <ShieldX className="h-3 w-3" aria-hidden="true" />
                          Revoked
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
                          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                          Active
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {initialData.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Showing {initialData.length} license{initialData.length !== 1 ? "s" : ""} on this page.
        </p>
      )}
      {(cursor || nextCursor) && (
        <nav aria-label="License pages" className="flex flex-wrap gap-2">
          {cursor && (
            <Link href={pageHref(null)} className={buttonVariants({ variant: "secondary" })}>
              First page
            </Link>
          )}
          {nextCursor && (
            <Link href={pageHref(nextCursor)} className={buttonVariants({ variant: "secondary" })}>
              Next page
            </Link>
          )}
        </nav>
      )}
    </div>
  )
}
