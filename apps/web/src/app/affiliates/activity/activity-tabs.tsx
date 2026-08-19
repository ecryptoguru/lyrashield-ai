import Link from "next/link"

const TABS = [
  { value: "clicks", label: "Clicks" },
  { value: "signups", label: "Signups" },
  { value: "conversions", label: "Conversions" },
]

export function ActivityTabs({ currentTab }: { currentTab: string }) {
  return (
    <div className="flex gap-1 border-b">
      {TABS.map((tab) => (
        <Link
          key={tab.value}
          href={`/affiliates/activity?tab=${tab.value}`}
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
            currentTab === tab.value
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  )
}
