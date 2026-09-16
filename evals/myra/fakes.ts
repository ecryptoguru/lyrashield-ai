/**
 * In-memory fakes for the Myra eval harness. Used by `run.ts` and reusable
 * by unit tests that need a server `db` without Postgres.
 *
 * `FakeMyraStore` mimics the `MyraDb` surface the server pipeline consumes:
 * `db.<model>.findUnique/findFirst/findMany/create/update/updateMany/
 * upsert/deleteMany/count` with a useful subset of Prisma `where` semantics
 * (equality, null, in/notIn/not, lt/lte/gt/gte on dates+numbers, contains,
 * OR/AND/NOT, compound-unique objects, select/orderBy/take) plus a naive
 * `$queryRaw` that stands in for Postgres FTS over `myraKnowledgeEntry`.
 *
 * Supported where operators are exactly the ones the server uses; an
 * unrecognized operator throws loudly rather than silently mis-matching.
 *
 * Nothing here talks to a database, network or wall clock beyond Date.now()
 * for row timestamps.
 */
import { createHash } from "node:crypto"
import type { MyraPrincipal } from "../../packages/myra/src/contracts"
import { MYRA_MEMORY_KEYS, isAllowedMemoryWrite } from "../../packages/myra/src/memory-keys"

// ─── Generic Prisma-ish table ──────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string }
type Where = Record<string, unknown>

const OP_KEYS = new Set(["in", "notIn", "not", "lt", "lte", "gt", "gte", "contains", "equals"])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !(v instanceof Date) && !Array.isArray(v)
}

function scalarEq(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : Date.parse(String(a))
    const tb = b instanceof Date ? b.getTime() : Date.parse(String(b))
    return ta === tb
  }
  return a === b
}

function compare(a: unknown, b: unknown): number {
  const ta = a instanceof Date ? a.getTime() : a
  const tb = b instanceof Date ? b.getTime() : b
  if (typeof ta === "number" && typeof tb === "number") return ta - tb
  if (typeof ta === "string" && typeof tb === "string") return ta < tb ? -1 : ta > tb ? 1 : 0
  return String(ta) < String(tb) ? -1 : String(ta) > String(tb) ? 1 : 0
}

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (isPlainObject(cond)) {
    const keys = Object.keys(cond)
    const isOperatorBlock = keys.some((k) => OP_KEYS.has(k))
    if (isOperatorBlock) {
      for (const [op, operand] of Object.entries(cond)) {
        switch (op) {
          case "in":
            if (!(operand as unknown[]).some((o) => scalarEq(value, o))) return false
            break
          case "notIn":
            if ((operand as unknown[]).some((o) => scalarEq(value, o))) return false
            break
          case "not":
            if (operand === null) {
              if (value === null || value === undefined) return false
            } else if (scalarEq(value, operand)) return false
            break
          case "lt":
            if (!(compare(value, operand) < 0)) return false
            break
          case "lte":
            if (!(compare(value, operand) <= 0)) return false
            break
          case "gt":
            if (!(compare(value, operand) > 0)) return false
            break
          case "gte":
            if (!(compare(value, operand) >= 0)) return false
            break
          case "contains":
            if (typeof value !== "string" || !value.includes(String(operand))) return false
            break
          case "equals":
            if (!scalarEq(value, operand)) return false
            break
          default:
            throw new Error(`FakeMyraStore: unsupported operator ${op}`)
        }
      }
      return true
    }
    // Plain nested object without operators: match each subfield on the
    // row's own value (JSON-field filters and compound shapes).
    return Object.entries(cond).every(([subKey, subVal]) =>
      fieldMatches((value as Record<string, unknown> | undefined)?.[subKey], subVal)
    )
  }
  return scalarEq(value, cond)
}

function rowMatches(row: Row, where: Where | undefined): boolean {
  if (!where) return true
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Where[]).some((w) => rowMatches(row, w))) return false
      continue
    }
    if (key === "AND") {
      if (!(cond as Where[]).every((w) => rowMatches(row, w))) return false
      continue
    }
    if (key === "NOT") {
      if (rowMatches(row, cond as Where)) return false
      continue
    }
    // Compound unique form: the where key itself is not a row field — expand.
    if (!(key in row) && isPlainObject(cond) && !Object.keys(cond).some((k) => OP_KEYS.has(k))) {
      const all = Object.entries(cond).every(([subKey, subVal]) =>
        fieldMatches(row[subKey], subVal)
      )
      if (!all) return false
      continue
    }
    if (!fieldMatches(row[key], cond)) return false
  }
  return true
}

