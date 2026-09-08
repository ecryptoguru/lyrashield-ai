export const CANONICAL_OPERATIONS = {
  WORKSPACE_READ: "workspace.read",
  TARGET_LIST: "target.list",
  TARGET_READ: "target.read",
  FINDING_LIST: "finding.list",
  FINDING_READ: "finding.read",
  SCAN_READ: "scan.read",
  REPORT_LIST: "report.list",
  SCAN_ELIGIBILITY: "scan.eligibility",
  GATE_READ: "gate.read",
  SCAN_CREATE: "scan.create",
  REPORT_CREATE: "report.create",
  FIX_PROPOSAL_CREATE: "fix_proposal.create",
  RETEST_CREATE: "retest.create",
  FIX_PR_CREATE: "fix_pr.create",
} as const

export type CanonicalOperation = (typeof CANONICAL_OPERATIONS)[keyof typeof CANONICAL_OPERATIONS]

export const AUTOMATION_WORKFLOWS = [
  {
    id: "scans",
    label: "Run PR Scans & Security Audits",
    description: "Scan code changes and pull requests automatically within budget.",
    operations: [CANONICAL_OPERATIONS.SCAN_CREATE],
  },
  {
    id: "retests",
    label: "Verify Fixes & Retests",
    description: "Validate remediated findings automatically after branch fixes.",
    operations: [CANONICAL_OPERATIONS.RETEST_CREATE],
  },
  {
    id: "proposals",
    label: "Record Fix Proposals & Plans",
    description: "Save proposed remediation patches and structured fix plans.",
    operations: [CANONICAL_OPERATIONS.FIX_PROPOSAL_CREATE],
  },
  {
    id: "reports",
    label: "Create Security Reports",
    description: "Create security reports for authorized targets.",
    operations: [CANONICAL_OPERATIONS.REPORT_CREATE],
  },
  {
    id: "fix_prs",
    label: "Create Fix Pull Requests",
    description: "Create approval-bound pull requests for authorized findings.",
    operations: [CANONICAL_OPERATIONS.FIX_PR_CREATE],
  },
] as const
