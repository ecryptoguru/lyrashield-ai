import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const turboBinary = path.join(repositoryRoot, "node_modules/.bin/turbo")
const turboConfig = JSON.parse(readFileSync(path.join(repositoryRoot, "turbo.json"), "utf8"))

const credentialNames = [
  "DATABASE_URL",
  "DATABASE_DIRECT_URL",
  "REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "AZURE_AD_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_CLIENT_SECRET",
  "LLM_API_KEY",
  "LYRASHIELD_WEB_SEARCH_API_KEY",
  "LYRASHIELD_EGRESS_PROXY_SECRET",
  "LYRASHIELD_RELAY_SIGNING_SECRET",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "BREVO_API_KEY",
  "SLACK_WEBHOOK_URL",
  "DISCORD_WEBHOOK_URL",
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "LICENSE_SIGNING_PRIVATE_KEY",
  "LYRASHIELD_INTERNAL_API_KEY",
  "RAZORPAYX_API_KEY",
  "RAZORPAYX_API_SECRET",
  "PAYONEER_API_KEY",
  "PAYONEER_API_SECRET",
  "SENTRY_DSN",
]

function taskConfig(packageName, taskName) {
  return turboConfig.tasks?.[`${packageName}#${taskName}`] ?? {}
}

function taskHash(packageName, taskName, variables) {
  const result = spawnSync(
    turboBinary,
    ["run", taskName, `--filter=${packageName}`, "--only", "--dry=json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ...variables },
      timeout: 30_000,
    }
  )

  assert.equal(result.status, 0, "Turbo dry-run should produce a task hash")
  const summary = JSON.parse(result.stdout)
  const task = summary.tasks.find((entry) => entry.package === packageName && entry.task === taskName)
  assert.ok(task, `Turbo dry-run should include ${packageName}#${taskName}`)
  return task.hash
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function runFixtureTurbo(root, task, packageName, env) {
  const result = spawnSync(turboBinary, ["run", task, `--filter=${packageName}`], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 15_000,
  })

  assert.equal(result.status, 0, "strict-mode fixture task should complete")
  return result.stdout
}

function fixtureTaskHash(root, packageName, taskName) {
  const result = spawnSync(
    turboBinary,
    ["run", taskName, `--filter=${packageName}`, "--only", "--dry=json"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NEXT_PUBLIC_APP_URL: "https://fixture.example" },
      timeout: 15_000,
    }
  )

  assert.equal(result.status, 0, "fixture Turbo dry-run should produce a task hash")
  const summary = JSON.parse(result.stdout)
  const task = summary.tasks.find((entry) => entry.package === packageName && entry.task === taskName)
  assert.ok(task, `fixture Turbo dry-run should include ${packageName}#${taskName}`)
  return task.hash
}

test("credential values are excluded from global cache inputs", () => {
  const globalEnv = new Set(turboConfig.globalEnv ?? [])
  for (const name of credentialNames) {
    assert.equal(globalEnv.has(name), false, `${name} must not be a global task-hash input`)
  }
  assert.equal((turboConfig.globalDependencies ?? []).includes(".env"), false)
})

test("changing a server credential does not change a cached web build hash", () => {
  const webPackage = JSON.parse(readFileSync(path.join(repositoryRoot, "apps/web/package.json"), "utf8"))
  assert.equal(
    taskHash(webPackage.name, "build", { DATABASE_URL: "postgres://private-probe-a" }),
    taskHash(webPackage.name, "build", { DATABASE_URL: "postgres://private-probe-b" })
  )
})

