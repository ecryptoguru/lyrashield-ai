# AI Assurance Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend LyraShield from evidence-backed application and agent security scanning into an evidence-backed AI assurance workflow, without claiming model certification, regulatory compliance, or universal adversarial robustness.

**Architecture:** Build on the existing immutable `ScanCoverageReceipt` and `ScanResultManifest` contracts. Add target-scoped AI system profiles, versioned human/operational control evidence, and versioned threat models; evaluate these deterministically into an AI assurance assessment. Keep framework mappings as reviewed, versioned source code—not mutable customer data—and freeze the resulting assessment in the existing report snapshot. Treat live AI endpoint testing as a later, separately authorized target capability.

**Tech Stack:** Next.js App Router, React, TypeScript, Zod, Prisma/PostgreSQL with FORCE RLS, S3-compatible encrypted evidence storage, Vitest, Playwright, existing `@lyrashield/security`, `@lyrashield/db`, `@lyrashield/auth`, and `@lyrashield/ui` packages.

## Current evidence matrix (2026-08-14)

| Area                                         | State            | Evidence boundary                                                                                                                                                                               |
| -------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Score isolation and private scan projection  | Complete locally | Forced RLS/service tests, evidence-qualified immutable scoring inputs, and private no-store projection exist; CI/deployed proof remains required.                                               |
| Evidence Vault storage and evidence versions | Partial          | Streaming upload limits, encrypted storage compensation, stale review, reasoned `NOT_APPLICABLE`, and private report freezing are implemented locally; full browser/release proof remains open. |
| AI System Profile and Threat Model APIs      | Partial          | Versioned APIs, accessible target editors, Markdown template/export, and report state snapshots exist; full browser/release proof remains open.                                                 |
| Assessment and framework crosswalk           | Partial          | OWASP-only static readiness mapping is implemented locally; immutable assessment records, UI, non-OWASP approval, and release proof remain open.                                                |
| Deterministic AI/ML rules                    | Partial          | Bounded direct AI data/MCP and ML supply-chain findings plus a deterministic fixture report are integrated locally; browser/worker parity, CI, and deployment proof remain open.                |
| Live AI safety beta and freshness operations | Partial          | A non-destructive authorization contract exists; execution, approved endpoint/credential, daily freshness sweep, and operational release gates remain open.                                     |

Only the final commit's migration, privacy, UX, local/CI/deployment, and manual-review evidence may move a row to `Complete` for release.

## Global Constraints

- Preserve the `@lyrashield/*` package scope and `LYRASHIELD_*` environment-variable names.
- Do not change the semantics of `DETECTED`, `NO_FINDING`, `INCONCLUSIVE`, `NOT_APPLICABLE`, `EVIDENCE_REQUIRED`, `VALIDATED`, or `VERIFIED`.
- A framework crosswalk is **readiness mapping**, never an NIST AI RMF / EU AI Act compliance certification or legal advice.
- No LLM decides a control outcome. LLM review may create a candidate; deterministic checks and accepted customer evidence decide status.
- User-supplied evidence is private by default. Public reports and scorecards must never include AI profile fields, evidence text, artifact URIs, threat-model details, or framework status unless a future explicit public-sharing design is approved.
- Human evidence is append-only: corrections create a new version; prior versions remain auditable. Never overwrite or mutate a prior acceptance decision.
- Use `withWorkspaceRLS()` for every workspace-scoped read/write and add new root models to `WORKSPACE_SCOPED_MODELS`; child tables receive join-based FORCE RLS policies and an integration reproduction.
- Maintain 20 MiB total upload limit, five files per evidence version, accepted MIME types `application/pdf`, `image/png`, `image/jpeg`, and `text/plain`; reject archives and office documents in v1.
- Reuse the current S3-compatible encrypted storage contract. Do not send artifacts, prompts, or model outputs to an LLM.
- Existing repository scans use their current engine policy; URL/API scans remain non-mutating. Never relabel URL/API Deep as a full pentest.
- No new external service is needed for Releases A–C. Framework/legal review and customer-supplied operational evidence are human dependencies; Release D requires a separately authorized test endpoint and test account.

---

## Delivery boundaries

| Release | Deliverable                                                                          |                                       Needs LLM | External / human dependency                                                   | Exit condition                                                                           |
| ------- | ------------------------------------------------------------------------------------ | ----------------------------------------------: | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A       | Operational Evidence Vault for seven existing evidence-required controls             |                                              No | Customer uploads/attests evidence                                             | A report freezes accepted/expired/missing evidence state per selected scan.              |
| B       | Threat Model Workspace and AI System Profile                                         |                                              No | Accountable customer owner supplies system facts                              | Target has versioned profile and threat model; incomplete answers remain `NOT_ASSESSED`. |
| C       | Deterministic framework crosswalk, AI data-exposure review, and MCP permission audit |       Optional only for existing engine context | Security/compliance owner approves mappings                                   | Deterministic findings and evidence map to a versioned readiness result.                 |
| D       | Prompt/tool safety test pack and ML supply-chain inventory                           | No for assertions; optional LLM for triage only | Authorized repository/API/test tenant; model/API credits if live              | Test case outcomes are replayable and authorization-bound.                               |
| E       | Adversarial live-model/API testing                                                   |                                       Sometimes | Written rules of engagement, test account, endpoint, budget, incident contact | Isolated beta; no general endpoint scanning.                                             |

## Data model and API contract

Use these exact names so UI, services, report generation, and tests agree.

```ts
export const AI_ASSURANCE_CONTROL_IDS = [
  "vibe-34",
  "vibe-35",
  "vibe-36",
  "vibe-43",
  "vibe-46",
  "vibe-48",
  "vibe-50",
] as const

export type AiAssuranceState =
  | "NOT_ASSESSED"
  | "EVIDENCE_REQUIRED"
  | "EVIDENCE_SUBMITTED"
  | "EVIDENCE_ACCEPTED"
  | "EVIDENCE_EXPIRED"
  | "NOT_APPLICABLE"

export interface AiSystemProfileInput {
  systemName: string
  systemPurpose: string
  modelProviders: Array<{ provider: string; model: string; deployment: string | null }>
  dataClasses: string[]
  dataSources: string[]
  storageSystems: string[]
  toolIntegrations: string[]
  retentionSummary: string | null
  humanOversightSummary: string | null
}

export interface ThreatModelInput {
  title: string
  scope: string
  assets: Array<{ name: string; type: string; sensitivity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" }>
  trustBoundaries: Array<{ name: string; description: string }>
  threats: Array<{
    id: string
    title: string
    scenario: string
    likelihood: "LOW" | "MEDIUM" | "HIGH"
    impact: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
    mitigation: string
    testPlan: string
    ownerUserId: string | null
  }>
}
```

