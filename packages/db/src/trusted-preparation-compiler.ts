import { Prisma } from "./generated/prisma"
import {
  buildEngineArguments,
  buildVibeSecurityInstruction,
  buildUrlTargetInstruction,
  resolveEngineProfile,
  resolveScanBudgetUsd,
  type EngineTargetInfo,
} from "@lyrashield/security"
import { canonicalizeJson, sha256Sync } from "@lyrashield/security/webmcp"
import {
  resolveScanProfile,
  scanAttachmentStagingName,
  SCAN_ATTACHMENT_MAX_BYTES,
  SCAN_ATTACHMENT_MAX_TOTAL_BYTES,
} from "@lyrashield/types"
import {
  canonicalJson,
  observeInstalledExecutionAuthority,
  createInstalledExecutionAuthorityCapability,
  sha256Hex,
  requireCurrentPreparationDelegation,
  type AuthoritySqlConnection,
  type PrepareCommand,
} from "@lyrashield/runtime-control"
import { executorResourceDescriptorSchema } from "@lyrashield/runtime-control/src/executor-resource-descriptor"
import type {
  ScanPreparationCommandAuthority,
  ScanPreparationCompiler,
} from "./scan-dispatch-command-descriptor"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"
import { deriveCurrentPrepareBinding } from "./scan-supervisor-current-command"
import {
  preparationProofFailure,
  trustedPreparationHostPolicySchema,
  verifyPreparationStagingRecord,
} from "./trusted-preparation-proof"

function requireStagedInputs(
  authority: ScanPreparationCommandAuthority,
  record: ReturnType<typeof verifyPreparationStagingRecord>["record"]
) {
  const { source, attachments, relay, egress } = record.resources
  if (authority.target.type === "REPO") {
    if (
      !source ||
      source.revision !== authority.executionPlan.source?.revision ||
      relay ||
      egress.relayRequired
    )
      preparationProofFailure()
  } else if (authority.target.type === "WEB_APP" || authority.target.type === "API") {
    if (source || !relay || !egress.relayRequired || !authority.target.url)
      preparationProofFailure()
    const hosts = [
      new URL(authority.target.url).hostname.toLowerCase(),
      ...(authority.target.type === "API" && authority.target.apiSpecUrl
        ? [new URL(authority.target.apiSpecUrl).hostname.toLowerCase()]
        : []),
    ]
    for (const host of [...hosts, ...relay.authorizedHosts, ...egress.authorizedHosts]) {
      if (
        !hosts.some((approved) => host === approved || host.endsWith(`.${approved}`)) ||
        !relay.authorizedHosts.includes(host) ||
        !egress.authorizedHosts.includes(host) ||
        !authority.verifiedDomains.some(
          (proof) =>
            proof.verifiedAt !== null &&
            proof.expiresAt.getTime() > Date.now() &&
            (host === proof.domain || host.endsWith(`.${proof.domain}`))
        )
      )
        preparationProofFailure()
    }
  } else preparationProofFailure()
  const approvedIds = [...authority.executionPlan.attachmentIds].sort(),
    stagedIds = (attachments?.entries.map((entry) => entry.id) ?? []).sort()
  if (
    canonicalJson(approvedIds) !== canonicalJson(stagedIds) ||
    authority.attachments.length !== approvedIds.length
  )
    preparationProofFailure()
  let totalBytes = 0
  for (const expected of authority.attachments) {
    const staged = attachments?.entries.find((entry) => entry.id === expected.id)
    totalBytes += expected.byteLength
    if (
      !staged ||
      expected.workspaceId !== authority.attempt.workspaceId ||
      expected.byteLength > SCAN_ATTACHMENT_MAX_BYTES ||
      staged.checksum !== expected.checksum ||
      staged.byteLength !== expected.byteLength ||
      staged.contentType !== expected.mediaType ||
      staged.filename !== expected.filename ||
      staged.containerPath !==
        `/input/attachments/${scanAttachmentStagingName(expected.id, expected.filename)}`
    )
      preparationProofFailure()
  }
  if (totalBytes > SCAN_ATTACHMENT_MAX_TOTAL_BYTES) preparationProofFailure()
}

