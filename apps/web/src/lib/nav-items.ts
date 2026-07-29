import {
  LayoutDashboard,
  Crosshair,
  Radar,
  Bug,
  ShieldCheck,
  Bell,
  Settings,
  Users,
  Plug,
  CalendarClock,
  ClipboardCheck,
  type LucideIcon,
} from "lucide-react"

export interface NavItem {
  href: string
  label: string
  shortLabel: string
  icon: LucideIcon
  primary?: boolean
  mobileMore?: boolean
}

// Canonical internal routes. UI labels come from terminology.ts where needed.
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Home", shortLabel: "Home", icon: LayoutDashboard, primary: true },
  {
    href: "/dashboard/products",
    label: "Products",
    shortLabel: "Products",
    icon: Crosshair,
    primary: true,
  },
  { href: "/dashboard/scans", label: "Trust Runs", shortLabel: "Runs", icon: Radar, primary: true },
  { href: "/dashboard/findings", label: "Issues", shortLabel: "Issues", icon: Bug, primary: true },
  {
    href: "/dashboard/approvals",
    label: "Approvals",
    shortLabel: "Approvals",
    icon: ClipboardCheck,
    primary: true,
  },
  {
    href: "/dashboard/evidence",
    label: "Evidence",
    shortLabel: "Evidence",
    icon: ShieldCheck,
    primary: true,
  },
  {
    href: "/dashboard/automations",
    label: "Automations",
    shortLabel: "Automations",
    icon: CalendarClock,
    primary: true,
  },
  // Secondary / More
  {
    href: "/dashboard/notifications",
    label: "Notifications",
    shortLabel: "Notifications",
    icon: Bell,
    mobileMore: true,
  },
  {
    href: "/dashboard/integrations",
    label: "Integrations",
    shortLabel: "Integrations",
    icon: Plug,
    mobileMore: true,
  },
  { href: "/dashboard/team", label: "Team", shortLabel: "Team", icon: Users, mobileMore: true },
  {
    href: "/dashboard/settings",
    label: "Settings",
    shortLabel: "Settings",
    icon: Settings,
    mobileMore: true,
  },
]

export const PRIMARY_NAV_ITEMS = NAV_ITEMS.filter((item) => item.primary)
export const MORE_NAV_ITEMS = NAV_ITEMS.filter((item) => item.mobileMore)
