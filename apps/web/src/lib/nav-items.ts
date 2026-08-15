import {
  LayoutDashboard,
  Crosshair,
  Radar,
  Bug,
  Bell,
  Settings,
  Users,
  Plug,
  Bot,
  ClipboardCheck,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react"
import {
  HOME_LABEL,
  TARGET_PLURAL,
  RUN_PLURAL,
  ISSUE_PLURAL,
  REVIEW_QUEUE_LABEL,
  APPROVAL_PLURAL,
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
  /**
   * Optional pending-action count rendered as a badge. Only the Review Queue item
   * sets this today; it is populated by the layout from a permission-gated
   * `AgentApproval` pending count.
   */
  badgeCount?: number
}

/**
 * The four lifecycle destinations that are always present on desktop and mobile.
 * These are the only `mobilePrimary` items so the bottom bar's four fixed slots
 * stay stable regardless of pending approvals.
 */
const LIFECYCLE_NAV_ITEMS: NavItem[] = [
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
]

/**
 * The Review Queue item. It is rendered in the desktop sidebar's Workspace group
 * and the mobile More sheet only when `pendingApprovals > 0`. The route itself
 * remains reachable by URL for authorized users even when the queue is empty.
 */
const REVIEW_QUEUE_BASE: NavItem = {
  href: "/dashboard/approvals",
  label: REVIEW_QUEUE_LABEL,
  shortLabel: APPROVAL_PLURAL,
  icon: ClipboardCheck,
}

function reviewQueueItem(pendingApprovals: number): NavItem {
  return {
    ...REVIEW_QUEUE_BASE,
    badgeCount: pendingApprovals > 0 ? pendingApprovals : undefined,
  }
}

/**
 * The Evidence Vault item. It is rendered only when the active workspace role
 * holds `aiAssurance:view` — otherwise the nav link 404s on click for roles
 * that lack the permission (DEVELOPER, BILLING_ADMIN). The route itself stays
 * reachable by URL for authorized users. (Deep Review v13 P1-2.)
 */
const EVIDENCE_VAULT_BASE: NavItem = {
  href: "/dashboard/ai-assurance",
  label: "Evidence Vault",
  shortLabel: "Evidence",
  icon: ShieldCheck,
}

/** Secondary / Workspace destinations that are always present. */
const WORKSPACE_NAV_ITEMS: NavItem[] = [
  {
    href: "/dashboard/notifications",
    label: NOTIFICATION_PLURAL,
    shortLabel: NOTIFICATION_PLURAL,
    icon: Bell,
  },
  {
    href: "/dashboard/agents",
    label: "Coding Agents",
    shortLabel: "Agents",
    icon: Bot,
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

export interface NavState {
  /**
   * Pending agent approval count for the active workspace. The Review Queue item is
   * only surfaced when this is greater than zero. The layout is responsible for
   * gating this on `agent:view` permission before passing it in.
   */
  pendingApprovals?: number
  /**
   * Whether the active workspace role may view the Evidence Vault
   * (`aiAssurance:view`). The Evidence Vault nav item is only surfaced when
   * true; the route itself remains reachable by URL for authorized users.
   * The layout gates this on `aiAssurance:view` permission before passing it in.
   */
  canViewEvidenceVault?: boolean
}

function resolveNavItems(state: NavState = {}): NavItem[] {
  const pending = state.pendingApprovals ?? 0
  const items = [...LIFECYCLE_NAV_ITEMS]
  if (pending > 0) items.push(reviewQueueItem(pending))
  if (state.canViewEvidenceVault) items.push(EVIDENCE_VAULT_BASE)
  items.push(...WORKSPACE_NAV_ITEMS)
  return items
}

/**
 * Runtime flat list with no pending approvals. Used by components and tests
 * that cannot access the live pending-approval state. It intentionally omits
 * the conditional Review Queue because the item is only visible when pending
 * approvals exist.
 */
export const NAV_ITEMS: NavItem[] = resolveNavItems({ pendingApprovals: 0 })

/**
 * All navigation destinations, for page-title lookup. Includes the Review Queue
 * regardless of pending count because its route is reachable by URL.
 */
export const NAV_TITLE_ITEMS: NavItem[] = [
  ...LIFECYCLE_NAV_ITEMS,
  REVIEW_QUEUE_BASE,
  ...WORKSPACE_NAV_ITEMS,
]

/** Desktop sidebar primary group (lifecycle only). */
export const PRIMARY_NAV_ITEMS: NavItem[] = LIFECYCLE_NAV_ITEMS

/**
 * Desktop sidebar secondary group. Always includes Workspace items; the Review
 * Queue is appended first when pending approvals exist.
 */
export const SECONDARY_NAV_ITEMS: NavItem[] = WORKSPACE_NAV_ITEMS

/** The four fixed slots in the mobile bottom bar. */
export const MOBILE_PRIMARY_NAV_ITEMS: NavItem[] = LIFECYCLE_NAV_ITEMS

/**
 * Everything the mobile bottom bar does not show. Defined as the exact complement
 * of MOBILE_PRIMARY_NAV_ITEMS so a new destination is reachable on mobile by
 * default. The Review Queue is included only when pending approvals exist.
 */
export const MORE_NAV_ITEMS: NavItem[] = WORKSPACE_NAV_ITEMS

// --- State-aware helpers (preferred for new callers) -----------------------

export interface ResolvedNav {
  items: NavItem[]
  primary: NavItem[]
  secondary: NavItem[]
  mobilePrimary: NavItem[]
  more: NavItem[]
  /** The Review Queue item, or null when no pending approvals exist. */
  reviewQueue: NavItem | null
}

/**
 * Resolve navigation for a given state. The layout calls this with the
 * permission-gated pending approval count so the Review Queue and its badge
 * appear only when there is something to review.
 */
export function resolveNav(state: NavState = {}): ResolvedNav {
  const pending = state.pendingApprovals ?? 0
  const reviewQueue = pending > 0 ? reviewQueueItem(pending) : null
  const evidenceVault = state.canViewEvidenceVault ? EVIDENCE_VAULT_BASE : null
  const conditional: NavItem[] = []
  if (reviewQueue) conditional.push(reviewQueue)
  if (evidenceVault) conditional.push(evidenceVault)
  const secondary = [...conditional, ...WORKSPACE_NAV_ITEMS]
  const more = [...conditional, ...WORKSPACE_NAV_ITEMS]
  const items = [...LIFECYCLE_NAV_ITEMS, ...secondary]
  return {
    items,
    primary: LIFECYCLE_NAV_ITEMS,
    secondary,
    mobilePrimary: LIFECYCLE_NAV_ITEMS,
    more,
    reviewQueue,
    evidenceVault,
  }
}
