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
import {
  HOME_LABEL,
  TARGET_PLURAL,
  RUN_PLURAL,
  ISSUE_PLURAL,
  APPROVAL_CENTER,
  APPROVAL_PLURAL,
  EVIDENCE_PLURAL,
  AUTOMATION_PLURAL,
  NOTIFICATION_PLURAL,
  INTEGRATION_PLURAL,
  TEAM_PLURAL,
  SETTINGS_PLURAL,
} from "./terminology"

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

// Canonical internal routes. UI labels come from terminology.ts.
export const NAV_ITEMS: NavItem[] = [
  {
    href: "/dashboard",
    label: HOME_LABEL,
    shortLabel: HOME_LABEL,
    icon: LayoutDashboard,
    primary: true,
    mobilePrimary: true,
  },
  {
    href: "/dashboard/targets",
    label: TARGET_PLURAL,
    shortLabel: TARGET_PLURAL,
    icon: Crosshair,
    primary: true,
    mobilePrimary: true,
  },
  {
    href: "/dashboard/scans",
    label: RUN_PLURAL,
    shortLabel: "Runs",
    icon: Radar,
    primary: true,
    mobilePrimary: true,
  },
  {
    href: "/dashboard/findings",
    label: ISSUE_PLURAL,
    shortLabel: ISSUE_PLURAL,
    icon: Bug,
    primary: true,
    mobilePrimary: true,
  },
  {
    href: "/dashboard/approvals",
    label: APPROVAL_CENTER,
    shortLabel: APPROVAL_PLURAL,
    icon: ClipboardCheck,
    primary: true,
  },
  {
    href: "/dashboard/evidence",
    label: EVIDENCE_PLURAL,
    shortLabel: EVIDENCE_PLURAL,
    icon: ShieldCheck,
    primary: true,
  },
  {
    href: "/dashboard/automations",
    label: AUTOMATION_PLURAL,
    shortLabel: AUTOMATION_PLURAL,
    icon: CalendarClock,
    primary: true,
  },
  // Secondary / More
  {
    href: "/dashboard/notifications",
    label: NOTIFICATION_PLURAL,
    shortLabel: NOTIFICATION_PLURAL,
    icon: Bell,
  },
  {
    href: "/dashboard/integrations",
    label: INTEGRATION_PLURAL,
    shortLabel: INTEGRATION_PLURAL,
    icon: Plug,
  },
  { href: "/dashboard/team", label: TEAM_PLURAL, shortLabel: TEAM_PLURAL, icon: Users },
  {
    href: "/dashboard/settings",
    label: SETTINGS_PLURAL,
    shortLabel: SETTINGS_PLURAL,
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
