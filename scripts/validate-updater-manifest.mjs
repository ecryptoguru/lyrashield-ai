#!/usr/bin/env node
/**
 * Validate Tauri updater manifest (latest.json) fail-closed.
 *
 * Schema:
 *  {
 *    version: semver,
 *    notes: string,
 *    pub_date: ISO8601,
 *    platforms: {
 *      darwin-aarch64: { signature: string, url: string },
 *      darwin-x86_64:  { signature: string, url: string },
 *      windows-x86_64: { signature: string, url: string }
 *    }
 *  }
 *
 * Guards:
 * - fails on missing/empty signature or url
 * - fails on private key material leakage
 * - fails on version mismatch (expectedVersion vs manifest vs tauri.conf)
 * - fails on malformed JSON / missing keys
 *
 * Usage:
 *   node scripts/validate-updater-manifest.mjs latest.json --expected-version 0.1.0 [--tauri-conf apps/desktop/src-tauri/tauri.conf.json]
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REQUIRED_PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"];
const HTTPS_URL_RE = /^https:\/\/.+/;

export function validateUpdaterManifest(manifest, opts = {}) {
  const errors = [];
  const { expectedVersion, tauriConfVersion } = opts;

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be a non-null object");
  }

  // Private key guard — fail closed if manifest somehow contains key material
  const raw = JSON.stringify(manifest);
  if (/PRIVATE/i.test(raw) || /BEGIN.*PRIVATE/.test(raw)) {
    errors.push("manifest contains private key material");
  }

  // version
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    errors.push("version: required non-empty string");
  } else if (!SEMVER_RE.test(manifest.version.trim())) {
    errors.push(`version: must be semver, got "${manifest.version}"`);
  } else if (expectedVersion && manifest.version.trim() !== expectedVersion.trim()) {
    errors.push(`version: manifest version "${manifest.version}" != expected "${expectedVersion}"`);
  }

  if (tauriConfVersion && manifest.version && manifest.version.trim() !== tauriConfVersion.trim()) {
    errors.push(`version: manifest "${manifest.version}" != tauri.conf "${tauriConfVersion}"`);
  }

  // notes
  if (typeof manifest.notes !== "string" || manifest.notes.trim() === "") {
    errors.push("notes: required non-empty string");
  }

  // pub_date
  if (typeof manifest.pub_date !== "string" || manifest.pub_date.trim() === "") {
    errors.push("pub_date: required non-empty ISO8601 string");
  } else if (Number.isNaN(Date.parse(manifest.pub_date))) {
    errors.push(`pub_date: invalid date "${manifest.pub_date}"`);
  }

  // platforms
  if (!manifest.platforms || typeof manifest.platforms !== "object" || Array.isArray(manifest.platforms)) {
    errors.push("platforms: required object");
  } else {
    for (const platform of REQUIRED_PLATFORMS) {
      const entry = manifest.platforms[platform];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`platforms.${platform}: required object with signature and url`);
        continue;
      }
      const sig = entry.signature;
      const url = entry.url;
      if (typeof sig !== "string" || sig.trim() === "") {
        errors.push(`platforms.${platform}.signature: required non-empty string`);
      } else if (sig.trim().length < 10) {
        errors.push(`platforms.${platform}.signature: too short`);
      }
      if (typeof url !== "string" || url.trim() === "") {
        errors.push(`platforms.${platform}.url: required non-empty string`);
      } else if (!HTTPS_URL_RE.test(url.trim())) {
        errors.push(`platforms.${platform}.url: must be https URL, got "${url}"`);
      } else {
        if (expectedVersion && !url.includes(expectedVersion)) {
          errors.push(`platforms.${platform}.url: must contain version "${expectedVersion}", got "${url}"`);
        }
        if (/\s/.test(url)) errors.push(`platforms.${platform}.url: must not contain whitespace`);
      }
    }
    // No extra platforms with empty values allowed? Allow but validate any present
    for (const [k, v] of Object.entries(manifest.platforms)) {
      if (!REQUIRED_PLATFORMS.includes(k)) {
        // still validate shape if present
        if (!v || typeof v !== "object" || typeof v.signature !== "string" || v.signature.trim() === "" || typeof v.url !== "string" || v.url.trim() === "") {
          errors.push(`platforms.${k}: unexpected platform entry must have non-empty signature and url`);
        }
      }
    }
  }

  if (errors.length) {
    const msg = errors.map((e) => ` - ${e}`).join("\n");
    throw new Error(`Updater manifest validation failed:\n${msg}`);
  }
}

async function readJsonFile(p) {
  const txt = await readFile(p, "utf8");
  return JSON.parse(txt);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: node scripts/validate-updater-manifest.mjs <manifest.json> [--expected-version X.Y.Z] [--tauri-conf path]`);
    process.exit(args.length === 0 ? 1 : 0);
  }
  const manifestPath = args[0];
  let expectedVersion = null;
  let tauriConfPath = "apps/desktop/src-tauri/tauri.conf.json";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--expected-version" && args[i + 1]) {
      expectedVersion = args[i + 1];
      i++;
    } else if (args[i].startsWith("--expected-version=")) {
      expectedVersion = args[i].split("=")[1];
    } else if (args[i] === "--tauri-conf" && args[i + 1]) {
      tauriConfPath = args[i + 1];
      i++;
    } else if (args[i].startsWith("--tauri-conf=")) {
      tauriConfPath = args[i].split("=")[1];
    }
  }
  // Also allow env var
  if (!expectedVersion && process.env.EXPECTED_VERSION) expectedVersion = process.env.EXPECTED_VERSION;

  let manifest;
  try {
    manifest = await readJsonFile(manifestPath);
  } catch (e) {
    console.error(`::error::Failed to read/parse manifest ${manifestPath}: ${e.message}`);
    process.exit(1);
  }

  let tauriConfVersion = null;
  try {
    const conf = await readJsonFile(tauriConfPath);
    if (conf && typeof conf.version === "string") tauriConfVersion = conf.version.trim();
  } catch {
    // if file missing, skip tauri.conf check — workflow will handle separately
  }

  // If expectedVersion not supplied, try to infer from tauri.conf for local runs
  if (!expectedVersion && tauriConfVersion) {
    // don't auto-infer in CI — require explicit; but allow fallback for dev
  }

  try {
    validateUpdaterManifest(manifest, { expectedVersion, tauriConfVersion: tauriConfVersion && expectedVersion ? tauriConfVersion : null });
    // Additional cross-check: tauri.conf version must equal expectedVersion when both present
    if (expectedVersion && tauriConfVersion && tauriConfVersion !== expectedVersion) {
      throw new Error(`Updater manifest validation failed:\n - tauri.conf version "${tauriConfVersion}" != expected "${expectedVersion}" (tag/version drift)`);
    }
    console.log(`✓ updater manifest valid: ${manifestPath} version=${manifest.version} platforms=${Object.keys(manifest.platforms || {}).join(",")}`);
  } catch (e) {
    console.error(e.message);
    // GitHub Actions annotation
    console.error(`::error::${e.message.split("\n")[0]}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
// Always run main if invoked directly; export for tests otherwise
if (isMain || process.argv[1]?.includes("validate-updater-manifest")) {
  // Detect vitest import — avoid auto-run when imported as module in tests
  if (process.env.VITEST !== "true" && !process.env.VITEST_WORKER_ID) {
    await main();
  }
}