All `POST`/`PATCH` handlers take `workspaceId` in the JSON body and use Zod limits: profile scalar fields ≤ 4,000 characters; each array ≤ 50 entries; threat-model arrays ≤ 100 entries; each evidence attestation ≤ 4,000 characters. Never accept arbitrary JSON without schema validation.

### Task 1: Add the versioned AI-assurance data model and RLS contract

**Files:**

- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/<timestamp>_ai_assurance_governance/migration.sql`
- Modify: `packages/db/src/scoping.ts`
- Modify: `packages/db/src/extension.test.ts`
- Modify: `packages/db/src/rls.test.ts`
- Modify: `packages/db/src/rls-fail-closed.test.ts`
- Test: `packages/db/src/ai-assurance-service.test.ts`

**Consumes:** Existing `Target`, `Workspace`, `AuditLog`, `Report`, `withWorkspaceRLS`, and strict child-table RLS migration pattern.

**Produces:** `AiSystemProfile`, `ThreatModel`, `ThreatModelVersion`, `ControlEvidence`, `ControlEvidenceVersion`, and `AiAssuranceAssessment` Prisma models.

- [ ] **Step 1: Write database contract tests before editing the schema.**

```ts
it("does not reveal control evidence across workspaces", async () => {
  await expect(listControlEvidence({ workspaceId: otherWorkspaceId, targetId })).resolves.toEqual(
    []
  )
})

it("creates a new immutable version instead of overwriting accepted evidence", async () => {
  const original = await acceptControlEvidence({ workspaceId, evidenceId, reviewerId })
  const revised = await reviseControlEvidence({ workspaceId, evidenceId, attestation: "new proof" })
  expect(revised.id).not.toBe(original.id)
  expect(original.status).toBe("ACCEPTED")
})
```

- [ ] **Step 2: Run the focused test and confirm it fails because the service/models do not exist.**

Run: `pnpm exec vitest run packages/db/src/ai-assurance-service.test.ts`

Expected: failing import/type errors.

- [ ] **Step 3: Add only these schema models and relations.**

```prisma
model AiSystemProfile {
  id        String   @id @default(cuid())
  workspaceId String
  targetId  String   @unique
  version   Int      @default(1)
  profile   Json
  createdById String
  updatedById String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  target Target @relation(fields: [targetId], references: [id], onDelete: Cascade)
  @@index([workspaceId, updatedAt])
}

model ThreatModel {
  id String @id @default(cuid())
  workspaceId String
  targetId String
  currentVersionId String? @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  target Target @relation(fields: [targetId], references: [id], onDelete: Cascade)
  versions ThreatModelVersion[]
  @@unique([workspaceId, targetId])
}

model ThreatModelVersion {
  id String @id @default(cuid())
  threatModelId String
  version Int
  content Json
  checksum String
  createdById String
  createdAt DateTime @default(now())
  threatModel ThreatModel @relation(fields: [threatModelId], references: [id], onDelete: Cascade)
  @@unique([threatModelId, version])
}

model ControlEvidence {
  id String @id @default(cuid())
  workspaceId String
  targetId String
  controlId String
  currentVersionId String? @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  target Target @relation(fields: [targetId], references: [id], onDelete: Cascade)
  versions ControlEvidenceVersion[]
  @@unique([workspaceId, targetId, controlId])
}

model ControlEvidenceVersion {
  id String @id @default(cuid())
  controlEvidenceId String
  version Int
  status String
  attestation String
  reviewedById String?
  reviewedAt DateTime?
  expiresAt DateTime?
  artifactManifest Json
  checksum String
  createdById String
  createdAt DateTime @default(now())
  evidence ControlEvidence @relation(fields: [controlEvidenceId], references: [id], onDelete: Cascade)
  @@unique([controlEvidenceId, version])
  @@index([status, expiresAt])
}
```

Add `aiSystemProfile`, `threatModels`, and `controlEvidence` relations to `Workspace` and `Target`; add `AiAssuranceAssessment` in Task 5, once its snapshot shape is settled. Do not add a generic `Evidence` relation: existing `Evidence` is finding-scoped and must stay that way.

- [ ] **Step 4: Write the migration with FORCE RLS before generating Prisma.**

The migration must: create tables and foreign keys; enable/FORCE RLS on the three root workspace tables; use direct `workspaceId = app.current_workspace_id()` policies for `AiSystemProfile`, `ThreatModel`, and `ControlEvidence`; use `EXISTS` joins through their parents for both version tables; grant the same table privileges as equivalent existing tables. Add the two root models to `WORKSPACE_SCOPED_MODELS`; do not add child version models there.

- [ ] **Step 5: Generate the Prisma client and make RLS integration tests pass.**

Run:

```bash
pnpm db:generate
pnpm exec vitest run packages/db/src/ai-assurance-service.test.ts packages/db/src/rls.test.ts packages/db/src/rls-fail-closed.test.ts packages/db/src/extension.test.ts
```

Expected: all pass; the test must include one owning-workspace version insert and one cross-workspace read/write rejection.

- [ ] **Step 6: Commit the schema contract.**

```bash
git add packages/db/prisma packages/db/src/scoping.ts packages/db/src/extension.test.ts packages/db/src/rls.test.ts packages/db/src/rls-fail-closed.test.ts packages/db/src/ai-assurance-service.test.ts
git commit -m "feat: add AI assurance evidence data model"
```

### Task 2: Extract encrypted artifact storage for two real consumers

**Files:**

- Create: `packages/evidence-storage/package.json`
- Create: `packages/evidence-storage/src/index.ts`
- Create: `packages/evidence-storage/src/index.test.ts`
- Modify: `apps/worker/src/engine/evidence-storage.ts`
- Modify: `apps/worker/package.json`
- Modify: `apps/web/package.json`
- Modify: `turbo.json`

**Consumes:** Worker S3/local encryption behavior in `apps/worker/src/engine/evidence-storage.ts` and DB `assertEvidenceEncrypted`.

**Produces:** a shared server-only `uploadEncryptedArtifact()` helper, used by the worker and authenticated web routes. This extraction is justified because it has exactly two consumers; do not create a generic storage-provider framework.

- [ ] **Step 1: Write failing parity tests for storage key isolation and fail-closed configuration.**

```ts
it("uses distinct immutable keys for different AI evidence versions", async () => {
  const first = await uploadEncryptedArtifact({
    workspaceId: "ws",
    namespace: "control-evidence",
    ownerId: "v1",
    type: "proof",
    content: Buffer.from("a"),
  })
  const second = await uploadEncryptedArtifact({
    workspaceId: "ws",
    namespace: "control-evidence",
    ownerId: "v2",
    type: "proof",
    content: Buffer.from("a"),
  })
  expect(first.storageUri).not.toEqual(second.storageUri)
})

