export interface ScanItem {
  id: string
  status: string
  goal: string
  mode: string
  triggerType: string
  startedAt: string | null
  endedAt: string | null
  summary: string | null
  errorCategory: string | null
  errorMessage: string | null
  findingCount?: number
  target: {
    id: string
    name: string
    type: string
    url: string | null
    repoFullName: string | null
  } | null
  createdAt: string
}

export type ScanEligibility = {
  allowed: boolean
  code: string | null
  message: string | null
  plan: string
  isTrial: boolean
  remainingMinutes: number
}

export type ScanEligibilityState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; eligibility: ScanEligibility }
  | { status: "error" }

export interface TargetItem {
  id: string
  name: string
  type: string
  url: string | null
  apiSpecUrl: string | null
  repoFullName: string | null
}
