"use client"

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="border-border bg-background hover:bg-muted inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium print:hidden"
    >
      Print / Save as PDF
    </button>
  )
}
