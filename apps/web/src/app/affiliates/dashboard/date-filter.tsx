import Link from "next/link"

const RANGES = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
]

export function DateFilter({ current }: { current: string }) {
  return (
    <div className="flex gap-2">
      {RANGES.map((r) => (
        <Link
          key={r.value}
          href={`/affiliates/dashboard?range=${r.value}`}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            current === r.value ? "bg-primary text-primary-foreground" : "border hover:bg-muted"
          }`}
        >
          {r.label}
        </Link>
      ))}
    </div>
  )
}
