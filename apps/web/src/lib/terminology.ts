// Single source of truth for user-facing nouns in the V2 UX.
// Internal identifiers, Prisma models, enum values, API payload keys and
// integration contracts keep their existing names; this module is the only
// place where a user-facing label lives.

export const HOME_LABEL = "Home"

export const TARGET_SINGULAR = "Target"
export const TARGET_PLURAL = "Targets"

export const TARGET_DETAILS_LABEL = `${TARGET_SINGULAR} details`
export const TARGET_NAME_LABEL = `${TARGET_SINGULAR} name`

// User-facing nouns: a scan is a scan, a finding is a finding. The legacy
// run/issue labels are retired from user-facing copy; identifiers, routes,
// and API contracts keep their existing names.
export const RUN_SINGULAR = "Scan"
export const RUN_PLURAL = "Scans"
export const SCAN_SINGULAR = "Scan"
export const SCAN_PLURAL = "Scans"
export const ISSUE_SINGULAR = "Finding"
export const ISSUE_PLURAL = "Findings"

// Project is the workspace/project concept used in onboarding and trust
// planning. Since Deep Review v16 (item 3.1) onboarding speaks the canonical
// Target noun, these alias TARGET_* above; nothing else reads them — remove
// here if still unused after the terminology sweep.
export const PRODUCT_SINGULAR = "Target"
export const APPROVAL_PLURAL = "Approvals"
export const NOTIFICATION_PLURAL = "Notifications"
export const TEAM_PLURAL = "Team"

export const SETTINGS_PLURAL = "Settings"