function project<T extends Row>(row: T, select?: Record<string, boolean>): Row {
  if (!select) return { ...row }
  const out: Row = { id: row.id }
  for (const [k, on] of Object.entries(select)) {
    if (on) out[k] = row[k]
  }
  return out
}

interface Query {
  where?: Where
  orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[]
  take?: number
  select?: Record<string, boolean>
}

let fakeSeq = 0

/** Minimal Prisma model delegate backed by a Map. */
export class FakeTable<T extends Row = Row> {
  readonly rows = new Map<string, T>()

  constructor(private readonly defaults: () => Partial<T> = () => ({})) {}

  private newId(): string {
    return `fake_${++fakeSeq}`
  }

  private sortRows(rows: T[], orderBy?: Query["orderBy"]): T[] {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
    const sorted = [...rows]
    sorted.sort((a, b) => {
      for (const clause of clauses) {
        for (const [field, dir] of Object.entries(clause)) {
          const c = compare(a[field], b[field])
          if (c !== 0) return dir === "desc" ? -c : c
        }
      }
      return 0
    })
    return sorted
  }

  async findUnique(q: { where: Where; select?: Record<string, boolean> }): Promise<Row | null> {
    for (const row of this.rows.values()) {
      if (rowMatches(row, q.where)) return project(row, q.select)
    }
    return null
  }

  async findUniqueOrThrow(q: { where: Where; select?: Record<string, boolean> }): Promise<Row> {
    const row = await this.findUnique(q)
    if (!row) throw new Error("FakeMyraStore: record not found")
    return row
  }

  async findFirst(q: Query = {}): Promise<Row | null> {
    const rows = this.sortRows(
      [...this.rows.values()].filter((r) => rowMatches(r, q.where)),
      q.orderBy
    )
    const row = rows[0]
    return row ? project(row, q.select) : null
  }

  async findMany(q: Query = {}): Promise<Row[]> {
    let rows = this.sortRows(
      [...this.rows.values()].filter((r) => rowMatches(r, q.where)),
      q.orderBy
    )
    if (typeof q.take === "number") rows = rows.slice(0, q.take)
    return rows.map((r) => project(r, q.select))
  }

  async create(q: {
    data: Record<string, unknown>
    select?: Record<string, boolean>
  }): Promise<Row> {
    const now = new Date()
    const row = {
      id: this.newId(),
      ...this.defaults(),
      ...q.data,
      createdAt: (q.data.createdAt as Date) ?? now,
      updatedAt: (q.data.updatedAt as Date) ?? now,
    } as unknown as T
    this.rows.set(row.id, row)
    return project(row, q.select)
  }

  async update(q: {
    where: Where
    data: Record<string, unknown>
    select?: Record<string, boolean>
  }): Promise<Row> {
    const found = await this.findUnique({ where: q.where })
    if (!found) throw new Error("FakeMyraStore: update target not found")
    const row = this.rows.get(found.id)! as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(q.data)) {
      if (isPlainObject(v) && typeof (v as { increment?: unknown }).increment === "number") {
        row[k] = (Number(row[k]) || 0) + (v as { increment: number }).increment
      } else {
        row[k] = v
      }
    }
    row.updatedAt = new Date()
    return project(row as T, q.select)
  }

  async updateMany(q: {
    where?: Where
    data: Record<string, unknown>
  }): Promise<{ count: number }> {
    let count = 0
    for (const row of this.rows.values()) {
      if (!rowMatches(row, q.where)) continue
      const r = row as unknown as Record<string, unknown>
      for (const [k, v] of Object.entries(q.data)) {
        if (isPlainObject(v) && typeof (v as { increment?: unknown }).increment === "number") {
          r[k] = (Number(r[k]) || 0) + (v as { increment: number }).increment
        } else {
          r[k] = v
        }
      }
      r.updatedAt = new Date()
      count++
    }
    return { count }
  }

  async deleteMany(q: { where?: Where } = {}): Promise<{ count: number }> {
    let count = 0
    for (const [id, row] of [...this.rows]) {
      if (rowMatches(row, q.where)) {
        this.rows.delete(id)
        count++
      }
    }
    return { count }
  }

  async upsert(q: {
    where: Where
    create: Record<string, unknown>
    update: Record<string, unknown>
  }): Promise<Row> {
    const existing = await this.findUnique({ where: q.where })
    if (existing) return this.update({ where: { id: existing.id }, data: q.update })
    return this.create({ data: q.create })
  }

  async count(q: { where?: Where } = {}): Promise<number> {
    return [...this.rows.values()].filter((r) => rowMatches(r, q.where)).length
  }
}

