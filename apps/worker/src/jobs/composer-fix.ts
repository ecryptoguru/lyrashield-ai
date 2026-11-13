/* eslint-disable security/detect-non-literal-fs-filename */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { safeFetchDetailed, type HostResolver } from "@lyrashield/security"
import { COMPOSER_FIX_MAX_BYTES } from "@lyrashield/fix"
import {
  composerContentHash,
  parseComposerLock,
  parseComposerManifest,
} from "../engine/scanners/composer-dependencies"

const runDocker = promisify(execFile)
const COMPOSER_CONSTRAINT_EXIT_CODE = 42
export class ComposerFixUnavailableError extends Error {}
/** Reviewed multiarchitecture Composer 2.10.3 identity; never target-controlled. */
const COMPOSER_RESOLVER_IMAGE =
  "composer@sha256:b6dcd72ca98fa19d0e5b8476de179859704891fad06dd9e0b96833d4c430a5fc"
const RequestSchema = z.object({
  originalManifest: z.string().max(COMPOSER_FIX_MAX_BYTES),
  originalLock: z.string().max(COMPOSER_FIX_MAX_BYTES),
  packageName: z
    .string()
    .max(200)
    .regex(/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/),
  fromVersion: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  toVersion: z.string().regex(/^v?\d+\.\d+\.\d+$/),
})
const PackageSchema = z.record(z.string(), z.unknown())
const LockSchema = z
  .object({
    packages: z.array(PackageSchema).max(500),
    "packages-dev": z.array(PackageSchema).max(500).default([]),
  })
  .catchall(z.unknown())

// Only worker-owned PHP is executed. No target code, scripts, plugins, installation or network.
const RESOLVE_SCRIPT = `<?php
function checkComposerExit($code) {
  if ($code !== 0) exit(in_array($code, [1, 2], true) ? ${COMPOSER_CONSTRAINT_EXIT_CODE} : 1);
}
$original = file_get_contents('/app/composer.original.json');
$originalLockBytes = file_get_contents('/app/composer.lock');
$originalLock = json_decode($originalLockBytes, false, 512, JSON_THROW_ON_ERROR);
$manifest = json_decode($original, true, 512, JSON_THROW_ON_ERROR);
$manifest['repositories'] = [['type' => 'package', 'package' => json_decode(file_get_contents('/app/repository.json'), true, 512, JSON_THROW_ON_ERROR)], ['packagist.org' => false]];
file_put_contents('/app/composer.json', json_encode($manifest, JSON_UNESCAPED_SLASHES));
$flags = ' --no-install --no-scripts --no-plugins --no-interaction --no-audit --no-progress';
passthru('composer update ' . escapeshellarg(getenv('LYRA_COMPOSER_PACKAGE')) . $flags, $code);
checkComposerExit($code);
$lock = json_decode(file_get_contents('/app/composer.lock'), true, 512, JSON_THROW_ON_ERROR);
// Preserve unchanged package records, including metadata Composer omits when serializing.
// Keep the solver's package set and versions so semantic validation still rejects wider updates.
foreach (['packages', 'packages-dev'] as $section) {
  $originalPackages = [];
  foreach ($originalLock->{$section} ?? [] as $package) $originalPackages[$package->name] = $package;
  foreach ($lock[$section] ?? [] as $index => $package) {
    $previous = $originalPackages[$package['name']] ?? null;
    if ($package['name'] !== getenv('LYRA_COMPOSER_PACKAGE') && $previous !== null
        && ltrim($previous->version, 'v') === ltrim($package['version'], 'v')) {
      $lock[$section][$index] = $previous;
    }
  }
}
$resolved = $lock;
$lock = $originalLock;
foreach (['packages', 'packages-dev'] as $key) {
  if (array_key_exists($key, $resolved)) $lock->{$key} = $resolved[$key];
}
$lock->{'content-hash'} = getenv('LYRA_COMPOSER_CONTENT_HASH');
$encoded = json_encode($lock, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
if (preg_match('/\\r?\\n([ \\t]+)"/', $originalLockBytes, $indent) && strlen($indent[1]) <= 10) {
  $encoded = preg_replace_callback('/^ +/m', fn($match) => str_repeat($indent[1], intdiv(strlen($match[0]), 4)), $encoded);
}
if (str_contains($originalLockBytes, "\\r\\n")) $encoded = str_replace("\\n", "\\r\\n", $encoded);
$ending = str_ends_with($originalLockBytes, "\\r\\n") ? "\\r\\n" : (str_ends_with($originalLockBytes, "\\n") ? "\\n" : '');
file_put_contents('/app/composer.lock', $encoded . $ending);
file_put_contents('/app/composer.json', $original);
passthru('composer --no-scripts --no-plugins validate --no-check-publish --check-lock', $code);
checkComposerExit($code);
passthru('composer install --dry-run --no-scripts --no-plugins --no-interaction --no-progress', $code);
checkComposerExit($code);
`

