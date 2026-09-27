// Single source of truth for user-facing nouns in the V2 UX.
// Internal identifiers, Prisma models, enum values, API payload keys and
// integration contracts keep their existing names; this module is the only
// place where a user-facing label lives.

export const HOME_LABEL = "Home"

export const TARGET_SINGULAR = "Target"
export const TARGET_PLURAL = "Targets"

export const TARGET_DETAILS_LABEL = `${TARGET_SINGULAR} details`
export const TARGET_NAME_LABEL = `${TARGET_SINGULAR} name`

// User-facing nouns; identifiers, routes and API contracts keep their existing names.
export const SCAN_SINGULAR = "Scan"
export const SCAN_PLURAL = "Scans"
export const FINDING_SINGULAR = "Finding"
export const FINDING_PLURAL = "Findings"
export const NOTIFICATION_PLURAL = "Notifications"
export const TEAM_PLURAL = "Team"

export const SETTINGS_PLURAL = "Settings"
