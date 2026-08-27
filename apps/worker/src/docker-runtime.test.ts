import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const dockerfile = readFileSync(
  fileURLToPath(new URL("../../../Dockerfile", import.meta.url)),
  "utf8"
)
// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const imageVerifier = readFileSync(
  fileURLToPath(new URL("../scripts/verify-worker-image.sh", import.meta.url)),
  "utf8"
)
// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const dockerIgnore = readFileSync(
  fileURLToPath(new URL("../../../.dockerignore", import.meta.url)),
  "utf8"
)
// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const deployWorkflow = readFileSync(
  fileURLToPath(new URL("../../../.github/workflows/deploy-azure.yml", import.meta.url)),
  "utf8"
)
// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const ciWorkflow = readFileSync(
  fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)),
  "utf8"
)
// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const workerRunner = readFileSync(
  fileURLToPath(new URL("../../../ops/worker/run-worker.sh", import.meta.url)),
  "utf8"
)
// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const workerPromoter = readFileSync(
  fileURLToPath(new URL("../../../.github/scripts/promote-worker-vm.sh", import.meta.url)),
  "utf8"
)
// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const workerSecretRefresh = readFileSync(
  fileURLToPath(new URL("../../../ops/worker/refresh-secrets.sh", import.meta.url)),
  "utf8"
)
// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const dockerCompose = readFileSync(
  fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url)),
  "utf8"
)
// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const engineContractVerifier = readFileSync(
  fileURLToPath(
    new URL("../../../.github/scripts/verify-engine-worker-contract.sh", import.meta.url)
  ),
  "utf8"
)
const pinnedNodeBase =
  "node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43"

