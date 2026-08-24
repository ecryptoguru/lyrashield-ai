import { beforeEach, describe, expect, it, vi } from "vitest"
import { parseArgs } from "node:util"
import type { ScanStatus } from "@lyrashield/db"
import {
  parseLaunchAssuranceOptions,
  verifyLaunchAssurance,
  type LaunchAssuranceDeps,
} from "./verify-launch-assurance"

const DIGEST = `sha256:${"b".repeat(64)}`

function baseOptions() {
  return {
    dryRun: false,
    allowStorageProof: true,
    workerImage: `lyrashield-worker@${DIGEST}`,
    workerEnvFile: "/tmp/worker.env",
    egressPinFile: "/tmp/egress-pins",
    allowFailureInjection: true,
    scanId: "cmt0q9a28000501jnmn1t453t",
    workspaceId: "cmt7np5uv000002s6pnr7c376",
    environment: "production",
    confirmProduction: "I AUTHORIZE LYRASHIELD FAILURE INJECTION",
    apiBaseUrl: "http://app.test",
    apiKey: "test-key",
    azureResourceGroup: "rg",
    stepTimeoutMs: 1000,
  }
}

function makeDeps(overrides: Partial<LaunchAssuranceDeps> = {}): LaunchAssuranceDeps {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith("/api/ready/scans")) {
      return new Response(JSON.stringify({ status: "ready", checks: { worker: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes(`/api/v1/scans/`) && url.includes("workspaceId=")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "cmt0q9a28000501jnmn1t453t",
            workspaceId: "cmt7np5uv000002s6pnr7c376",
            status: "RUNNING",
            events: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    }
    if (
      url.includes("/api/v1/scans/") &&
      String(input).startsWith("http://app.test/api/v1/scans/cm")
    ) {
      return new Response(
        JSON.stringify({
          success: true,
          data: { id: "cmt0q9a28000501jnmn1t453t", status: "CANCELLED" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    }
    return new Response(
      JSON.stringify({ success: false, error: { message: "unexpected fetch" } }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    )
  })

  const execFile = vi.fn(async (command: string, args: string[]) => {
    if (command === "az" && args[0] === "monitor" && args[1] === "action-group") {
      return {
        stdout:
          "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts\n",
      }
    }
    if (
      command === "az" &&
      args.includes("metrics") &&
      args.includes("alert") &&
      args.includes("list")
    ) {
      return {
        stdout: JSON.stringify([
          {
            name: "worker-vm-unavailable",
            enabled: true,
            actions: [
              {
                actionGroupId:
                  "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts",
              },
            ],
          },
          {
            name: "worker-cpu-high",
            enabled: true,
            actions: [
              {
                actionGroupId:
                  "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts",
              },
            ],
          },
          {
            name: "app-no-active-replica",
            enabled: true,
            actions: [
              {
                actionGroupId:
                  "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts",
              },
            ],
          },
          {
            name: "app-replica-restart",
            enabled: true,
            actions: [
              {
                actionGroupId:
                  "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts",
              },
            ],
          },
          {
            name: "scanner-no-active-replica",
            enabled: true,
            actions: [
              {
                actionGroupId:
                  "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts",
              },
            ],
          },
          {
            name: "scanner-replica-restart",
            enabled: true,
            actions: [
              {
                actionGroupId:
                  "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts",
              },
            ],
          },
        ]),
      }
    }
    if (command === "az" && args.includes("scheduled-query") && args.includes("list")) {
      return {
        stdout: JSON.stringify(
          [
            "scan-readiness-unavailable",
            "scan-queue-depth-high",
            "scan-queue-oldest-wait-high",
            "reconciliation-drift",
            "webhook-dead-letter",
            "evidence-persistence-failure",
            "terminal-cost-unreconciled",
          ].map((name) => ({
            name,
            enabled: true,
            autoMitigate: true,
            actions: {
              actionGroups: [
                "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts",
              ],
            },
          }))
        ),
      }
    }
    if (command === "docker" && args[0] === "run") {
      const entrypoint = args[args.length - 1]!
      const marker = entrypoint.includes("fail-closed")
        ? "EVIDENCE_STORAGE_FAIL_CLOSED_OK"
        : "EVIDENCE_STORAGE_PROOF_OK"
      return { stdout: `${marker}\n` }
    }
    if (command === "docker" && args[0] === "rm") {
      return { stdout: "" }
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
  })

  const now = vi.fn(() => new Date("2026-08-25T00:00:00.000Z"))

  return {
    fetch: fetch as unknown as typeof fetch,
    execFile: execFile as unknown as LaunchAssuranceDeps["execFile"],
    now,
    readFile: vi.fn(async () => "api.example.test 93.184.216.34 443\n"),
    reconcile: vi.fn(async () => ({
      leaseAcquired: true,
      failedOrphanedScans: 0,
      removedOrphanedJobs: 0,
      queueDepth: 1,
      oldestWaitingJobAgeMs: 0,
    })),
    listActiveScans: vi.fn(async (): Promise<Array<{ id: string; status: ScanStatus }>> => [
      { id: "cmt0q9a28000501jnmn1t453t", status: "RUNNING" },
    ]),
    getScanState: vi.fn(
      async (): Promise<{ id: string; workspaceId: string; status: ScanStatus }> => ({
        id: "cmt0q9a28000501jnmn1t453t",
        workspaceId: "cmt7np5uv000002s6pnr7c376",
        status: "CANCELLED",
      })
    ),
    countEngineStartsSince: vi.fn(async () => 0),
    ...overrides,
  }
}

describe("parseLaunchAssuranceOptions", () => {
  it("accepts a plain dry run", () => {
    const options = parseLaunchAssuranceOptions({})
    expect(options).toMatchObject({
      dryRun: false,
      allowStorageProof: false,
      allowFailureInjection: false,
    })
  })

  it("rejects a malformed worker image digest", () => {
    expect(() =>
      parseLaunchAssuranceOptions({
        "allow-storage-proof": true,
        "worker-image": "latest",
        "worker-env-file": "/tmp/env",
      })
    ).toThrow(/sha256/)
  })

  it("rejects storage-proof inputs without the allow flag", () => {
    expect(() => parseLaunchAssuranceOptions({ "worker-image": `img@${DIGEST}` })).toThrow(
      /--allow-storage-proof/
    )
  })

  it("rejects storage proof without image or env file", () => {
    expect(() => parseLaunchAssuranceOptions({ "allow-storage-proof": true })).toThrow(
      /--worker-image/
    )
  })

  it("rejects failure injection without the exact production confirmation", () => {
    expect(() =>
      parseLaunchAssuranceOptions({
        "allow-failure-injection": true,
        "scan-id": "cmt0q9a28000501jnmn1t453t",
        "workspace-id": "cmt7np5uv000002s6pnr7c376",
        environment: "production",
        "confirm-production": "wrong phrase",
      })
    ).toThrow(/confirm-production/)
  })

  it("rejects failure injection without an exact scan id or workspace id", () => {
    expect(() =>
      parseLaunchAssuranceOptions({
        "allow-failure-injection": true,
        environment: "production",
        "confirm-production": "I AUTHORIZE LYRASHIELD FAILURE INJECTION",
      })
    ).toThrow(/scan-id/)
    expect(() =>
      parseLaunchAssuranceOptions({
        "allow-failure-injection": true,
        "scan-id": "cmt0q9a28000501jnmn1t453t",
        environment: "production",
        "confirm-production": "I AUTHORIZE LYRASHIELD FAILURE INJECTION",
      })
    ).toThrow(/workspace-id/)
  })

  it("rejects failure injection outside production", () => {
    expect(() =>
      parseLaunchAssuranceOptions({
        "allow-failure-injection": true,
        "scan-id": "cmt0q9a28000501jnmn1t453t",
        "workspace-id": "cmt7np5uv000002s6pnr7c376",
        environment: "staging",
        "confirm-production": "I AUTHORIZE LYRASHIELD FAILURE INJECTION",
      })
    ).toThrow(/--environment production/)
  })

  it("rejects unknown CLI flags at the parser boundary", () => {
    expect(() =>
      parseArgs({
        args: ["--nonsense"],
        options: { "dry-run": { type: "boolean", default: false } },
        strict: true,
      })
    ).toThrow(/Unknown option/)
  })
})

describe("verifyLaunchAssurance", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it("runs the fixed step order in full mode", async () => {
    const deps = makeDeps()
    const receipt = await verifyLaunchAssurance(baseOptions(), deps)

    expect(receipt.mode).toBe("full")
    expect(receipt.steps.map((step) => step.name)).toEqual([
      "provenance",
      "readiness",
      "azure_alert_readback",
      "storage_fail_closed_proof",
      "storage_round_trip_proof",
      "failure_injection_preflight",
      "authenticated_cancellation",
      "settle_wait",
      "queue_recovery",
      "post_recovery_readiness",
    ])
    expect(receipt.steps.every((step) => step.status === "passed")).toBe(true)
    expect(receipt.overall).toBe("passed")
    expect(deps.reconcile).toHaveBeenCalledTimes(1)
  })

  it("keeps dry run read-only and labels it preflight_passed", async () => {
    const deps = makeDeps()
    const options = {
      ...baseOptions(),
      dryRun: true,
      allowStorageProof: false,
      allowFailureInjection: false,
      workerImage: undefined,
      workerEnvFile: undefined,
      egressPinFile: undefined,
      scanId: undefined,
      workspaceId: undefined,
      environment: undefined,
      confirmProduction: undefined,
    }

    const receipt = await verifyLaunchAssurance(options, deps)

    expect(receipt.mode).toBe("dry-run")
    expect(receipt.overall).toBe("preflight_passed")
    const storageSteps = receipt.steps.filter((step) => step.name.startsWith("storage_"))
    expect(storageSteps.every((step) => step.status === "skipped")).toBe(true)
    const mutationSteps = receipt.steps.filter((step) =>
      [
        "failure_injection_preflight",
        "authenticated_cancellation",
        "settle_wait",
        "queue_recovery",
        "post_recovery_readiness",
      ].includes(step.name)
    )
    expect(mutationSteps.every((step) => step.status === "skipped")).toBe(true)
    const dockerCalls = vi.mocked(deps.execFile).mock.calls.filter(([cmd]) => cmd === "docker")
    expect(dockerCalls).toHaveLength(0)
    expect(deps.reconcile).not.toHaveBeenCalled()
    expect(receipt.steps.some((step) => step.status === "failed")).toBe(false)
  })

  it("records a step timeout as failed", async () => {
    const deps = makeDeps({
      fetch: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ status: "ready" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  })
                ),
              5000
            )
          })
      ) as unknown as typeof fetch,
    })
    const receipt = await verifyLaunchAssurance(
      {
        ...baseOptions(),
        allowStorageProof: false,
        allowFailureInjection: false,
        workerImage: undefined,
        workerEnvFile: undefined,
        egressPinFile: undefined,
        scanId: undefined,
        workspaceId: undefined,
        environment: undefined,
        confirmProduction: undefined,
        stepTimeoutMs: 50,
      },
      deps
    )
    const readiness = receipt.steps.find((step) => step.name === "readiness")
    expect(readiness?.status).toBe("failed")
    expect(readiness?.reason).toContain("timed out")
  })

  it("bounded and redacts failure reasons", async () => {
    const longSecret = `AKIA${"s".repeat(200)}`
    const deps = makeDeps({
      execFile: vi.fn(async () => {
        throw new Error(`provider payload leaked ${longSecret} ${"x".repeat(500)}`)
      }) as unknown as LaunchAssuranceDeps["execFile"],
    })
    const receipt = await verifyLaunchAssurance(
      {
        ...baseOptions(),
        allowFailureInjection: false,
        scanId: undefined,
        workspaceId: undefined,
        environment: undefined,
        confirmProduction: undefined,
      },
      deps
    )
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain(longSecret)
    for (const step of receipt.steps) {
      if (step.reason) expect(step.reason.length).toBeLessThanOrEqual(200)
    }
  })

  it("cleans up the disposable container when a storage proof fails", async () => {
    const deps = makeDeps({
      execFile: vi.fn(async (command: string, args: string[]) => {
        if (command === "docker" && args[0] === "run") {
          throw new Error("docker run failed")
        }
        if (command === "docker" && args[0] === "rm") {
          return { stdout: "" }
        }
        throw new Error(`unexpected command: ${command}`)
      }) as unknown as LaunchAssuranceDeps["execFile"],
    })
    const receipt = await verifyLaunchAssurance(
      {
        ...baseOptions(),
        allowFailureInjection: false,
        scanId: undefined,
        workspaceId: undefined,
        environment: undefined,
        confirmProduction: undefined,
      },
      deps
    )
    expect(receipt.steps.find((step) => step.name === "storage_fail_closed_proof")?.status).toBe(
      "failed"
    )
    const rmCalls = vi
      .mocked(deps.execFile)
      .mock.calls.filter(([command, args]) => command === "docker" && args[0] === "rm")
    expect(rmCalls.length).toBeGreaterThanOrEqual(1)
    expect(receipt.cleanup.removedContainers.length).toBeGreaterThanOrEqual(1)
  })

  it("refuses failure injection when unrelated active work exists", async () => {
    const deps = makeDeps({
      listActiveScans: vi.fn(async (): Promise<Array<{ id: string; status: ScanStatus }>> => [
        { id: "cmt0q9a28000501jnmn1t453t", status: "RUNNING" },
        { id: "cmt0q9a28000502jnmn1t453u", status: "QUEUED" },
      ]),
    })
    const receipt = await verifyLaunchAssurance(baseOptions(), deps)
    const preflight = receipt.steps.find((step) => step.name === "failure_injection_preflight")
    expect(preflight?.status).toBe("failed")
    expect(preflight?.reason).toContain("unrelated active scan")
    expect(receipt.overall).toBe("failed")
  })

  it("poll cancellation through settle and rejects post-cancellation engine starts", async () => {
    let poll = 0
    let clock = Date.parse("2026-08-25T00:00:00.000Z")
    const deps = makeDeps({
      now: vi.fn(() => {
        clock += 3_000
        return new Date(clock)
      }),
      getScanState: vi.fn(
        async (): Promise<{ id: string; workspaceId: string; status: ScanStatus }> => {
          poll += 1
          return {
            id: "cmt0q9a28000501jnmn1t453t",
            workspaceId: "cmt7np5uv000002s6pnr7c376",
            status: poll < 3 ? "RUNNING" : "CANCELLED",
          }
        }
      ),
    })
    const receipt = await verifyLaunchAssurance({ ...baseOptions(), stepTimeoutMs: 15_000 }, deps)
    expect(receipt.steps.find((step) => step.name === "settle_wait")?.status).toBe("passed")
    expect(poll).toBeGreaterThanOrEqual(3)

    const failingDeps = makeDeps({ countEngineStartsSince: vi.fn(async () => 1) })
    const failing = await verifyLaunchAssurance(baseOptions(), failingDeps)
    expect(failing.steps.find((step) => step.name === "settle_wait")?.status).toBe("failed")
    expect(failing.steps.find((step) => step.name === "settle_wait")?.reason).toContain(
      "engine_start"
    )
  })

  it("never replays ambiguous paid work through reconciliation", async () => {
    const deps = makeDeps()
    await verifyLaunchAssurance(baseOptions(), deps)
    // The orchestrator must not call job.remove or delete keys itself: the
    // only recovery call is the shared reconcileScanQueue wrapper, invoked
    // exactly once in full mode.
    const dockerCalls = vi
      .mocked(deps.execFile)
      .mock.calls.filter(([command]) => command === "docker")
    for (const [, args] of dockerCalls) {
      expect(args.join(" ")).not.toMatch(/job\.remove|del .*bull|keys/)
    }
    expect(deps.reconcile).toHaveBeenCalledTimes(1)
  })
})