/** Only a protected installation supplies policy, key and signed staging-catalog reader. */
export function createTrustedPreparationCompiler(options: {
  hostPolicy: unknown
  issuerPublicKey: string
  readStagingRecord(authority: ScanPreparationCommandAuthority): Promise<unknown>
  readExecutionContext(authority: ScanPreparationCommandAuthority): Promise<unknown>
}): ScanPreparationCompiler {
  const policy = trustedPreparationHostPolicySchema.parse(options.hostPolicy)
  const frozenPolicy = trustedPreparationHostPolicySchema.parse(JSON.parse(canonicalJson(policy)))
  const publicKey = options.issuerPublicKey,
    readStagingRecord = options.readStagingRecord,
    readExecutionContext = options.readExecutionContext
  const readContext = async (authority: ScanPreparationCommandAuthority) =>
    frozenPolicy.schema === "lyrashield-preparation-host-policy/2"
      ? { environment: "PRODUCTION", installed: await observeInstalledExecutionAuthority() }
      : readExecutionContext(authority)
  // Validate both established model routes during installation, before a scan.
  resolveEngineProfile("SAFE", frozenPolicy.modelRouting)
  resolveEngineProfile("DEEP", frozenPolicy.modelRouting)
  const compiler: ScanPreparationCompiler = async (authority) => {
    if (
      authority.target.workspaceId !== authority.attempt.workspaceId ||
      authority.target.type !== authority.executionPlan.targetType ||
      sha256Sync(canonicalizeJson(authority.executionPlan)) !== authority.executionPlanHash
    )
      preparationProofFailure()
    const profile = resolveScanProfile({ targetType: authority.target.type, mode: authority.mode })
    if (
      !profile.engineMode ||
      profile.id !== authority.executionPlan.profileId ||
      authority.executionPlan.workflow === "AUTHENTICATED_ASSESSMENT"
    )
      preparationProofFailure()
    const budget = new Prisma.Decimal(authority.maxBudgetUsd),
      policyBudget =
        authority.policy?.maxBudgetUsd === null || authority.policy?.maxBudgetUsd === undefined
          ? undefined
          : new Prisma.Decimal(String(authority.policy.maxBudgetUsd)).toNumber()
    const allowedBudget = resolveScanBudgetUsd(
      authority.mode,
      policyBudget,
      authority.target.type,
      frozenPolicy.platformMaxBudgetUsd
    )
    if (
      !budget.isFinite() ||
      budget.lte(0) ||
      budget.gt(allowedBudget) ||
      budget.gt(authority.executionPlan.limits.maxBudgetUsd)
    )
      preparationProofFailure()
    const timeoutMs = Math.min(
      authority.maxRuntimeMs,
      authority.executionPlan.limits.maxEngineMs,
      profile.maxEngineMinutes * 60000
    )
    if (timeoutMs <= 31000) preparationProofFailure()
    const observedContext = await readContext(authority)
    const { record, recordChecksum } = verifyPreparationStagingRecord(
      await readStagingRecord(authority),
      authority,
      frozenPolicy,
      publicKey,
      observedContext
    )
    if (
      frozenPolicy.schema === "lyrashield-preparation-host-policy/1" &&
      canonicalJson(await readContext(authority)) !== canonicalJson(observedContext)
    )
      preparationProofFailure()
    requireStagedInputs(authority, record)
    const target: EngineTargetInfo = {
      id: authority.target.id,
      type: authority.target.type as EngineTargetInfo["type"],
      name: authority.target.name,
      url: authority.target.url,
      repoFullName: authority.target.repoFullName,
      branch: authority.target.branch,
      ...(authority.target.type === "REPO"
        ? { repoUrl: record.resources.source!.root, branch: null }
        : {}),
    }
    const instruction =
      target.type === "REPO"
        ? buildVibeSecurityInstruction(authority.goal, authority.mode)
        : buildUrlTargetInstruction(authority.goal, {
            host: new URL(authority.target.url!).hostname,
            targetType: target.type as "WEB_APP" | "API",
            environment: authority.target.environment,
            hasApiSpec: Boolean(authority.target.apiSpecUrl),
            focus: authority.focus,
          })
    const args = buildEngineArguments(
      {
        scanId: authority.attempt.scanId,
        goal: authority.goal,
        mode: authority.mode,
        target,
        apiSpecUrl: authority.target.apiSpecUrl,
        instruction,
        maxBudgetUsd: budget.toNumber(),
        executionPlan: authority.executionPlan,
      },
      timeoutMs
    )
    const model = resolveEngineProfile(authority.mode, frozenPolicy.modelRouting)
    const executors = compileProtectedExecutors(
      authority,
      frozenPolicy,
      record,
      recordChecksum,
      args,
      model
    )
    const micros = budget.mul(1000000)
    if (
      !micros.isInteger() ||
      micros.gt(1000000000000) ||
      micros.lt(frozenPolicy.provider.costReservationMicros)
    )
      preparationProofFailure()
    return {
      executors,
      provider: { ...frozenPolicy.provider, maxReservedCostMicros: micros.toNumber() },
    }
  }
  if (frozenPolicy.schema !== "lyrashield-preparation-host-policy/2") return compiler
  const installedCapability = createInstalledExecutionAuthorityCapability()
  return Object.assign(compiler, {
    async verifyPreparedCommand(client: AuthoritySqlConnection, command: PrepareCommand) {
      const result = await client.query(
        `SELECT o."commandInputJson",o."commandInputChecksum"
        FROM "ScanDispatchOutbox" o JOIN "ScanDispatchAttempt" a ON a."attemptId"=o."attemptId" AND a."operationId"=o."operationId"
        WHERE o.id=$1 AND o."operationId"=$2 AND o."attemptId"=$3 AND a."workspaceId"=$4
        AND a."authorityEpochId"=$5 AND o."commandType"='PREPARE' AND o.status='PENDING'
        AND a."authorityTransactionId"=pg_current_xact_id()::text AND app.scan_preparation_gate_held()
        AND a."authorityDeadlineAt">clock_timestamp() AT TIME ZONE 'UTC'`,
        [
          command.commandId,
          command.attempt.operationId,
          command.attempt.attemptId,
          command.attempt.workspaceId,
          command.attempt.authorityEpochId,
        ]
      )
      if (result.rows.length !== 1) preparationProofFailure()
      const row = result.rows[0]!
      if (typeof row.commandInputJson !== "string" || typeof row.commandInputChecksum !== "string")
        preparationProofFailure()
      const stored = readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
      if (!stored || stored.type !== "PREPARE" || canonicalJson(stored) !== canonicalJson(command))
        preparationProofFailure()
      const installed = await installedCapability.verifyAction(
        client,
        deriveCurrentPrepareBinding(stored, row.commandInputChecksum)
      )
      const delegation = requireCurrentPreparationDelegation(installed.preparation, installed)
      if (
        delegation.preparationPolicyChecksum !== sha256Hex(canonicalJson(frozenPolicy)) ||
        delegation.issuerKeyHash !== frozenPolicy.issuerKeyHash ||
        delegation.issuerKeyId !== frozenPolicy.issuerKeyId
      )
        preparationProofFailure()
    },
  })
}

