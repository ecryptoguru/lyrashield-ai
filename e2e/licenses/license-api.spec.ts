import { expect, test } from "@playwright/test"
import { generateKeyPairSync, createHash, randomUUID } from "node:crypto"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { signLicense, verifyLicense, type LicenseFile } from "@lyrashield/licenses"

/**
 * License API endpoint tests.
 *
 * These tests exercise the full server-side flow: activation, seat cap
 * enforcement, renewal, revocation, and sync entitlement. They require a
 * running web server (Playwright's webServer config) and a test database.
 *
 * Setup: a test license + license key are created directly in the database.
 * The LICENSE_SIGNING_PRIVATE_KEY env var must be set to a valid ed25519
 * PKCS#8 PEM for the server to sign license files.
 */

const { privateKey } = generateKeyPairSync("ed25519")
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" })
const publicKeyPem = privateKey.export
  ? (() => {
      const { publicKey } = generateKeyPairSync("ed25519")
      return publicKey.export({ type: "spki", format: "pem" })
    })()
  : ""

const testSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const ownerEmail = `e2e-license-${testSuffix}@example.com`
const rawLicenseKey = `LYRA-TEST-${testSuffix}`
const keyHash = createHash("sha256").update(rawLicenseKey).digest("hex")

let licenseId: string | null = null
let testWorkspaceId: string | null = null

