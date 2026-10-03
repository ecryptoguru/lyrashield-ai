import { renderToStaticMarkup } from "react-dom/server"
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void>,
}))

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef(initial: unknown) {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = { current: initial }
    return hooks.values[index]
  },
  useState(initial: unknown) {
    const index = hooks.cursor++
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === "function" ? initial() : initial
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value
      },
    ]
  },
  useEffect(effect: () => void) {
    hooks.effects.push(effect)
  },
}))

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <a {...props}>{children}</a>
  ),
}))

vi.mock("lucide-react", () => {
  const Icon = (props: Record<string, unknown>) => <span aria-hidden="true" {...props} />
  return {
    AlertCircle: Icon,
    Check: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    Clock: Icon,
    Play: Icon,
  }
})

vi.mock("@lyrashield/ui", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
  FormField: ({
    label,
    htmlFor,
    children,
  }: {
    label: ReactNode
    htmlFor: string
    children: ReactNode
  }) => (
    <div>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  ),
  Input: (props: Record<string, unknown>) => <input {...props} />,
  Select: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <select {...props}>{children}</select>
  ),
  Spinner: () => <span aria-hidden="true" />,
}))

vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => <span /> }))
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetContent: ({
    children,
    onOpenAutoFocus: _onOpenAutoFocus,
    onCloseAutoFocus: _onCloseAutoFocus,
    ...props
  }: { children: ReactNode; onOpenAutoFocus?: unknown; onCloseAutoFocus?: unknown } & Record<
    string,
    unknown
  >) => <section {...props}>{children}</section>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

import { CreateScanSheet } from "./create-scan-sheet"
import type { ManualScanOption } from "@/lib/scan-presets"
import type { ScanEligibilityState, TargetItem } from "./scan-types"

const option: ManualScanOption = {
  id: "CODE_REVIEW",
  label: "Code scan",
  description: "Broader repository and dependency analysis.",
  hint: "Dependency checks across the repository.",
  goal: "TEST_APP",
  mode: "STANDARD",
  estimate: { low: 12, high: 23 },
  available: true,
  usesAi: true,
  workflow: "REVIEW_TARGET",
  scopeSummary: "The full repository snapshot.",
  limitsSummary: "Up to 20 minutes.",
  applicableChecks: ["Dependencies"],
}
const targets: TargetItem[] = [
  {
    id: "target-1",
    name: "Example repository",
    type: "REPO",
    url: null,
    apiSpecUrl: null,
    repoFullName: "org/example",
  },
]
const readyEligibility: ScanEligibilityState = {
  status: "ready",
  eligibility: {
    allowed: true,
    code: null,
    message: null,
    plan: "PRO",
    isTrial: false,
    remainingMinutes: 50,
  },
}

const defaults: ComponentProps<typeof CreateScanSheet> = {
  open: true,
  onOpenChange: vi.fn(),
  isDesktop: true,
  errorCode: null,
  errorMessage: null,
  scanRecoveryError: null,
  targets,
  selectedTarget: "target-1",
  handleSelectTarget: vi.fn(),
  availableOptions: [option],
  enabledOptions: [option],
  selectedOption: option,
  choosePreset: vi.fn(),
  modeResetNotice: null,
  selectedFocus: null,
  setSelectedFocus: vi.fn(),
  reviewSetupGuidance: null,
  eligibility: readyEligibility,
  setEligibilityAttempt: vi.fn(),
  canManageBilling: true,
  startingTrial: false,
  handleStartTrial: vi.fn(async () => {}),
  startDisabled: false,
  creating: false,
  handleCreateScan: vi.fn(async () => {}),
  showAdvanced: false,
  setShowAdvanced: vi.fn(),
  baseRef: "",
  setBaseRef: vi.fn(),
  headRef: "",
  setHeadRef: vi.fn(),
  attachments: [],
  selectedAttachments: [],
  toggleAttachment: vi.fn(),
}

function render(props: Partial<typeof defaults> = {}) {
  hooks.cursor = 0
  hooks.effects = []
  return renderToStaticMarkup(<CreateScanSheet {...defaults} {...props} />)
}

function renderTree(props: Partial<typeof defaults> = {}) {
  hooks.cursor = 0
  hooks.effects = []
  return CreateScanSheet({ ...defaults, ...props })
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean
): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found) return found
    }
    return null
  }
  if (!isValidElement(node)) return null
  if (predicate(node)) return node
  if (typeof node.type === "function") {
    const renderComponent = node.type as (props: Record<string, unknown>) => ReactNode
    const found = findElement(renderComponent(node.props as Record<string, unknown>), predicate)
    if (found) return found
  }
  return findElement((node.props as { children?: ReactNode }).children, predicate)
}

function flushEffects() {
  const effects = hooks.effects
  hooks.effects = []
  for (const effect of effects) effect()
}

describe("scan creation error recovery", () => {
  beforeEach(() => {
    hooks.values = []
    hooks.cursor = 0
    hooks.effects = []
    vi.clearAllMocks()
  })

  it("keeps submission errors and billing recovery beside the fixed Start action", () => {
    const html = render({
      errorCode: "NO_MINUTES_REMAINING",
      errorMessage: "There are not enough agent minutes.",
    })

    expect(html).toMatch(/role="group" aria-label="Scan submission"[\s\S]*role="alert"/)
    expect(html).toContain('aria-live="assertive"')
    expect(html).toContain("There are not enough agent minutes.")
    expect(html).toContain('href="/dashboard/billing"')
    expect(html).toContain("Review billing options")
    expect(html).toMatch(/role="group" aria-label="Scan submission"[\s\S]*Start Scan/)
  })

  it("hides an obsolete submission error after reopen but retains unresolved recovery state", () => {
    render({ errorMessage: "Old submission failure" })
    flushEffects()

    render({ open: false, errorMessage: "Old submission failure" })
    flushEffects()

    render({
      open: true,
      errorMessage: "Old submission failure",
      scanRecoveryError: "The previous scan start is still unresolved.",
    })
    flushEffects()

    const reopened = render({
      open: true,
      errorMessage: "Old submission failure",
      scanRecoveryError: "The previous scan start is still unresolved.",
    })
    expect(reopened).not.toContain("Old submission failure")
    expect(reopened).toContain("The previous scan start is still unresolved.")
  })

  it("moves focus to a newly announced submission error", () => {
    renderTree()
    flushEffects()

    const tree = renderTree({ errorMessage: "The scan could not start." })
    const alert = findElement(
      tree,
      (element) => (element.props as { role?: string }).role === "alert"
    )
    expect(alert).not.toBeNull()
    expect((alert!.props as { tabIndex?: number }).tabIndex).toBe(-1)
    const focus = vi.fn()
    const ref = (alert!.props as { ref: { current: HTMLDivElement | null } }).ref
    ref.current = { focus } as unknown as HTMLDivElement
    flushEffects()

    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })
})