function compileProtectedExecutors(
  authority: ScanPreparationCommandAuthority,
  frozenPolicy: ReturnType<typeof trustedPreparationHostPolicySchema.parse>,
  record: ReturnType<typeof verifyPreparationStagingRecord>["record"],
  recordChecksum: string,
  args: string[],
  model: ReturnType<typeof resolveEngineProfile>
): PrepareCommand["executors"] {
  const resources = (image: string) =>
    executorResourceDescriptorSchema.parse({
      schema: "lyrashield-executor-resources/1",
      hostPolicyChecksum: record.hostPolicyChecksum,
      imageDigest: image.slice(image.lastIndexOf("@") + 1),
      uid: 1000,
      gid: 1000,
      workspaceRoot: "/workspace",
      workdir: "/workspace",
      ...record.resources,
      scratchRoot: "/workspace/.attachments-scratch",
      isolation: {
        ...frozenPolicy.isolation,
        dropCapabilities: "ALL",
        noNewPrivileges: true,
        readOnlyRoot: true,
        shmMb: 512,
      },
      stagingRecordChecksum: recordChecksum,
      issuerKeyHash: record.issuerKeyHash,
    })
  const common = {
    kind: "container" as const,
    network: frozenPolicy.network,
    cpus: 2,
    memoryMb: 2048,
    pidsLimit: 512,
    readOnly: true,
    grantEnvName: "LLM_API_KEY",
  }
  return [
    {
      key: "sandbox",
      spec: {
        ...common,
        image: frozenPolicy.sandboxImage,
        argv: [],
        env: {
          PYTHONUNBUFFERED: "1",
          STRIX_RUN_ID: authority.attempt.scanId,
          ...Object.fromEntries(
            [
              "http_proxy",
              "https_proxy",
              "HTTP_PROXY",
              "HTTPS_PROXY",
              "ALL_PROXY",
              "AGENT_BROWSER_PROXY",
            ].map((name) => [name, "http://127.0.0.1:48080"])
          ),
          NO_PROXY: "localhost,127.0.0.1",
          LYRASHIELD_EGRESS_POLICY: "/run/lyrashield-egress/policy.json",
          ...(record.resources.relay ? { STRIX_TARGET_RELAY: "1" } : {}),
        },
        resourceDescriptor: resources(frozenPolicy.sandboxImage),
      },
    },
    {
      key: "engine",
      spec: {
        ...common,
        image: frozenPolicy.engineImage,
        argv: ["/opt/lyrashield-venv/bin/lyrashield", ...args],
        env: {
          PYTHONDONTWRITEBYTECODE: "1",
          LYRASHIELD_RUNTIME_BACKEND: "controller",
          LYRASHIELD_LLM: model.model!,
          LYRASHIELD_REASONING_EFFORT: model.reasoningEffort,
          LYRASHIELD_DELEGATE_LLM: model.delegateModel!,
          LYRASHIELD_DELEGATE_REASONING_EFFORT: model.delegateReasoningEffort,
          STRIX_RUN_ID: authority.attempt.scanId,
          STRIX_RUN_TYPE: authority.target.type === "REPO" ? "repository" : "web",
        },
        resourceDescriptor: resources(frozenPolicy.engineImage),
      },
    },
  ]
}
