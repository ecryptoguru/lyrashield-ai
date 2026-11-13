/**
 * The DOM id of the plan picker on /dashboard/billing.
 *
 * Two surfaces reference it: the picker itself (billing-actions) and the
 * "Upgrade Now" button that scrolls to and focuses it (upgrade-now-button).
 * It lives here so neither component has to import the other.
 */
export const PLAN_PICKER_ID = "choose-plan"