async function fixedPackage(
  name: string,
  version: string,
  options: { signal?: AbortSignal; fetchFn?: typeof fetch; resolver?: HostResolver }
): Promise<Record<string, unknown>> {
  const url = `https://repo.packagist.org/p2/${name}.json`
  const result = await safeFetchDetailed(url, {
    ...options,
    maxRedirects: 0,
    timeoutMs: 15_000,
    maxBytes: 5 * 1024 * 1024,
    accept: "application/json",
  })
  if (
    !result.ok ||
    result.result.status !== 200 ||
    result.result.bodyTruncated ||
    result.result.finalUrl !== url
  )
    throw new Error("Trusted Composer metadata is unavailable or incomplete")
  const schema = z.object({
    minified: z.literal("composer/2.0").optional(),
    packages: z.record(z.string(), z.array(PackageSchema).max(10_000)),
  })
  const data = schema.parse(JSON.parse(result.result.html))
  let previous: Record<string, unknown> = {}
  for (const entry of data.packages[name] ?? []) {
    const expanded = data.minified ? { ...previous, ...entry } : { ...entry }
    for (const key of Object.keys(expanded)) if (expanded[key] === "__unset") delete expanded[key]
    previous = expanded
    if (
      expanded.name === name &&
      typeof expanded.version === "string" &&
      expanded.version.replace(/^v/, "") === version.replace(/^v/, "")
    ) {
      return { ...expanded, version }
    }
  }
  throw new ComposerFixUnavailableError(
    "The fixed Composer package release is absent from trusted metadata"
  )
}

export async function regenerateComposerLock(
  input: z.input<typeof RequestSchema> & {
    signal?: AbortSignal
    fetchFn?: typeof fetch
    resolver?: HostResolver
  }
) {
  const request = RequestSchema.parse(input)
  input.signal?.throwIfAborted()
  for (const value of [request.originalManifest, request.originalLock])
    if (Buffer.byteLength(value) > COMPOSER_FIX_MAX_BYTES)
      throw new Error("Composer input exceeds byte limit")
  const manifest = parseComposerManifest(request.originalManifest)
  if (manifest.repositories !== undefined)
    throw new ComposerFixUnavailableError(
      "Custom Composer repositories require a manual dependency update"
    )
  const config = manifest.config as Record<string, unknown> | undefined
  if (config && (config["disable-tls"] === true || config["secure-http"] === false))
    throw new ComposerFixUnavailableError(
      "Insecure Composer transport configuration is unsupported"
    )
  const unresolved: Array<{ ecosystem: string; name: string; reason: string }> = []
  const inventory = parseComposerLock(request.originalLock, "composer.lock", unresolved)
  if (unresolved.length || inventory.contentHash !== composerContentHash(manifest))
    throw new ComposerFixUnavailableError("Composer lock is stale or has an invalid content hash")
  const pkg = inventory.packages.filter((x) => x.name === request.packageName)
  if (pkg.length !== 1 || pkg[0]?.version !== request.fromVersion.replace(/^v/, ""))
    throw new ComposerFixUnavailableError(
      "Composer affected package does not match the stored release"
    )
  const lock = LockSchema.parse(JSON.parse(request.originalLock))
  const replacement = await fixedPackage(request.packageName, request.toVersion, input)
  const packages = [...lock.packages, ...lock["packages-dev"]].map((x) =>
    x.name === request.packageName ? replacement : x
  )
  const root = await mkdtemp(join(tmpdir(), "lyrashield-composer-"))
  const name = `lyrashield-composer-${randomUUID()}`
  try {
    if (/[,\r\n]/.test(root)) throw new Error("Unsupported Composer sandbox path")
    await Promise.all([
      writeFile(join(root, "composer.original.json"), request.originalManifest, { mode: 0o600 }),
      writeFile(join(root, "composer.lock"), request.originalLock, { mode: 0o600 }),
      writeFile(join(root, "repository.json"), JSON.stringify(packages), { mode: 0o600 }),
      writeFile(join(root, "resolve.php"), RESOLVE_SCRIPT, { mode: 0o600 }),
    ])
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--memory",
      "256m",
      "--cpus",
      "1",
      "--pids-limit",
      "64",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "-e",
      "COMPOSER_DISABLE_NETWORK=1",
      "-e",
      "COMPOSER_HOME=/tmp/composer",
      "-e",
      "COMPOSER_ROOT_VERSION=1.0.0",
      "-e",
      `LYRA_COMPOSER_PACKAGE=${request.packageName}`,
      "-e",
      `LYRA_COMPOSER_CONTENT_HASH=${composerContentHash(manifest)}`,
      "--mount",
      `type=bind,source=${root},target=/app`,
      "-w",
      "/app",
      "--entrypoint",
      "php",
      COMPOSER_RESOLVER_IMAGE,
      "/app/resolve.php",
    ]
    try {
      await runDocker("docker", args, {
        signal: input.signal,
        timeout: 90_000,
        maxBuffer: 128 * 1024,
      })
    } catch (error) {
      input.signal?.throwIfAborted()
      const failure = error as { code?: unknown; killed?: boolean; signal?: unknown }
      if (failure.code === COMPOSER_CONSTRAINT_EXIT_CODE && !failure.killed && !failure.signal)
        throw new ComposerFixUnavailableError(
          "Composer cannot resolve this isolated update under the current constraints and platform. Update manually if new dependencies, platform changes or wider constraints are required."
        )
      throw new Error(
        "Isolated Composer resolver infrastructure failed; retry the dependency update"
      )
    }
    const output = join(root, "composer.lock")
    const stat = await lstat(output)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > COMPOSER_FIX_MAX_BYTES)
      throw new Error("Invalid Composer resolver output")
    return {
      after: await readFile(output, "utf8"),
      resolverImage: COMPOSER_RESOLVER_IMAGE,
      checks: {
        network: "none" as const,
        scripts: false as const,
        plugins: false as const,
        install: false as const,
        lockValidated: true as const,
      },
      compatibility: "customer-tests-required" as const,
    }
  } finally {
    await runDocker("docker", ["rm", "-f", name], { timeout: 10_000, maxBuffer: 1024 }).catch(
      () => undefined
    )
    await rm(root, { recursive: true, force: true })
  }
}