test("public values that affect built assets remain task-level hash inputs", () => {
  const requiredByBuild = [
    [
      "@lyrashield/web",
      [
        "NEXT_PUBLIC_APP_URL",
        "NEXT_PUBLIC_MARKETING_URL",
        "NEXT_PUBLIC_POSTHOG_KEY",
        "NEXT_PUBLIC_POSTHOG_HOST",
        "NEXT_PUBLIC_SENTRY_DSN",
        "NEXT_PUBLIC_SENTRY_RELEASE",
      ],
    ],
    [
      "@lyrashield/marketing",
      [
        "PUBLIC_SITE_URL",
        "PUBLIC_INDEXABLE",
        "PUBLIC_X_URL",
        "PUBLIC_APP_URL",
        "PUBLIC_SCANNER_URL",
        "PUBLIC_TURNSTILE_SITE_KEY",
        "PUBLIC_ABUSE_EMAIL",
        "PUBLIC_MYRA_MARKETING_ENABLED",
        "LYRASHIELD_LOCAL_PREVIEW",
        "LYRASHIELD_MARKETING_REVISION",
        "GITHUB_SHA",
        "PUBLIC_GOOGLE_SITE_VERIFICATION",
        "PUBLIC_BING_SITE_VERIFICATION",
        "PUBLIC_MEDIA_URL",
        "PUBLIC_POSTHOG_KEY",
        "PUBLIC_POSTHOG_HOST",
        "PUBLIC_SUPPORT_EMAIL",
        "PUBLIC_SECURITY_EMAIL",
        "PUBLIC_MOTION_RENDER_HASH",
      ],
    ],
    [
      "@lyrashield/marketing-motion",
      ["VITE_OUTPUT_VARIANT", "VITE_COMP_ID", "VITE_COMP_WIDTH", "VITE_COMP_HEIGHT", "VITE_SHOW_COPY"],
    ],
  ]

  for (const [packageName, names] of requiredByBuild) {
    const config = taskConfig(packageName, "build")
    for (const name of names) {
      assert.ok(config.env?.includes(name), `${packageName}#build must hash ${name}`)
      assert.equal(turboConfig.globalEnv?.includes(name), false, `${name} is scoped to its build task`)
    }
    assert.ok(config.inputs?.includes("$TURBO_DEFAULT$"), `${packageName}#build keeps default inputs`)
    assert.ok(config.inputs?.includes(".env*"), `${packageName}#build hashes its package dotenv files`)
  }

  const webPackage = JSON.parse(readFileSync(path.join(repositoryRoot, "apps/web/package.json"), "utf8"))
  const marketingPackage = JSON.parse(
    readFileSync(path.join(repositoryRoot, "apps/marketing/package.json"), "utf8")
  )
  const motionPackage = JSON.parse(
    readFileSync(path.join(repositoryRoot, "apps/marketing-motion/package.json"), "utf8")
  )

  assert.notEqual(
    taskHash(webPackage.name, "build", { NEXT_PUBLIC_APP_URL: "https://hash-a.example" }),
    taskHash(webPackage.name, "build", { NEXT_PUBLIC_APP_URL: "https://hash-b.example" })
  )
  assert.notEqual(
    taskHash(marketingPackage.name, "build", { PUBLIC_SITE_URL: "https://hash-a.example" }),
    taskHash(marketingPackage.name, "build", { PUBLIC_SITE_URL: "https://hash-b.example" })
  )
  assert.notEqual(
    taskHash(motionPackage.name, "build", { VITE_COMP_ID: "composition-a" }),
    taskHash(motionPackage.name, "build", { VITE_COMP_ID: "composition-b" })
  )
})