// ─── Store ─────────────────────────────────────────────────────────────────

/**
 * Drop-in `db` for the Myra server pipeline (all functions take an
 * injectable `db` param and accept any object with this delegate surface —
 * `withOwnerScope` passes `db` straight through when it isn't the real
 * prisma client).
 */
export class FakeMyraStore {
  readonly myraPublicSession = new FakeTable()
  readonly myraConversation = new FakeTable()
  readonly myraMessage = new FakeTable()
  readonly myraFlowSession = new FakeTable()
  readonly myraOperation = new FakeTable()
  readonly myraMemory = new FakeTable()
  readonly myraKnowledgeRelease = new FakeTable()
  readonly myraKnowledgeEntry = new FakeTable()
  readonly myraIdentityVerification = new FakeTable()
  readonly myraAuditEvent = new FakeTable()
  readonly supportCase = new FakeTable()
  readonly supportCaseReply = new FakeTable()
  readonly demoBooking = new FakeTable()
  readonly user = new FakeTable()
  readonly target = new FakeTable()
  readonly workspace = new FakeTable()
  readonly workspaceMember = new FakeTable()
  readonly scan = new FakeTable()
  readonly connection = new FakeTable()

  /** Notification deliveries — separate fact from case persistence. */
  notifications: {
    caseId: string
    status: "queued" | "delivered" | "failed"
    error: string | null
  }[] = []

  flags = {
    /** Not currently wired into the server (the notifier seam lives in
     *  @lyrashield/integrations); kept for when it becomes injectable. */
    notificationFails: false,
    calendarConfigured: true,
  }

  reset(): void {
    for (const t of [
      this.myraPublicSession,
      this.myraConversation,
      this.myraMessage,
      this.myraFlowSession,
      this.myraOperation,
      this.myraMemory,
      this.myraKnowledgeRelease,
      this.myraKnowledgeEntry,
      this.myraIdentityVerification,
      this.myraAuditEvent,
      this.supportCase,
      this.supportCaseReply,
      this.demoBooking,
      this.user,
      this.workspaceMember,
      this.target,
      this.workspace,
      this.scan,
      this.connection,
    ]) {
      t.rows.clear()
    }
    this.notifications = []
    this.flags = { notificationFails: false, calendarConfigured: true }
  }

  /**
   * Stand-in for Postgres FTS used by searchKnowledge(). Detects the KB
   * query by table name, applies the audience/allowedRoles filter baked into
   * the SQL text (+ the role bind value), then scores by token overlap.
   * Anything unrecognized returns [] — fail-closed for a fake.
   */
  async $queryRaw(
    query: { text?: string; strings?: string[]; values?: unknown[] } | string
  ): Promise<Row[]> {
    const text =
      typeof query === "string" ? query : (query.strings ?? []).join("?") + (query.text ?? "")
    if (!text.includes("myra_knowledge_entries")) return []
    const values = typeof query === "object" ? (query.values ?? []) : []
    const roleParam = values.find((v) => typeof v === "string" && /^[A-Z_]+$/.test(v)) as
      string | undefined
    const queryText =
      values
        .filter((v): v is string => typeof v === "string")
        .sort((a, b) => b.length - a.length)[0] ?? ""
    const allowRestricted = text.includes("'RESTRICTED'")
    const tokens = queryText
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2)
    const out: Row[] = []
    for (const e of this.myraKnowledgeEntry.rows.values()) {
      if (e.status !== "ACTIVE") continue
      if (!allowRestricted && e.audience !== "PUBLIC") continue
      const roles = (e.allowedRoles as string[]) ?? []
      if (roles.length > 0 && (!roleParam || !roles.includes(roleParam))) continue
      const hay = `${String(e.title)} ${String(e.topic ?? "")} ${String(e.content)}`.toLowerCase()
      const hits = tokens.filter((t) => hay.includes(t)).length
      const rank = tokens.length ? hits / tokens.length : 0
      if (rank >= 0.01 && hits > 0) {
        out.push({
          id: e.id,
          title: e.title,
          sourceUrl: e.sourceUrl ?? null,
          topic: e.topic ?? "general",
          snippet: String(e.content).slice(0, 400),
          rank,
        })
      }
    }
    return out.sort((a, b) => (b.rank as number) - (a.rank as number)).slice(0, 10)
  }

  // ── convenience accessors for assertions ──

  bookingRows(): Row[] {
    return [...this.demoBooking.rows.values()]
  }

  operationRows(): Row[] {
    return [...this.myraOperation.rows.values()]
  }

  caseRows(): Row[] {
    return [...this.supportCase.rows.values()]
  }

  memoryRowsFor(accountId: string): Row[] {
    return [...this.myraMemory.rows.values()].filter((r) => r.accountId === accountId)
  }

  messageTexts(): string[] {
    return [...this.myraMessage.rows.values()].map((r) => String(r.content ?? ""))
  }

  takeOver(conversationId: string): void {
    const row = this.myraConversation.rows.get(conversationId)
    if (row) {
      row.humanTakeoverAt = new Date()
      row.state = "TAKEOVER"
    }
  }

  /** True when every stored memory key/value passes the §13.4 allowlist. */
  memoryIsAllowlisted(accountId: string): boolean {
    return this.memoryRowsFor(accountId).every(
      (r) =>
        (MYRA_MEMORY_KEYS as readonly string[]).includes(String(r.key)) &&
        isAllowedMemoryWrite(String(r.key), r.value)
    )
  }
}