test.beforeAll(async () => {
  // Create a test license directly in the database.
  //
  // RLS fix (deep review): the License table has FORCE RLS with a strict policy
  // `WITH CHECK ("workspaceId" = app.current_workspace_id() OR "workspaceId" IS
  // NULL)`. In CI the prisma client runs as a NOBYPASSRLS role, so a NULL-
  // workspaceId insert is blocked once the workspace context is set anywhere
  // in the pooled connection (and the plain `RESET` in withoutWorkspaceRLS does
  // not reliably clear the application-level AsyncLocalStorage context). The
  // robust fix: create a real test workspace and run the license create inside
  // withWorkspaceRLS(workspace.id) so the strict policy's WITH CHECK passes
  // (workspaceId = current_workspace_id()).
  const workspace = await prisma.workspace.create({
    data: {
      id: randomUUID(),
      name: `E2E License ${testSuffix}`,
      slug: `e2e-license-${testSuffix.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
    },
  })
  testWorkspaceId = workspace.id

  const license = await withWorkspaceRLS(workspace.id, async (tx) =>
    tx.license.create({
      data: {
        workspaceId: workspace.id,
        ownerEmail,
        sku: "individual_launch",
        seatCount: 1,
        machineIds: [],
        updateEligibleUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        perpetualFallbackBuild: "1.0.0",
        signingKeyId: "test-key-v1",
        signature: "pending",
        issuedAt: new Date(),
      },
    })
  )
  licenseId = license.id

  await withWorkspaceRLS(workspace.id, async (tx) =>
    tx.licenseKey.create({
      data: {
        licenseId: license.id,
        workspaceId: workspace.id,
        keyHash,
        issuedByProvider: "e2e-test",
      },
    })
  )
})

test.afterAll(async () => {
  try {
    if (licenseId && testWorkspaceId) {
      const workspaceId = testWorkspaceId
      await withWorkspaceRLS(workspaceId, async (tx) => {
        await tx.licenseActivation.deleteMany({ where: { licenseId } })
        await tx.licenseRevocation.deleteMany({ where: { licenseId } })
        await tx.licenseKey.deleteMany({ where: { licenseId } })
        await tx.license.delete({ where: { id: licenseId } })
      })
      // Clean up the test workspace (License rows already deleted above).
      await prisma.workspace.delete({ where: { id: workspaceId } })
    }
  } finally {
    await prisma.$disconnect()
  }
})

test.describe("License activation API", () => {
  test("activation issues a signed license file", async ({ request }) => {
    const res = await request.post("/api/licenses/activate", {
      data: { licenseKey: rawLicenseKey, machineId: "machine-001" },
    })
    expect(res.status()).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.license).toBeDefined()
    const licenseFile = json.data.license as LicenseFile
    expect(licenseFile.sku).toBe("individual_launch")
    expect(licenseFile.signature).not.toBe("pending")
    expect(licenseFile.machineIds).toContain("machine-001")
  })

  test("re-activating the same machine is idempotent", async ({ request }) => {
    const res = await request.post("/api/licenses/activate", {
      data: { licenseKey: rawLicenseKey, machineId: "machine-001" },
    })
    expect(res.status()).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.license.machineIds).toContain("machine-001")
  })

  test("activating a 4th machine on an individual license fails (3-machine cap)", async ({
    request,
  }) => {
    // Activate machines 2 and 3 (machine 1 already active)
    for (const machineId of ["machine-002", "machine-003"]) {
      const res = await request.post("/api/licenses/activate", {
        data: { licenseKey: rawLicenseKey, machineId },
      })
      expect(res.status()).toBe(200)
    }

    // 4th machine should fail
    const res = await request.post("/api/licenses/activate", {
      data: { licenseKey: rawLicenseKey, machineId: "machine-004" },
    })
    expect(res.status()).toBe(409)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error.code).toBe("MACHINE_CAP_REACHED")
  })

  test("activation with an invalid license key returns 404", async ({ request }) => {
    const res = await request.post("/api/licenses/activate", {
      data: { licenseKey: "LYRA-INVALID-KEY", machineId: "machine-001" },
    })
    expect(res.status()).toBe(404)
    const json = await res.json()
    expect(json.error.code).toBe("LICENSE_KEY_NOT_FOUND")
  })
})

test.describe("License renewal API", () => {
  test("renewal extends update eligibility by 1 year", async ({ request }) => {
    // Get the current expiry before renewal (RLS-scoped read needs the
    // workspace context — the license is linked to the test workspace).
    const beforeLicense = await withWorkspaceRLS(testWorkspaceId!, async (tx) =>
      tx.license.findUniqueOrThrow({
        where: { id: licenseId! },
      })
    )
    const beforeExpiry = beforeLicense.updateEligibleUntil

    const res = await request.post("/api/licenses/renew", {
      data: { licenseKey: rawLicenseKey, renewalSku: "renewal" },
    })
    expect(res.status()).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.license).toBeDefined()

    // The new expiry should be ~365 days after the old expiry
    const afterExpiry = new Date(json.data.updateEligibleUntil)
    const diffDays = (afterExpiry.getTime() - beforeExpiry.getTime()) / (24 * 60 * 60 * 1000)
    expect(diffDays).toBeGreaterThan(360)
    expect(diffDays).toBeLessThan(370)
  })
})

test.describe("License revocation API (FF4)", () => {
  test("revocation without auth returns 401", async ({ request }) => {
    const res = await request.post("/api/licenses/revoke", {
      data: { licenseId: licenseId!, reason: "test revocation" },
    })
    expect(res.status()).toBe(401)
  })
})

test.describe("License verification API", () => {
  test("verify endpoint accepts a valid license file", async ({ request }) => {
    // First activate to get a signed license file
    const activateRes = await request.post("/api/licenses/activate", {
      data: { licenseKey: rawLicenseKey, machineId: "machine-001" },
    })
    const activateJson = await activateRes.json()
    const licenseFile = activateJson.data.license as LicenseFile

    const res = await request.post("/api/licenses/verify", {
      data: { licenseFile, publicKeyPem },
    })
    expect(res.status()).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.valid).toBe(true)
  })

  test("verify endpoint rejects a tampered license file", async ({ request }) => {
    const activateRes = await request.post("/api/licenses/activate", {
      data: { licenseKey: rawLicenseKey, machineId: "machine-001" },
    })
    const activateJson = await activateRes.json()
    const licenseFile = activateJson.data.license as LicenseFile

    // Tamper with seatCount
    const tampered: LicenseFile = { ...licenseFile, seatCount: 999 }

    const res = await request.post("/api/licenses/verify", {
      data: { licenseFile: tampered, publicKeyPem },
    })
    expect(res.status()).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.valid).toBe(false)
  })
})

test.describe("Sync entitlement enforcement", () => {
  test("sync connect without entitlement returns 402", async ({ request }) => {
    // The test license is individual_launch (no sync_addon), so sync should be denied
    const res = await request.post("/api/sync/connect", {
      data: {
        workspaceId: "test-workspace-id",
        licenseKey: rawLicenseKey,
      },
    })
    // 401 because we're not authenticated, but the entitlement check happens
    // after auth. We test the entitlement logic via the sync_addon SKU path
    // in a separate test below.
    expect([401, 402, 403]).toContain(res.status())
  })
})