test("build task dotenv files stay in scoped task inputs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lyrashield-turbo-dotenv-hash-"))
  try {
    writeJson(path.join(root, "package.json"), {
      name: "turbo-dotenv-fixture",
      private: true,
      packageManager: "pnpm@12.2.0",
    })
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n')
    writeJson(path.join(root, "turbo.json"), {
      $schema: "https://turbo.build/schema.json",
      tasks: {
        build: { outputs: ["dist/**"] },
        "@fixture/web#build": {
          env: ["NEXT_PUBLIC_APP_URL"],
          inputs: ["$TURBO_DEFAULT$", ".env*"],
        },
      },
    })
    writeJson(path.join(root, "apps/web/package.json"), {
      name: "@fixture/web",
      scripts: { build: "node -e \\\"process.exit(0)\\\"" },
    })
    const dotenvPath = path.join(root, "apps/web/.env.production")
    writeFileSync(dotenvPath, "NEXT_PUBLIC_APP_URL=https://first.example\n")

    const firstHash = fixtureTaskHash(root, "@fixture/web", "build")
    writeFileSync(dotenvPath, "NEXT_PUBLIC_APP_URL=https://second.example\n")
    const secondHash = fixtureTaskHash(root, "@fixture/web", "build")
    assert.notEqual(firstHash, secondHash)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("web build hashes required public inputs while passing runtime-only config values", () => {
  const webBuild = taskConfig("@lyrashield/web", "build")
  assert.ok(webBuild.env?.includes("MYRA_WRITES_ENABLED"))
  for (const name of ["DATABASE_URL", "BETTER_AUTH_SECRET", "SENTRY_DSN"]) {
    assert.ok(webBuild.passThroughEnv?.includes(name), `web build still receives ${name}`)
  }
  for (const name of ["DATABASE_URL", "BETTER_AUTH_SECRET", "SENTRY_DSN"]) {
    assert.equal(webBuild.env?.includes(name), false)
  }
})

test("runtime tasks receive only their owned credentials and worker dotenv remains loadable", () => {
  const expected = {
    "@lyrashield/web": [
      "DATABASE_URL",
      "REDIS_URL",
      "BETTER_AUTH_SECRET",
      "GITHUB_CLIENT_SECRET",
      "GOOGLE_CLIENT_SECRET",
      "AZURE_AD_CLIENT_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_CLIENT_SECRET",
      "UPSTASH_REDIS_REST_TOKEN",
      "BREVO_API_KEY",
      "POLAR_ACCESS_TOKEN",
      "POLAR_WEBHOOK_SECRET",
      "RAZORPAY_KEY_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
      "LICENSE_SIGNING_PRIVATE_KEY",
      "LYRASHIELD_INTERNAL_API_KEY",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
      "SENTRY_DSN",
      "SLACK_WEBHOOK_URL",
      "DISCORD_WEBHOOK_URL",
    ],
    "@lyrashield/worker": [
      "DATABASE_URL",
      "REDIS_URL",
      "BETTER_AUTH_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "LLM_API_KEY",
      "LYRASHIELD_WEB_SEARCH_API_KEY",
      "LYRASHIELD_EGRESS_PROXY_SECRET",
      "LYRASHIELD_RELAY_SIGNING_SECRET",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
      "BREVO_API_KEY",
      "SLACK_WEBHOOK_URL",
      "DISCORD_WEBHOOK_URL",
      "POLAR_ACCESS_TOKEN",
      "RAZORPAY_KEY_SECRET",
      "RAZORPAYX_API_KEY",
      "RAZORPAYX_API_SECRET",
      "PAYONEER_API_KEY",
      "PAYONEER_API_SECRET",
      "SENTRY_DSN",
    ],
    "@lyrashield/egress-proxy": ["LYRASHIELD_EGRESS_PROXY_SECRET", "LYRASHIELD_RELAY_SIGNING_SECRET"],
  }

  const webBuild = taskConfig("@lyrashield/web", "build")
  assert.ok(webBuild.passThroughEnv?.includes("DATABASE_URL"))
  assert.ok(webBuild.passThroughEnv?.includes("BETTER_AUTH_SECRET"))
  assert.ok(!webBuild.passThroughEnv?.includes("LLM_API_KEY"))

  for (const [packageName, names] of Object.entries(expected)) {
    for (const taskName of packageName === "@lyrashield/egress-proxy" ? ["start"] : ["dev", "start"]) {
      const config = taskConfig(packageName, taskName)
      assert.deepEqual(
        [...(config.passThroughEnv ?? [])].sort(),
        [...names].sort(),
        `${packageName}#${taskName} receives its runtime credentials only`
      )
    }
  }

  const workerPackage = JSON.parse(
    readFileSync(path.join(repositoryRoot, "apps/worker/package.json"), "utf8")
  )
  assert.match(workerPackage.scripts.dev, /--env-file=\.\.\/\.\.\/\.env/)

  const root = mkdtempSync(path.join(os.tmpdir(), "lyrashield-turbo-env-"))
  try {
    writeJson(path.join(root, "package.json"), {
      name: "turbo-env-fixture",
      private: true,
      packageManager: "pnpm@12.2.0",
    })
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n')
    writeFileSync(path.join(root, ".env"), "WORKER_FILE_ONLY=loaded\n")
    writeFileSync(
      path.join(root, "turbo.json"),
      `${JSON.stringify(
        {
          $schema: "https://turbo.build/schema.json",
          tasks: {
            dev: { cache: false },
            "@fixture/web#dev": { passThroughEnv: ["WEB_CREDENTIAL"] },
            "@fixture/worker#dev": { passThroughEnv: ["WORKER_CREDENTIAL"] },
          },
        },
        null,
        2
      )}\n`
    )
    writeFileSync(
      path.join(root, "print-env.mjs"),
      "console.log(`web=${Boolean(process.env.WEB_CREDENTIAL)} worker=${Boolean(process.env.WORKER_CREDENTIAL)} file=${Boolean(process.env.WORKER_FILE_ONLY)}`)\n"
    )
    writeJson(path.join(root, "apps/web/package.json"), {
      name: "@fixture/web",
      scripts: { dev: "node ../../print-env.mjs" },
    })
    writeJson(path.join(root, "apps/worker/package.json"), {
      name: "@fixture/worker",
      scripts: { dev: "node --env-file=../../.env ../../print-env.mjs" },
    })

    const webOutput = runFixtureTurbo(root, "dev", "@fixture/web", {
      WEB_CREDENTIAL: "web-sentinel",
      WORKER_CREDENTIAL: "worker-sentinel",
    })
    assert.match(webOutput, /web=true worker=false file=false/)

    const workerOutput = runFixtureTurbo(root, "dev", "@fixture/worker", {
      WEB_CREDENTIAL: "web-sentinel",
      WORKER_CREDENTIAL: "worker-sentinel",
    })
    assert.match(workerOutput, /web=false worker=true file=true/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