it("refuses production uploads when durable encrypted storage is absent", async () => {
  await expect(uploadEncryptedArtifact(params)).rejects.toMatchObject({
    name: "EvidenceStorageConfigurationError",
  })
})
```

- [ ] **Step 2: Move, do not duplicate, storage configuration, encryption, checksum, and S3/local write logic.**

Expose this minimal interface:

```ts
export interface UploadEncryptedArtifactInput {
  workspaceId: string
  namespace: "finding-evidence" | "control-evidence"
  ownerId: string
  type: string
  content: Buffer
  contentType: "application/pdf" | "image/png" | "image/jpeg" | "text/plain" | "application/json"
}
export interface StoredEncryptedArtifact {
  storageUri: string
  checksum: string
  encryptionKeyRef: string
  byteLength: number
}
export async function uploadEncryptedArtifact(
  input: UploadEncryptedArtifactInput
): Promise<StoredEncryptedArtifact>
```

Keep `uploadEvidence()` in the worker as a compatibility wrapper that calls this helper with `namespace: "finding-evidence"`; do not change current finding artifact keys or output fields.

- [ ] **Step 3: Run focused worker/storage tests, then commit.**

```bash
pnpm exec vitest run packages/evidence-storage/src/index.test.ts apps/worker/src/engine/evidence-storage.test.ts apps/worker/src/engine/finding-persister.test.ts
git add packages/evidence-storage apps/worker/src/engine/evidence-storage.ts apps/worker/package.json apps/web/package.json turbo.json
git commit -m "refactor: share encrypted evidence artifact storage"
```

### Task 3: Implement the control-evidence service and private upload API

**Files:**

- Create: `packages/db/src/ai-assurance-service.ts`
- Modify: `packages/db/src/index.ts`
- Create: `apps/web/src/app/api/ai-assurance/evidence/route.ts`
- Create: `apps/web/src/app/api/ai-assurance/evidence/[id]/route.ts`
- Create: `apps/web/src/app/api/ai-assurance/evidence/[id]/artifacts/route.ts`
- Create: `apps/web/src/app/api/ai-assurance/evidence/route.test.ts`
- Create: `apps/web/src/app/api/ai-assurance/evidence/[id]/route.test.ts`
- Modify: `apps/web/src/lib/api-schemas.ts`

**Consumes:** Task 1 models, Task 2 upload helper, `requirePermission`, existing API response helpers, audit logging pattern.

**Produces:** A stable private API for create/revise/review/list evidence and an append-only artifact manifest.

- [ ] **Step 1: Define service functions and tests before route code.**

```ts
export async function createControlEvidence(input: {
  workspaceId: string
  targetId: string
  controlId: (typeof AI_ASSURANCE_CONTROL_IDS)[number]
  attestation: string
  expiresAt: Date | null
  createdById: string
}): Promise<ControlEvidenceVersion>
export async function reviseControlEvidence(input: {
  workspaceId: string
  evidenceId: string
  attestation: string
  expiresAt: Date | null
  createdById: string
}): Promise<ControlEvidenceVersion>
export async function reviewControlEvidence(input: {
  workspaceId: string
  evidenceId: string
  status: "ACCEPTED" | "REJECTED"
  reviewerId: string
}): Promise<ControlEvidenceVersion>
export async function listControlEvidence(input: {
  workspaceId: string
  targetId: string
}): Promise<ControlEvidenceVersion[]>
```

`create` and `revise` must always set status `SUBMITTED`. `review` must create a new version with the same artifact manifest and changed review fields—never update the submitted version. Reject evidence control IDs outside the seven existing `evidence` strategy controls.

- [ ] **Step 2: Implement route schemas and authorization.**

`POST /api/ai-assurance/evidence` accepts metadata only and requires a target in the caller workspace. `POST /api/ai-assurance/evidence/[id]/artifacts` accepts `multipart/form-data`, validates file count/size/MIME before reading content, writes each file through `uploadEncryptedArtifact`, and creates a new evidence version containing:

```ts
type ArtifactManifestItem = {
  id: string
  filename: string
  mediaType: string
  byteLength: number
  storageUri: string
  checksum: string
  encryptionKeyRef: string
}
```

Never return `storageUri` to the browser. Add a separate authenticated download route only after verifying the existing object-store download policy; in this release show filename/checksum/size, not raw contents. Route permissions: use the closest existing target/report permission for write; if none is semantically correct, add narrow `aiAssurance.view`, `.manage`, `.review` permissions with Owner/Admin-only review.

- [ ] **Step 3: Record audit events and make the endpoints fail closed.**

For creation, revision, artifact addition, acceptance, rejection, and download, add an `AuditLog` event containing IDs, control ID, checksum list, and status only—never attestation body, filename, artifact URI, or file contents. Return `413` for excessive files, `415` for MIME rejection, `403` for cross-workspace resource IDs, and `409` when reviewing a non-current/terminal version.

- [ ] **Step 4: Test the trust boundary.**

```ts
it("does not create an artifact when MIME validation fails", async () => {
  const response = await POST(requestWithFile("application/zip"))
  expect(response.status).toBe(415)
  expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
})
it("does not serialize storage URIs in list results", async () => {
  const payload = await listEvidenceAsMember()
  expect(JSON.stringify(payload)).not.toContain("s3://")
})
```

- [ ] **Step 5: Run targeted tests and commit.**

```bash
pnpm exec vitest run packages/db/src/ai-assurance-service.test.ts apps/web/src/app/api/ai-assurance/evidence/route.test.ts apps/web/src/app/api/ai-assurance/evidence/[id]/route.test.ts
git add packages/db/src/ai-assurance-service.ts packages/db/src/index.ts apps/web/src/app/api/ai-assurance apps/web/src/lib/api-schemas.ts
git commit -m "feat: add private operational evidence workflow"
```

### Task 4: Deliver the Operational Evidence Vault UI

**Files:**

- Create: `apps/web/src/app/(dashboard)/dashboard/assurance/page.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/assurance/assurance-client.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/assurance/evidence-panel.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/assurance/assurance-client.test.tsx`
- Modify: `apps/web/src/components/app-sidebar.tsx` or the current dashboard navigation owner
- Modify: `apps/web/src/app/(dashboard)/dashboard/targets/[id]/page.tsx`

**Consumes:** Task 3 API and the Vibe registry, specifically existing controls 34–36, 43, 46, 48, 50.

**Produces:** A private assurance page and target summary showing evidence state, owner/reviewer, expiry, and immutable history.

- [ ] **Step 1: Write component tests for the evidence states.**

```tsx
it("labels expired evidence as not current without calling it failed", () => {
  render(<EvidencePanel items={[{ controlId: "vibe-35", state: "EVIDENCE_EXPIRED" }]} />)
  expect(screen.getByText("Evidence expired")).toBeVisible()
  expect(screen.queryByText(/passed|compliant/i)).not.toBeInTheDocument()
})
it("hides review controls from a member without review permission", () => {
  render(<EvidencePanel canReview={false} items={[submittedItem]} />)
  expect(screen.queryByRole("button", { name: "Accept evidence" })).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Implement the smallest useful UX.**

Use one target selector, a seven-row table, and a right-side/version drawer. Each row shows the Vibe control title, state, last submitted date, expiry, and a single action based on permission: `Add evidence`, `Revise`, or `Review`. Preserve accessible labels, keyboard focus, error text, and upload progress. Do not add scores, gauges, or an aggregate compliance percentage.

- [ ] **Step 3: Surface only an aggregate private summary on target detail.**

Show `X of 7 evidence controls current`, `Y submitted for review`, `Z missing or expired`; link to the vault. Do not modify public scorecards or shareable report pages.

- [ ] **Step 4: Run UI tests, typecheck, and commit.**

```bash
pnpm exec vitest run apps/web/src/app/(dashboard)/dashboard/assurance/assurance-client.test.tsx
pnpm typecheck
git add apps/web/src/app/(dashboard)/dashboard/assurance apps/web/src/app/(dashboard)/dashboard/targets apps/web/src/components/app-sidebar.tsx
git commit -m "feat: add operational evidence vault"
```

### Task 5: Freeze AI assurance state into reports without exposing it publicly

**Files:**

- Modify: `packages/db/src/report-generator.ts`
- Modify: `packages/db/src/report-service.ts`
- Modify: `packages/db/src/report-generator.test.ts`
- Modify: `packages/db/src/report-service-snapshot.test.ts`
- Modify: `apps/web/src/app/(dashboard)/dashboard/reports/reports-client.tsx`
- Modify: `apps/web/src/app/reports/shared/[id]/shared-report-view.tsx`

**Consumes:** Accepted/current Task 3 evidence and the scan’s immutable Vibe receipts.

**Produces:** A private report snapshot field `aiAssurance`; public report views never deserialize it.

- [ ] **Step 1: Write report snapshot tests first.**

```ts
it("freezes evidence state at report creation", async () => {
  const report = await createReport({ workspaceId, scanId, title: "release" })
  await reviseControlEvidence({
    workspaceId,
    evidenceId,
    attestation: "later",
    expiresAt: null,
    createdById,
  })
  expect(report.contentJson).toMatchObject({
    aiAssurance: { evidence: [{ controlId: "vibe-34", state: "EVIDENCE_ACCEPTED" }] },
  })
})
it("does not expose aiAssurance in shareable report payload", async () => {
  expect(await getShareableReport(reportId, workspaceId)).not.toHaveProperty("aiAssurance")
})
```

- [ ] **Step 2: Add the snapshot type and deterministic evaluator.**

```ts
type AiAssuranceSnapshot = {
  version: "ai-assurance/1.0.0"
  profileState: "COMPLETE" | "INCOMPLETE" | "NOT_ASSESSED"
  threatModelState: "CURRENT" | "MISSING" | "NOT_ASSESSED"
  evidence: Array<{
    controlId: string
    state: AiAssuranceState
    evidenceVersionId: string | null
    expiresAt: string | null
  }>
  frameworkVersion: string
}
```

The evaluator only reads accepted evidence whose `expiresAt` is null or in the future. It maps a selected scan’s seven `EVIDENCE_REQUIRED` receipts to snapshot state; it does not alter the original receipt, finding, score, or release verdict.

- [ ] **Step 3: Render the private section only for authenticated report views.**

Display a factual “AI assurance evidence” section, all missing/expired items, profile/threat-model states, and a link back to the private vault. In `getShareableReport()` and `shared-report-view.tsx`, omit this section entirely; do not merely hide it with CSS.

- [ ] **Step 4: Run snapshot/privacy regression tests and commit.**

```bash
pnpm exec vitest run packages/db/src/report-generator.test.ts packages/db/src/report-service-snapshot.test.ts apps/web/src/app/reports/shared/[id]/shared-report-view.test.tsx
git add packages/db/src/report-generator.ts packages/db/src/report-service.ts packages/db/src/*.test.ts apps/web/src/app/(dashboard)/dashboard/reports apps/web/src/app/reports/shared
git commit -m "feat: snapshot private AI assurance evidence in reports"
```

### Task 6: Implement the Threat Model Workspace

**Files:**

- Create: `packages/db/src/threat-model-service.ts`
- Modify: `packages/db/src/index.ts`
- Create: `apps/web/src/app/api/ai-assurance/threat-model/route.ts`
- Create: `apps/web/src/app/api/ai-assurance/threat-model/route.test.ts`
- Create: `apps/web/src/app/(dashboard)/dashboard/assurance/threat-model-editor.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/assurance/threat-model-editor.test.tsx`
- Create: `docs/security/threat-model-template.md`
- Modify: `PRD.md`

**Consumes:** Task 1 `ThreatModel` records, current threat-model requirements in `PRD.md`, and target ownership/RBAC.

**Produces:** Versioned customer threat models attached to a target, with no LLM generation or hidden risk scoring.

- [ ] **Step 1: Define and test the versioning service.**

```ts
export async function saveThreatModel(input: {
  workspaceId: string
  targetId: string
  createdById: string
  content: ThreatModelInput
}): Promise<{ threatModelId: string; versionId: string; version: number; checksum: string }>
```

Canonicalize object keys before SHA-256 hashing. Reject a threat where `mitigation`, `testPlan`, or `ownerUserId` is missing when impact is `HIGH`/`CRITICAL`; the UI must identify the missing field rather than silently saving it.

- [ ] **Step 2: Implement a guided, accessible editor rather than a freeform canvas.**

Sections: scope; assets; trust boundaries; threats. Use append/remove rows, inline validation, save draft, and “create immutable version” action. The target screen only shows the latest version checksum, owner, and date. Do not create a diagramming dependency in v1; provide a simple ordered relationship list.

- [ ] **Step 3: Add the human-operable Markdown template and align PRD wording.**

The template must cover model/provider, RAG data source, tools/actions, data flows, trust boundaries, attack scenarios, mitigations, tests, owner, review date, and known limits. Update the PRD to state that in-product versioned threat models satisfy the product artifact requirement once released; retain external process requirements if any.

- [ ] **Step 4: Test and commit.**

```bash
pnpm exec vitest run packages/db/src/threat-model-service.test.ts apps/web/src/app/api/ai-assurance/threat-model/route.test.ts apps/web/src/app/(dashboard)/dashboard/assurance/threat-model-editor.test.tsx
git add packages/db/src/threat-model-service.ts packages/db/src/index.ts apps/web/src/app/api/ai-assurance/threat-model apps/web/src/app/(dashboard)/dashboard/assurance docs/security/threat-model-template.md PRD.md
git commit -m "feat: add versioned target threat models"
```

### Task 7: Add the AI System Profile and data-flow inventory

**Files:**

- Create: `packages/db/src/ai-system-profile-service.ts`
- Modify: `packages/db/src/index.ts`
- Create: `apps/web/src/app/api/ai-assurance/profile/route.ts`
- Create: `apps/web/src/app/api/ai-assurance/profile/route.test.ts`
- Create: `apps/web/src/app/(dashboard)/dashboard/assurance/ai-system-profile-form.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/assurance/ai-system-profile-form.test.tsx`

**Consumes:** Task 1 `AiSystemProfile`, existing target ownership, Task 5 report snapshot.

**Produces:** User-supplied inventory that distinguishes declared facts from scan-derived evidence.

- [ ] **Step 1: Write failing validation tests.**

```ts
it("requires a retention response when the profile declares a data source", () => {
  expect(
    AiSystemProfileSchema.safeParse({
      ...validProfile,
      dataSources: ["customer PDFs"],
      retentionSummary: null,
    }).success
  ).toBe(false)
})
it("does not infer training-data rights from a provider declaration", async () => {
  const profile = await upsertAiSystemProfile(validProfile)
  expect(profile.profile).not.toHaveProperty("trainingDataRightsVerified")
})
```

- [ ] **Step 2: Implement one target-scoped form with explicit provenance labels.**

Every row must read `Customer-declared` until a future connector supplies independently observed data. Required fields: system name/purpose; providers/models/deployments; data classes and sources; storage/vector systems; tool/MCP integrations; retention; human oversight. Add a text-only data-flow summary generated from form entries, labelled `Inventory summary`, not `verified lineage`.

- [ ] **Step 3: Add profile state to the report evaluator and tests.**

`COMPLETE` means all required categories have values; it does not mean correct or compliant. If no profile exists, report `NOT_ASSESSED`; do not block scans or change scoring.

- [ ] **Step 4: Run tests and commit.**

```bash
pnpm exec vitest run packages/db/src/ai-system-profile-service.test.ts apps/web/src/app/api/ai-assurance/profile/route.test.ts apps/web/src/app/(dashboard)/dashboard/assurance/ai-system-profile-form.test.tsx
git add packages/db/src/ai-system-profile-service.ts packages/db/src/index.ts apps/web/src/app/api/ai-assurance/profile apps/web/src/app/(dashboard)/dashboard/assurance
git commit -m "feat: add AI system inventory profile"
```

### Task 8: Build the reviewed framework crosswalk

**Files:**

- Create: `packages/security/src/ai-assurance-frameworks.ts`
- Create: `packages/security/src/ai-assurance-frameworks.test.ts`
- Modify: `packages/security/src/index.ts`
- Modify: `packages/db/src/report-generator.ts`
- Create: `apps/web/src/app/(dashboard)/dashboard/assurance/framework-crosswalk.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/assurance/framework-crosswalk.test.tsx`
- Modify: `docs/vibe-security-50.md`
- Create: `docs/ai-assurance-framework-mapping.md`

**Consumes:** Vibe registry, Task 5 snapshot data, reviewed human mapping inputs.

**Produces:** Versioned static mappings for OWASP LLM risks, NIST AI RMF functions, MITRE ATLAS references, and an explicitly limited EU AI Act readiness category.

- [ ] **Step 1: Obtain security/compliance-owner approval for version 1 mappings before coding.**

Record the source title/version/date, owner, and review date in `docs/ai-assurance-framework-mapping.md`. Do not scrape or embed copyrighted framework text; store stable identifiers and short LyraShield-authored rationales only. If approval is unavailable, ship OWASP LLM-only mapping and retain the other frameworks as out of scope.

- [ ] **Step 2: Write deterministic mapping tests.**

```ts
it("never maps a missing evidence-required control to satisfied", () => {
  expect(evaluateFrameworkReadiness({ "vibe-50": "EVIDENCE_REQUIRED" }).items).toContainEqual(
    expect.objectContaining({ framework: "NIST_AI_RMF", status: "NOT_ASSESSED" })
  )
})
it("pins every displayed item to a framework and mapping version", () => {
  for (const item of FRAMEWORK_MAPPINGS)
    expect(item.mappingVersion).toBe("ai-assurance-mapping/1.0.0")
})
```

- [ ] **Step 3: Implement source-level mappings and evaluator.**

```ts
export type FrameworkId = "OWASP_LLM" | "NIST_AI_RMF" | "MITRE_ATLAS" | "EU_AI_ACT_READINESS"
export type FrameworkReadiness =
  "OBSERVED" | "EVIDENCE_ACCEPTED" | "NOT_ASSESSED" | "NOT_APPLICABLE"
export const FRAMEWORK_MAPPING_VERSION = "ai-assurance-mapping/1.0.0"
export function evaluateFrameworkReadiness(input: AiAssuranceSnapshot): FrameworkAssessment
```

`EVIDENCE_ACCEPTED` requires accepted unexpired evidence; a deterministic scanner detection is `OBSERVED`; `NO_FINDING`, `INCONCLUSIVE`, and missing profile data are `NOT_ASSESSED`. The UI must show a persistent “readiness mapping, not certification or legal advice” notice.

- [ ] **Step 4: Test, document, and commit.**

```bash
pnpm exec vitest run packages/security/src/ai-assurance-frameworks.test.ts apps/web/src/app/(dashboard)/dashboard/assurance/framework-crosswalk.test.tsx packages/db/src/report-generator.test.ts
git add packages/security/src/ai-assurance-frameworks.ts packages/security/src/ai-assurance-frameworks.test.ts packages/security/src/index.ts packages/db/src/report-generator.ts apps/web/src/app/(dashboard)/dashboard/assurance docs/vibe-security-50.md docs/ai-assurance-framework-mapping.md
git commit -m "feat: add AI assurance framework crosswalk"
```

### Task 9: Add deterministic AI data-exposure and MCP permission review

**Files:**

- Create: `packages/security/src/ai-data-exposure.ts`
- Create: `packages/security/src/ai-data-exposure.test.ts`
- Modify: `apps/worker/src/engine/scanner-orchestrator.ts`
- Modify: `apps/worker/src/engine/scanner-orchestrator.test.ts`
- Modify: `apps/worker/src/engine/result-integrity.ts`
- Modify: `packages/security/src/vibe-security-controls.ts`
- Modify: `docs/vibe-security-50.md`

**Consumes:** Existing secret scanner, agent-config scanner, Vibe controls 33 and 40–45, and scan receipts.

**Produces:** Bounded deterministic candidate findings for SDK/provider configuration, unsafe logging, RAG ingestion configuration, and manifest-declared tool permissions. Existing engine-led controls remain engine-led unless the deterministic evidence is direct.

- [ ] **Step 1: Fix the detector contract with tests.**

```ts
it("detects provider request logging that includes raw prompt content", () => {
  expect(scanAiDataExposure(source("logger.info({ prompt: request.messages })"))).toContainEqual(
    expect.objectContaining({ controlIds: [33, 40], severity: "HIGH" })
  )
})
it("does not infer data exfiltration from an SDK import alone", () => {
  expect(scanAiDataExposure(source("import OpenAI from 'openai'"))).toEqual([])
})
it("flags MCP tool write-all capability in a manifest", () => {
  expect(scanAiDataExposure(source('{ "capabilities": ["write-all"] }'))).toContainEqual(
    expect.objectContaining({ controlIds: [42] })
  )
})
```

- [ ] **Step 2: Implement bounded, source-aware detection only.**

Inspect an allowlisted set of known AI configuration files plus source files already collected by the repository scanner. Limit total bytes and files using the existing scanner-coverage pattern. Detect direct risky structures, not semantic guesses: raw prompts/response bodies sent to known logger calls; RAG source ingestion configured without an allowlisted access-control field; MCP config declaring wildcard/write-all/command execution without a required approval field. Emit `INCONCLUSIVE` receipt coverage when files cannot be inspected.

- [ ] **Step 3: Keep control mapping truthful.**

Map direct findings to existing Vibe controls; do not add controls unless a new independently useful risk class appears. Update `CONTROL_SCANNERS` to assign the new scanner only to those controls. An absence remains `NO_FINDING` for deterministic direct checks and never proves safe data governance, model privacy, or permissions elsewhere.

- [ ] **Step 4: Run scanner tests and commit.**

```bash
pnpm exec vitest run packages/security/src/ai-data-exposure.test.ts apps/worker/src/engine/scanner-orchestrator.test.ts apps/worker/src/engine/result-integrity.test.ts
git add packages/security/src/ai-data-exposure.ts packages/security/src/ai-data-exposure.test.ts apps/worker/src/engine/scanner-orchestrator.ts apps/worker/src/engine/result-integrity.ts packages/security/src/vibe-security-controls.ts docs/vibe-security-50.md
git commit -m "feat: scan AI data exposure and MCP permissions"
```

### Task 10: Add ML/model supply-chain inventory as a deterministic scanner

**Files:**

- Create: `apps/worker/src/engine/scanners/ml-supply-chain-scanner.ts`
- Create: `apps/worker/src/engine/scanners/ml-supply-chain-scanner.test.ts`
- Modify: `apps/worker/src/engine/scanner-orchestrator.ts`
- Modify: `apps/worker/src/engine/result-integrity.ts`
- Modify: `docs/vibe-security-50.md`

**Consumes:** Existing SCA scanner parsing, OSV client conventions, scanner coverage limits.

**Produces:** Deterministic observations for unpinned model revisions, unsafe model deserialization, and model/provider dependency provenance. It does not audit a model’s weights or training corpus.

- [ ] **Step 1: Write tests for exact, low-ambiguity evidence.**

```ts
it("flags torch.load without weights_only=true", () => {
  expect(scanMlSupplyChain("torch.load(path)")).toContainEqual(
    expect.objectContaining({ controlIds: [39] })
  )
})
it("flags a mutable Hugging Face revision", () => {
  expect(scanMlSupplyChain("snapshot_download('org/model')")).toContainEqual(
    expect.objectContaining({ controlIds: [39] })
  )
})
it("does not call an unpinned model poisoned", () => {
  expect(scanMlSupplyChain("snapshot_download('org/model')")[0]?.title).not.toMatch(/poison/i)
})
```

- [ ] **Step 2: Implement parser rules for Python and declarative model references.**

Recognize `torch.load`, `pickle.load`, `joblib.load`, `safetensors`, `transformers.from_pretrained`, and `huggingface_hub.snapshot_download`. Require a pinned SHA/revision where the API supports it; distinguish unsafe deserialization from mutable provenance; record file/line/reason. Do not fetch model artifacts or private registries in v1.

- [ ] **Step 3: Run focused tests and commit.**

```bash
pnpm exec vitest run apps/worker/src/engine/scanners/ml-supply-chain-scanner.test.ts apps/worker/src/engine/scanner-orchestrator.test.ts
git add apps/worker/src/engine/scanners/ml-supply-chain-scanner.ts apps/worker/src/engine/scanners/ml-supply-chain-scanner.test.ts apps/worker/src/engine/scanner-orchestrator.ts apps/worker/src/engine/result-integrity.ts docs/vibe-security-50.md
git commit -m "feat: inventory ML supply-chain risks"
```

### Task 11: Define the authorization-bound prompt and tool safety test pack

**Files:**

- Create: `packages/types/src/ai-safety-tests.ts`
- Create: `packages/types/src/ai-safety-tests.test.ts`
- Create: `docs/ai-safety-test-pack.md`
- Modify: `packages/types/src/index.ts`
- Modify: `PRD.md`

**Consumes:** Current target authorization attestation, policy `destructiveTestsAllowed`, scan evidence conventions.

**Produces:** A code-only contract and documented beta gate. Do not add an executable endpoint scanner in this task.

- [ ] **Step 1: Write contract tests.**

```ts
it("rejects a live test plan without an explicit endpoint and authorization ID", () => {
  expect(LiveAiSafetyPlanSchema.safeParse({ targetId: "t", cases: [] }).success).toBe(false)
})
it("does not permit destructive cases under a non-destructive policy", () => {
  expect(
    isSafetyCaseAllowed(
      { kind: "TOOL_MUTATION", destructive: true },
      { destructiveTestsAllowed: false }
    )
  ).toBe(false)
})
```

- [ ] **Step 2: Implement only schema, test catalog, and rules-of-engagement documentation.**

Expose fixtures for `PROMPT_INJECTION`, `TOOL_RESULT_INJECTION`, `SYSTEM_PROMPT_DISCLOSURE`, `SECRET_DISCLOSURE`, and `UNEXPECTED_TOOL_CALL`. Each case contains a redacted fixture ID, expected deterministic predicate, max requests, and stop condition. The document requires: written authorization, owned non-production endpoint, test account, incident contact, rate/budget cap, data-handling confirmation, and a documented rollback/stop path.

- [ ] **Step 3: Commit the beta boundary.**

```bash
pnpm exec vitest run packages/types/src/ai-safety-tests.test.ts
git add packages/types/src/ai-safety-tests.ts packages/types/src/ai-safety-tests.test.ts packages/types/src/index.ts docs/ai-safety-test-pack.md PRD.md
git commit -m "docs: define authorized AI safety test boundary"
```

### Task 12: Implement live AI safety execution only after Release D approval

**Files:**

- Create: `apps/worker/src/engine/scanners/ai-safety-runner.ts`
- Create: `apps/worker/src/engine/scanners/ai-safety-runner.test.ts`
- Create: `apps/web/src/app/api/ai-safety-plans/route.ts`
- Create: `apps/web/src/app/api/ai-safety-plans/route.test.ts`
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/<timestamp>_ai_safety_plans/migration.sql`
- Modify: `apps/worker/src/jobs/run-scan.job.ts`
- Modify: `apps/worker/src/engine/result-integrity.ts`

**Consumes:** Task 11 types; explicit approved authorization record; scan queue/cost/time ceilings; encrypted evidence storage.

**Produces:** A private-beta, replayable, non-destructive safety-test execution path. This task is blocked until the product owner approves the rules of engagement and test endpoint contract.

- [ ] **Step 1: Add a separate persisted plan with explicit approval.**

```prisma
model AiSafetyPlan {
  id String @id @default(cuid())
  workspaceId String
  targetId String
  authorizationId String
  endpointUrl String
  maxRequests Int
  maxDurationSeconds Int
  status String @default("DRAFT")
  plan Json
  createdById String
  createdAt DateTime @default(now())
  @@index([workspaceId, targetId, status])
}
```

Validate a public HTTPS endpoint, forbid credentials in URLs, require a target-scoped authorization ID, and require a policy with `destructiveTestsAllowed === false` in beta. Add root RLS and cross-workspace tests as in Task 1.

- [ ] **Step 2: Write runner tests before network code.**

```ts
it("stops after the configured request cap", async () => {
  const result = await runAiSafetyPlan({ ...plan, maxRequests: 2 }, fakeTransport)
  expect(fakeTransport.calls).toHaveLength(2)
  expect(result.terminalReason).toBe("REQUEST_LIMIT")
})
it("redacts prompt and response content from persisted receipts", async () => {
  const result = await runAiSafetyPlan(plan, fakeTransport)
  expect(JSON.stringify(result.receipts)).not.toContain("fixture secret")
})
```

- [ ] **Step 3: Implement bounded execution.**

Only send catalog fixture payloads to the approved endpoint. Use a dedicated outbound allowlist that permits exactly the target host; no redirects, no arbitrary tool calls, no browser automation, no fuzzing. Store request count, case ID, status, redacted response hash, duration, and stop reason; encrypted raw samples may be stored only if the approved plan says so and must never go to reports or LLM prompts. Predicates are exact response/tool-call assertions. An LLM may summarize a failed case for a private operator view, but it cannot set the test outcome.

- [ ] **Step 4: Run security gates and commit separately.**

```bash
pnpm exec vitest run apps/worker/src/engine/scanners/ai-safety-runner.test.ts apps/web/src/app/api/ai-safety-plans/route.test.ts packages/db/src/rls-fail-closed.test.ts
pnpm lint && pnpm typecheck
git add apps/worker/src/engine/scanners/ai-safety-runner.ts apps/worker/src/jobs/run-scan.job.ts apps/web/src/app/api/ai-safety-plans packages/db/prisma packages/types
git commit -m "feat: add authorized AI safety test runner"
```

### Task 13: Add continuous assurance freshness without pretending to monitor customer infrastructure

**Files:**

- Modify: `packages/db/src/notification-service.ts`
- Modify: `apps/worker/src/notifications.ts`
- Create: `apps/worker/src/ai-assurance-freshness.ts`
- Create: `apps/worker/src/ai-assurance-freshness.test.ts`
- Modify: `apps/worker/src/index.ts` or the existing recurring-job bootstrap owner
- Modify: `apps/web/src/app/(dashboard)/dashboard/assurance/assurance-client.tsx`

**Consumes:** Evidence `expiresAt`, existing notification preferences and scheduler architecture.

**Produces:** Notifications about LyraShield-held evidence freshness, not claims that an external SIEM, backup, or monitoring stack is live.

- [ ] **Step 1: Write deterministic time-boundary tests.**

```ts
it("notifies once when accepted evidence enters the 14-day expiry window", async () => {
  await runAiAssuranceFreshnessSweep(now)
  expect(createAndSendNotification).toHaveBeenCalledWith(
    expect.objectContaining({ type: "ai_assurance_evidence_expiring" })
  )
})
it("does not notify again for the same evidence version and window", async () => {
  await runAiAssuranceFreshnessSweep(now)
  await runAiAssuranceFreshnessSweep(now)
  expect(createAndSendNotification).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Implement a daily idempotent sweep.**

Query accepted current versions expiring in 14 days or already expired; create a deduplicated notification keyed by evidence-version ID and window. Add dashboard status only. Do not connect to Sentry/Datadog/cloud consoles in this release; those are future optional evidence sources.

- [ ] **Step 3: Test and commit.**

```bash
pnpm exec vitest run apps/worker/src/ai-assurance-freshness.test.ts packages/db/src/notification-service.test.ts
git add apps/worker/src/ai-assurance-freshness.ts apps/worker/src/ai-assurance-freshness.test.ts apps/worker/src/notifications.ts packages/db/src/notification-service.ts apps/web/src/app/(dashboard)/dashboard/assurance
git commit -m "feat: notify on AI assurance evidence freshness"
```

### Task 14: Documentation, migration rehearsal, UI proof, and release gate

**Files:**

- Modify: `AGENTS.md`
- Modify: `codebase.md`
- Modify: `PRD.md`
- Modify: `userguide.md`
- Modify: `docs/vibe-security-50.md`
- Modify: `docs/deployment/LOCAL_SETUP.md`
- Modify: `.env.example` only if Task 2 needs no existing S3 variable changes (expected: no change)

**Consumes:** completed Releases A–D.

**Produces:** an operator- and user-facing contract that clearly distinguishes code review, customer-declared facts, accepted operational evidence, and authorized live tests.

- [ ] **Step 1: Add explicit product-language rules.**

Document: “accepted evidence” means a permitted reviewer accepted a dated customer submission; it is not independent verification of the customer’s whole environment. “Inventory complete” means required inventory fields are present, not data lineage verified. “Framework readiness” is mapping, not certification. Live safety testing requires a scoped authorization and can be stopped by request/duration policy.

- [ ] **Step 2: Rehearse the migration against a disposable database.**

```bash
pnpm db:generate
pnpm db:migrate
pnpm exec vitest run packages/db/src/rls.test.ts packages/db/src/rls-fail-closed.test.ts packages/db/src/migration-constraints.test.ts
```

Use the repository’s existing disposable/Postgres CI setup; do not apply a development migration directly to production as rehearsal.

- [ ] **Step 3: Run the complete verification ladder.**

```bash
pnpm lint
pnpm typecheck
pnpm test:core
pnpm test:e2e
pnpm build
pnpm format:check
git diff --check
```

Add one Playwright flow: Owner creates evidence → Admin accepts → report includes private snapshot → shared report excludes it. Add desktop and 390px visual inspection of assurance table/editor; verify no console errors and keyboard completion of add/review flows.

- [ ] **Step 4: Review and release as bounded PRs.**

Create separate PRs for A (Tasks 1–5), B (Tasks 6–8), C (Tasks 9–10), D contract (Task 11), and only then E execution (Task 12). Do not batch database/RLS, model-testing execution, and public-copy changes into one review.

## Acceptance criteria

1. Every one of the seven evidence-required Vibe controls can show `EVIDENCE_REQUIRED`, `EVIDENCE_SUBMITTED`, `EVIDENCE_ACCEPTED`, `EVIDENCE_EXPIRED`, or `NOT_APPLICABLE` privately, with version history and audit events.
2. No current scan receipt, score, finding verification state, or public scorecard changes because an operational evidence record was added.
3. Report snapshots freeze AI assurance state at creation; public share endpoints do not serialize profile, threat-model, evidence, framework, or artifact data.
4. Cross-workspace reads/writes fail at database RLS and route levels for all new tables.
5. AI System Profile and threat model store customer-declared facts as such; no UI uses “verified,” “compliant,” “certified,” or “safe” for their completion state.
6. Framework rows show framework ID, mapping version, evidence basis, and readiness state; missing/inconclusive inputs never become satisfied.
7. Deterministic AI-data/MCP and ML-supply-chain scanners emit bounded evidence and preserve `INCONCLUSIVE`/`NO_FINDING` semantics.
8. No live AI safety test can run without a target-scoped approved authorization, non-production endpoint, request/duration limits, and a non-destructive policy; raw sensitive samples are never placed in reports or LLM context.
9. All required local gates, migration replay, RLS reproduction, browser accessibility checks, and `git diff --check` pass before merge.

## Explicit non-goals

- Training-data copyright/licensing verification, model-weight provenance proof, poisoning detection, model extraction/inversion testing, and a general-purpose adversarial robustness score.
- A Garak integration or arbitrary public chatbot/API testing button.
- Automatically connecting to or certifying customer monitoring, backup, SIEM, cloud IAM, model-provider retention, or legal/compliance configuration.
- Any public AI assurance scorecard or public sharing of AI profile/evidence data.
- Making any of the five prohibited claims documented in `docs/claims-readiness.md`: "SOC 2 compliant," "certified," "guarantees security," "AI safety tested" (without a named framework), or "adversarial robustness proven."

## Claims readiness

See `docs/claims-readiness.md` for the full map of what each prohibited claim requires, what LyraShield has today, what is missing, the codebase additions needed, the honest alternatives available now, and the realistic timeline and cost for each.

Summary of what is honest today:

| Claim                           | Honest now? | What it would take                                                                                                   |
| ------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| "SOC 2 compliant"               | No          | CPA-issued Type II report; 6–12 months; $40k–$120k                                                                   |
| "Certified" (ISO 27001)         | No          | Accredited body certificate; 6–9 months; $25k–$60k                                                                   |
| "Guarantees security"           | No          | Bounded scope, eval corpus, liability cap, cyber E&O insurance; 3–6 months + legal                                   |
| "AI safety tested"              | **Partial** | First-party OWASP + AILuminate eval done (`packages/eval-ai-safety/`, `/ai-safety`); third-party review still needed |
| "Adversarial robustness proven" | No          | Formal certification (impossible for LLMs today) OR formal verification of deterministic policy layer; 13–40 weeks   |

## Coding-agent handoff checklist

- Read `AGENTS.md`, `docs/claims-readiness.md`, `docs/vibe-security-50.md`, `packages/security/src/vibe-security-controls.ts`, `packages/db/prisma/schema.prisma`, `packages/db/src/rls-fail-closed.test.ts`, `apps/worker/src/engine/result-integrity.ts`, and `packages/db/src/report-generator.ts` before Task 1.
- Start from a clean `codex/ai-assurance-*` branch; preserve unrelated worktree changes.
- Implement Releases A and B before deciding whether any scanner expansion is worth adding. Do not begin Task 12 without product-owner authorization for the live-test contract.
- Re-check current framework versions and have security/legal review the mapping file immediately before publication; the source-code mapping must include its reviewed version/date.
- Before adding any new marketing copy, grep for the prohibited claim terms documented in `docs/claims-readiness.md` and confirm the copy does not imply certification, compliance, universal security, or adversarial robustness.