// ─── Scenario → store seeding ──────────────────────────────────────────────

export interface ScenarioSetup {
  workspace?: { id?: string; plan?: string }
  account?: { id?: string; email?: string; trialMinutesRemaining?: number }
  role?: string
  conversation?: {
    id?: string
    takenOver?: boolean
    messages?: { role: "USER" | "ASSISTANT" | "TOOL_EVENT"; text: string }[]
    flowState?: { flowId: string; stepIndex: number }
  }
  knowledgeEntries?: {
    id: string
    title: string
    /** Friendly alias — maps to MyraKnowledgeEntry.content. */
    body: string
    audience?: "public" | "restricted" | "PUBLIC" | "RESTRICTED"
    roles?: string[]
    sourceUrl?: string | null
    topic?: string
  }[]
  operations?: {
    id: string
    operationName: string
    status: string
    payload: Record<string, unknown>
    accountId?: string | null
    publicSessionId?: string | null
    workspaceId?: string | null
    conversationId?: string | null
    idempotencyKey?: string | null
    expiresAt?: string | null
    /** Set false to seed a mismatched inputHash (tampered-payload state). */
    hashMatchesPayload?: boolean
  }[]
  bookings?: {
    id: string
    email: string
    name?: string
    startsAt: string
    endsAt: string
    status?: string
    providerEventId?: string | null
    meetLink?: string | null
    meetPending?: boolean
    manageToken?: string | null
    accountId?: string | null
  }[]
  cases?: {
    id: string
    subject: string
    summary: string
    status?: string
    reference?: string
    replyDestination?: string
    notificationState?: string
  }[]
  memory?: Record<string, unknown>
  /** Seed monthly spend at the cap so checkBudget() denies generation. */
  budgetExhausted?: boolean
  notificationFails?: boolean
}

/** Keep in sync with server/operations.ts hashOperationPayload. */
export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

const FAR_FUTURE = new Date("2099-01-01T00:00:00Z")

