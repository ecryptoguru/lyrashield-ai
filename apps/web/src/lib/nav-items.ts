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
  /** Shown in the desktop sidebar's primary group. */
  primary?: boolean
  /**
   * Occupies one of the four fixed slots in the mobile bottom bar (the fifth slot is
   * the "More" trigger). Everything WITHOUT this flag is surfaced in the More sheet.
   *
   * The two mobile lists are exact complements by construction — see
   * MOBILE_PRIMARY_NAV_ITEMS / MORE_NAV_ITEMS below. Do not reintroduce a slice() or
   * a second opt-in flag: that is how Approvals, Evidence and Automations previously
   * became unreachable on mobile (they were `primary` but not in the More list).
   * nav-items.test.ts asserts the complement property.
   */
  mobilePrimary?: boolean
}

// Canonical internal routes. UI labels come from terminology.ts where needed.
export const NAV_ITEMS: NavItem[] = [
  {
    href: "/dashboard",
    label: "Home",
    shortLabel: "Home",
    icon: LayoutDashboard,
    primary: true,
    mobilePrimary: true,
  },
  {
    href: "/dashboard/products",
    label: "Products",
    shortLabel: "Products",
    icon: Crosshair,
    primary: true,
    mobilePrimary: true,
  },
  {
    href: "/dashboard/scans",
    label: "Trust Runs",
    shortLabel: "Runs",
    icon: Radar,
    primary: true,
    mobilePrimary: true,
  },
  {
    href: "/dashboard/findings",
    label: "Issues",
    shortLabel: "Issues",
    icon: Bug,
    primary: true,
    mobilePrimary: true,
  },
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
  },
  {
    href: "/dashboard/integrations",
    label: "Integrations",
    shortLabel: "Integrations",
    icon: Plug,
  },
  { href: "/dashboard/team", label: "Team", shortLabel: "Team", icon: Users },
  {
    href: "/dashboard/settings",
    label: "Settings",
    shortLabel: "Settings",
    icon: Settings,
  },
]

/** Desktop sidebar primary group. */
export const PRIMARY_NAV_ITEMS = NAV_ITEMS.filter((item) => item.primary)

/** Desktop sidebar secondary group. */
export const SECONDARY_NAV_ITEMS = NAV_ITEMS.filter((item) => !item.primary)

/** The four fixed slots in the mobile bottom bar. */
export const MOBILE_PRIMARY_NAV_ITEMS = NAV_ITEMS.filter((item) => item.mobilePrimary)

/**
 * Everything the mobile bottom bar does not show. Defined as the exact complement of
 * MOBILE_PRIMARY_NAV_ITEMS so a new destination is reachable on mobile by default.
 */
export const MORE_NAV_ITEMS = NAV_ITEMS.filter((item) => !item.mobilePrimary)