describe("worker Docker runtime", () => {
  it("pins every Node base stage to one immutable digest", () => {
    expect(dockerfile).not.toMatch(/^FROM node:24-alpine AS/m)
    expect(dockerfile.match(/^FROM node:24-alpine@sha256:[0-9a-f]{64} AS/gm) ?? []).toHaveLength(6)
    expect(new Set(dockerfile.match(/node:24-alpine@sha256:[0-9a-f]{64}/g))).toHaveLength(1)
  })

  it("starts with the vendored TypeScript runner without invoking Corepack", () => {
    const workerStage = dockerfile.slice(dockerfile.indexOf(`FROM ${pinnedNodeBase} AS worker`))

    expect(workerStage).not.toContain("corepack")
    expect(workerStage).toContain(
      'CMD ["./apps/worker/node_modules/.bin/tsx", "apps/worker/src/index.ts"]'
    )
  })

  it("installs the engine non-editably and omits its build checkout", () => {
    const workerMarker = `FROM ${pinnedNodeBase} AS worker\n`
    const engineStage = dockerfile.slice(
      dockerfile.indexOf(`FROM ${pinnedNodeBase} AS worker-engine`),
      dockerfile.indexOf(workerMarker)
    )
    const workerStage = dockerfile.slice(dockerfile.indexOf(workerMarker))

    expect(engineStage).toContain("--no-editable")
    expect(workerStage).not.toContain(
      "COPY --from=worker-engine /opt/lyrashield-engine /opt/lyrashield-engine"
    )
    expect(dockerfile).toContain(
      "pnpm --filter @lyrashield/worker deploy --prod --legacy /worker-runtime"
    )
    expect(workerStage).toContain("COPY --from=worker-deps /worker-runtime ./apps/worker")
    expect(workerStage).not.toContain("COPY --from=deps /app/node_modules ./node_modules")
    expect(workerStage).not.toContain("COPY --from=workspace-builder /app/packages ./packages")
    expect(workerStage).toContain(
      "COPY --from=worker-engine /opt/lyrashield-venv /opt/lyrashield-venv"
    )
    expect(workerStage).toContain('-name "*.test.ts"')
    expect(workerStage).toContain("-delete")
  })

  it("isolates the worker production deploy from the web build workspace", () => {
    const workerDepsMarker = "FROM workspace-builder AS worker-deps\n"
    const webBuilderMarker = "FROM workspace-builder AS web-builder\n"
    const workerDepsStage = dockerfile.slice(
      dockerfile.indexOf(workerDepsMarker),
      dockerfile.indexOf(webBuilderMarker)
    )

    expect(dockerfile).toContain(workerDepsMarker)
    expect(workerDepsStage).toContain(
      "pnpm --filter @lyrashield/worker deploy --prod --legacy /worker-runtime"
    )
    expect(dockerfile).toContain("COPY --from=worker-deps /worker-runtime ./apps/worker")
  })

  it("keeps nested development worktrees out of image build contexts", () => {
    expect(dockerIgnore.split("\n")).toContain(".worktrees/")
    expect(dockerIgnore.split("\n")).toContain("lyrashield-engine/")
  })

  it("pins and records the exact engine revision used by production workers", () => {
    expect(deployWorkflow).toMatch(/ENGINE_REVISION: [0-9a-f]{40}/)
    expect(deployWorkflow).toContain("ref: ${{ env.ENGINE_REVISION }}")
    expect(deployWorkflow).toContain("io.lyrashield.engine.revision=${{ env.ENGINE_REVISION }}")
    expect(deployWorkflow).not.toContain("continue-on-error: true")
    expect(deployWorkflow.match(/persist-credentials: false/g) ?? []).toHaveLength(2)
    expect(deployWorkflow).not.toContain("runs-on: ubuntu-latest")
    expect(deployWorkflow).not.toContain("id-token: write")
    expect(deployWorkflow).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020")
    expect(deployWorkflow).toContain(
      "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97"
    )
    expect(deployWorkflow).toContain("astral-sh/setup-uv@20cfd1bf945f4377ade1205e4dbc17946fc9a30d")
    expect(deployWorkflow).toContain('node-version: "24"')
    expect(deployWorkflow).toContain('python-version: "3.12"')
    expect(deployWorkflow).toContain("Verify engine-worker contract")
    expect(deployWorkflow).toContain(
      'bash .github/scripts/verify-engine-worker-contract.sh lyrashield-engine "$GITHUB_WORKSPACE"'
    )
    expect(engineContractVerifier).toContain('merge-base --is-ancestor "$reviewed_app_sha" HEAD')
    expect(engineContractVerifier).toContain("uv run lyrashield --help")
    expect(engineContractVerifier).toContain('corepack pnpm exec vitest run "${contract_tests[@]}"')
    expect(deployWorkflow).toContain("Verify pushed worker image")
    const deployAppStep = deployWorkflow.slice(
      deployWorkflow.indexOf("- name: Deploy app Container App"),
      deployWorkflow.indexOf("- name: Deploy scanner Container App")
    )
    expect(deployAppStep).toContain("POLAR_ENVIRONMENT: ${{ vars.POLAR_ENVIRONMENT }}")
    expect(deployAppStep).toContain('"POLAR_ENVIRONMENT=${POLAR_ENVIRONMENT}"')
    expect(deployAppStep).toContain('"LYRASHIELD_DEPLOYMENT_ENVIRONMENT=production"')
    expect(deployAppStep).toContain('"BILLING_STAGING_ADMISSION=off"')
    expect(deployAppStep).toContain('"BILLING_STAGING_ACCESS_TOKEN="')
    expect(
      deployWorkflow.match(/"PLATFORM_ADMIN_EMAILS=\$\{\{ env\.PLATFORM_ADMIN_EMAILS \}\}"/g) ?? []
    ).toHaveLength(2)
    expect(ciWorkflow).toContain(
      'PLATFORM_ADMIN_EMAILS: "ecryptoguru@gmail.com,ankit@lyrashieldai.com"'
    )
    expect(workerRunner).toContain(
      "--env PLATFORM_ADMIN_EMAILS=ecryptoguru@gmail.com,ankit@lyrashieldai.com"
    )
    expect(deployWorkflow).toContain("@${{ steps.build-worker.outputs.digest }}")
    expect(deployWorkflow).toContain("tags: ${{ env.WORKER_IMAGE }}:${{ env.DEPLOY_SHA }}")
    expect(deployWorkflow).not.toContain("${{ env.WORKER_IMAGE }}:latest")
    expect(deployWorkflow).toContain('"${{ env.DEPLOY_SHA }}" "${{ env.ENGINE_REVISION }}"')
    expect(imageVerifier).toContain("org.opencontainers.image.revision")
    expect(imageVerifier).toContain("io.lyrashield.engine.revision")
    expect(ciWorkflow).toContain("engine-worker-contract:")
    expect(ciWorkflow).toContain("Read pinned engine revision")
    expect(ciWorkflow).toContain("Verify engine revision provenance")
    expect(ciWorkflow).toContain("Verify pinned engine-worker contract")
    expect(ciWorkflow).toContain("ref: ${{ steps.engine.outputs.revision }}")
    expect(ciWorkflow).not.toContain("id-token: write")
    expect(deployWorkflow).toContain("Verify engine revision provenance")
    expect(deployWorkflow).toContain("packages: write")
    expect(deployWorkflow).not.toMatch(/^permissions:\n  contents: read\n  packages: write/m)
    const appSmoke = deployWorkflow.slice(
      deployWorkflow.indexOf("smoke_candidate()"),
      deployWorkflow.indexOf("smoke_egress_candidate()")
    )
    const egressSmoke = deployWorkflow.slice(
      deployWorkflow.indexOf("smoke_egress_candidate()"),
      deployWorkflow.indexOf("smoke_candidate app")
    )
    for (const smoke of [appSmoke, egressSmoke]) {
      expect(smoke).toContain("for attempt in $(seq 1 120)")
      expect(smoke).toContain('if [ "$attempt" = "61" ]')
      expect(
        smoke.match(/timeout --foreground 180s az containerapp revision restart/g)
      ).toHaveLength(1)
    }
    expect(deployWorkflow).toContain(
      'smoke_candidate app "$APP_NAME" "$APP_REVISION" "$APP_FQDN" /api/ready'
    )
    expect(deployWorkflow).toContain(
      'smoke_candidate scanner "$SCANNER_NAME" "$SCANNER_REVISION" "$SCANNER_FQDN" /api/ready'
    )
    expect(deployWorkflow).toContain("failed after one bounded revision restart")
  })

  it("audits private-key content without rejecting public certificate bundles", () => {
    expect(imageVerifier).toContain("BEGIN ([A-Z0-9 ]*)PRIVATE KEY")
    expect(imageVerifier).not.toContain('-name "*.pem"')
    expect(imageVerifier).toContain("/opt/lyrashield-engine")
    expect(imageVerifier).toContain("interface/viewer/frontend")
  })

  it("promotes the exact worker digest with bounded rollback and verification", () => {
    expect(deployWorkflow).toContain("Validate worker provenance record")
    expect(deployWorkflow).toContain("LYRASHIELD_PRODUCT_REVISION=${{ env.DEPLOY_SHA }}")
    expect(deployWorkflow).toContain("LYRASHIELD_WORKER_IMAGE_DIGEST=$digest")
    expect(deployWorkflow).toContain("LYRASHIELD_ENGINE_REVISION=${{ env.ENGINE_REVISION }}")
    expect(deployWorkflow).toContain("Promote verified worker digest on VM")
    expect(deployWorkflow).toContain("AZURE_VM_RUN_COMMAND_TIMEOUT_SECONDS=1800")
    expect(deployWorkflow).toContain("needs: [build, deploy]")
    expect(workerPromoter).toContain('systemctl stop "$timer"')
    expect(workerPromoter).toContain('docker pull "$target"')
    expect(workerPromoter).toContain("Worker promotion requires empty scan and webhook queues")
    expect(workerPromoter).toContain('cp -p "$backup" "$config"')
    expect(workerPromoter).toContain("LYRASHIELD_WORKER_IMAGE_DIGEST")
    expect(workerPromoter).toContain("resume_admission")
  })

  it("injects immutable image-derived provenance into the worker runtime", () => {
    expect(workerRunner).toContain('{{index .Config.Labels "org.opencontainers.image.revision"}}')
    expect(workerRunner).toContain('{{index .Config.Labels "io.lyrashield.engine.revision"}}')
    expect(workerRunner).toContain("--env LYRASHIELD_PRODUCT_REVISION=")
    expect(workerRunner).toContain("--env LYRASHIELD_WORKER_IMAGE_DIGEST=")
    expect(workerRunner).toContain("--env LYRASHIELD_ENGINE_REVISION=")
    // No mutable tag or manually typed revision may supply provenance.
    expect(workerRunner).toContain("${LYRASHIELD_WORKER_IMAGE##*@}")
    expect(workerRunner).toContain('if ! docker image inspect "$image" >/dev/null 2>&1; then')
    expect(workerRunner).toContain('docker pull "$image" >/dev/null')
  })

  it("refreshes the complete evidence key rotation set before worker startup", () => {
    expect(workerSecretRefresh).toContain("read_secret_optional worker-evidence-kek-config-ref")
    expect(workerSecretRefresh).toContain(
      'write_secret LYRASHIELD_EVIDENCE_KEK "$evidence_kek_secret_name"'
    )
    expect(workerSecretRefresh).toContain(
      'evidence_kek_keyring_secret_name="worker-evidence-kek-keyring-$evidence_kek_keyring_digest"'
    )
    expect(workerSecretRefresh).toContain("Evidence KEK keyring digest does not match config ref")
    expect(deployWorkflow).toContain(
      '"LYRASHIELD_EVIDENCE_KEK_KEYRING=secretref:${LYRASHIELD_EVIDENCE_KEK_KEYRING_SECRET}"'
    )
    expect(deployWorkflow).not.toContain('"lyrashield-evidence-kek=${LYRASHIELD_EVIDENCE_KEK}"')
    expect(deployWorkflow).toContain("az containerapp secret list")
    expect(deployWorkflow).toContain("Immutable active evidence secret already exists")
    expect(deployWorkflow).toContain("Immutable evidence keyring secret already exists")
  })

  it("binds evidence storage only to the web app runtime", () => {
    const appDeployment = deployWorkflow.slice(
      deployWorkflow.indexOf("- name: Deploy app Container App"),
      deployWorkflow.indexOf("- name: Deploy scanner Container App")
    )
    const scannerDeployment = deployWorkflow.slice(
      deployWorkflow.indexOf("- name: Deploy scanner Container App"),
      deployWorkflow.indexOf("- name: Deploy egress-proxy Container App")
    )

    for (const secret of [
      "worker-r2-endpoint",
      "worker-r2-bucket",
      "worker-r2-access-key",
      "worker-r2-secret-key",
    ]) {
      expect(deployWorkflow).toContain(`read_secret ${secret}`)
    }
    for (const binding of [
      '"S3_ENDPOINT=secretref:evidence-s3-endpoint"',
      '"S3_BUCKET=secretref:evidence-s3-bucket"',
      '"S3_ACCESS_KEY=secretref:evidence-s3-access"',
      '"S3_SECRET_KEY=secretref:evidence-s3-secret"',
      '"S3_REGION=auto"',
    ]) {
      expect(appDeployment).toContain(binding)
      expect(scannerDeployment).not.toContain(binding)
    }
    expect(scannerDeployment).not.toContain("LYRASHIELD_EVIDENCE_KEK")
  })

  it("shares engine work and temp paths with the host Docker daemon", () => {
    expect(workerRunner).toContain("worker_shared_root=/var/lib/lyrashield/worker")
    expect(workerRunner).toContain('--env LYRASHIELD_ENGINE_WORK_ROOT="$worker_shared_root"')
    expect(workerRunner).toContain('--env TMPDIR="$worker_shared_root/tmp"')
    expect(
      workerRunner.match(/type=bind,src="\$worker_shared_root",dst="\$worker_shared_root"/g) ?? []
    ).toHaveLength(2)
    expect(workerRunner).not.toContain("lyrashield-worker-runs")
    expect(workerRunner).not.toContain("dst=/app/apps/worker/lyrashield_runs")
  })

  it("requires an operator-owned worker temp path without privileged recursive mutation", () => {
    const workerService = dockerCompose.slice(
      dockerCompose.indexOf("  worker:"),
      dockerCompose.indexOf("\nvolumes:")
    )

    expect(workerService).toContain(
      'TMPDIR: "${LYRASHIELD_WORKER_TEMP_ROOT:-${PWD}/.lyrashield-worker-tmp}"'
    )
    expect(
      workerService.match(
        /\$\{LYRASHIELD_WORKER_TEMP_ROOT:-\$\{PWD\}\/\.lyrashield-worker-tmp\}/g
      ) ?? []
    ).toHaveLength(3)
    expect(workerService).not.toContain("- /tmp:/tmp")
    expect(workerService).not.toContain("source: /tmp/lyrashield-worker")
    expect(dockerCompose).not.toContain("worker-temp-init")
    expect(dockerCompose).not.toContain("chown -R")
  })
})