/** Seed a fresh FakeMyraStore from a scenario `setup` block. */
export function seedStore(
  setup: ScenarioSetup | undefined,
  principal: MyraPrincipal
): FakeMyraStore {
  const store = new FakeMyraStore()
  if (!setup) return store

  store.flags.notificationFails = setup.notificationFails === true

  const accountId = principal.kind === "anonymous" ? null : principal.accountId
  const publicSessionId = principal.kind === "anonymous" ? principal.publicSessionId : null
  const workspaceId = principal.kind === "user" ? principal.workspaceId : null

  if (accountId) {
    store.user.rows.set(accountId, {
      id: accountId,
      email: setup.account?.email ?? "eval@example.com",
    })
  }

  // A user principal in a workspace implies an active membership row —
  // the confirmation engine re-validates it at execution time.
  if (principal.kind === "user" && workspaceId && accountId) {
    store.workspaceMember.rows.set(`${workspaceId}:${accountId}`, {
      id: `wm_${workspaceId}_${accountId}`,
      workspaceId,
      userId: accountId,
      role: setup.role ?? "MEMBER",
      status: "active",
    })
  }

  if (setup.conversation || principal.kind !== "operator") {
    const conv = setup.conversation
    const convId = conv?.id ?? "conv_eval"
    store.myraConversation.rows.set(convId, {
      id: convId,
      surface: "DASHBOARD",
      state: conv?.takenOver ? "TAKEOVER" : "ACTIVE",
      accountId,
      publicSessionId,
      workspaceId,
      routeContext: null,
      humanTakeoverAt: conv?.takenOver ? new Date() : null,
      expiresAt: FAR_FUTURE,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    for (const [i, m] of (conv?.messages ?? []).entries()) {
      store.myraMessage.rows.set(`msg_${convId}_${i}`, {
        id: `msg_${convId}_${i}`,
        conversationId: convId,
        role: m.role,
        content: m.text,
        createdAt: new Date(),
      })
    }
    if (conv?.flowState) {
      store.myraFlowSession.rows.set(`flow_${convId}`, {
        id: `flow_${convId}`,
        conversationId: convId,
        flowId: conv.flowState.flowId,
        stepIndex: conv.flowState.stepIndex,
        status: "ACTIVE",
        state: { workspaceId },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }
  }

  for (const entry of setup.knowledgeEntries ?? []) {
    store.myraKnowledgeEntry.rows.set(entry.id, {
      id: entry.id,
      releaseId: "rel_eval",
      sourceId: entry.id,
      topic: entry.topic ?? "general",
      audience: (entry.audience ?? "public").toUpperCase(),
      allowedRoles: entry.roles ?? [],
      title: entry.title,
      content: entry.body,
      sourceUrl: entry.sourceUrl ?? null,
      capabilityStatus: "available",
      status: "ACTIVE",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  for (const op of setup.operations ?? []) {
    store.myraOperation.rows.set(op.id, {
      id: op.id,
      operationName: op.operationName,
      status: op.status,
      accountId: op.accountId !== undefined ? op.accountId : accountId,
      publicSessionId: op.publicSessionId !== undefined ? op.publicSessionId : publicSessionId,
      workspaceId: op.workspaceId !== undefined ? op.workspaceId : workspaceId,
      conversationId: op.conversationId !== undefined ? op.conversationId : "conv_eval",
      inputHash: op.hashMatchesPayload === false ? "mismatch" : hashPayload(op.payload),
      payload: op.payload,
      idempotencyKey: op.idempotencyKey ?? `idem_${op.id}`,
      expiresAt: op.expiresAt ? new Date(op.expiresAt) : FAR_FUTURE,
      result: null,
      error: null,
      executedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  for (const b of setup.bookings ?? []) {
    const start = new Date(b.startsAt)
    const end = new Date(b.endsAt)
    store.demoBooking.rows.set(b.id, {
      id: b.id,
      status: b.status ?? "CONFIRMED",
      attendeeEmail: b.email,
      attendeeName: b.name ?? "Eval User",
      startsAt: start,
      endsAt: end,
      holdStartsAt: start,
      holdEndsAt: new Date(end.getTime() + 15 * 60_000), // trailing buffer
      timezone: "Asia/Kolkata",
      organizerEmail: "ankit@lyrashieldai.com",
      providerEventId: b.providerEventId ?? null,
      meetLink: b.meetLink ?? null,
      conferenceState: b.meetPending ? "pending" : b.meetLink ? "ready" : "none",
      manageTokenHash: b.manageToken ?? null,
      idempotencyKey: `idem_${b.id}`,
      accountId: b.accountId !== undefined ? b.accountId : accountId,
      publicSessionId: null,
      conversationId: "conv_eval",
      attendeeVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  for (const c of setup.cases ?? []) {
    store.supportCase.rows.set(c.id, {
      id: c.id,
      reference: c.reference ?? `LS-${c.id.toUpperCase()}`,
      status: c.status ?? "NEW",
      subject: c.subject,
      summary: c.summary,
      replyEmail: c.replyDestination ?? "eval@example.com",
      notificationState: c.notificationState ?? "pending",
      accountId,
      publicSessionId,
      workspaceId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  if (setup.memory && accountId) {
    for (const [key, value] of Object.entries(setup.memory)) {
      store.myraMemory.rows.set(`${accountId}:${key}`, {
        id: `${accountId}:${key}`,
        accountId,
        key,
        value,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }
  }

  if (setup.budgetExhausted) {
    // checkBudget() sums metadata.costUsd on myra.generate events this month.
    store.myraAuditEvent.rows.set("audit_budget_cap", {
      id: "audit_budget_cap",
      actorType: "system",
      action: "myra.generate",
      resourceType: "trace",
      resourceId: "eval",
      metadata: { costUsd: 999 },
      createdAt: new Date(),
    })
  }

  return store
}

// ─── Mock provider ─────────────────────────────────────────────────────────

export interface EvalProviderCall {
  input: unknown
}

export interface EvalProviderResult {
  text: string
  usage: { inTokens: number; outTokens: number; costUsd: number }
}

interface ToolOutputLike {
  name?: string
  output?: Record<string, unknown>
}

/**
 * Deterministic ModelProvider for the harness. `name` is deliberately not
 * "mock" — loop.ts exempts the literal name "mock" from the budget gate, and
 * the budget-exhausted scenario must see the gate actually engage.
 *
 * `generate` composes a short answer from the deterministic tool outputs the
 * loop hands it — the same contract the server's own MockProvider uses —
 * plus an explicit `script` hook for fixtures that need a canned phrase.
 * Every call is recorded so providerCalls/mustNotContain assertions scan
 * exactly what left for the model.
 */
export class MockProvider {
  readonly name = "eval-mock"
  calls: EvalProviderCall[] = []
  script: ((input: unknown) => string) | null = null

  async generate(input: unknown): Promise<EvalProviderResult> {
    this.calls.push({ input })
    const text = this.script ? this.script(input) : composeFromToolOutputs(input)
    return { text, usage: { inTokens: 0, outTokens: 0, costUsd: 0 } }
  }
}

function composeFromToolOutputs(input: unknown): string {
  const ctx = (input as { context?: { toolOutputs?: ToolOutputLike[]; intent?: string } })?.context
  const outs = ctx?.toolOutputs ?? []
  const data = (name: string) => outs.find((t) => t.name === name)?.output

  const catalog = data("read_product_catalog")
  if (catalog && Array.isArray(catalog.plans)) {
    const names = (catalog.plans as { name: string; monthlyUsd: number | null }[])
      .map((p) => `${p.name} $${p.monthlyUsd ?? "custom"}/mo`)
      .join(", ")
    return `Current Cloud plans (checked just now): ${names}. Prices exclude tax; Enterprise is custom. See /pricing.`
  }
  const my = data("get_my_context")
  if (my) {
    return (
      `Your plan is ${String(my.planName ?? my.plan ?? "unknown")} and you have ` +
      `${String(my.minutesRemaining ?? "0")} agent-minutes remaining` +
      (my.isTrial ? ` (${String(my.trialDaysLeft ?? "?")} trial days left).` : ".")
    )
  }
  const flow = data("start_guided_flow")
  if (flow) return "I've started a guided check — follow the step shown and I'll re-verify it."
  const manage = data("manage_own_demo")
  const bookings =
    (manage?.bookings as
      { status?: string; conferenceState?: string; startsAt?: string }[] | undefined) ?? []
  if (manage && bookings.length) {
    const latest = bookings[0]!
    if (latest.status === "OUTCOME_UNKNOWN") {
      return "I'm still checking whether your booking went through — you do not need to submit it again."
    }
    if (latest.status === "CONFIRMED" && latest.conferenceState === "pending") {
      return "Your booking is confirmed. We are still preparing the Meet link."
    }
    if (latest.status === "CONFIRMED") {
      return `Your demo is booked for ${latest.startsAt}.`
    }
    if (latest.status === "CANCELED") {
      return "That demo booking is canceled. I can help you pick a new time."
    }
  }
  const help = data("search_public_help")
  if (help && typeof help.hitCount === "number" && help.hitCount > 0) {
    const snippets = ((help.hits as { snippet?: string }[] | undefined) ?? [])
      .map((h) => h.snippet)
      .filter(Boolean)
      .join(" ")
    return `Here's what our documentation says — see the sources below. ${snippets}`
  }
  if (help && help.abstained === true) {
    return "I don't have a sourced answer for that. You can also contact support through our support page."
  }
  return "I don't have enough information to answer that from the available sources. You can also contact support through our support page."
}
