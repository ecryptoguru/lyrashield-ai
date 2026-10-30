import { execFile } from "node:child_process"
import { createRequire } from "node:module"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { analyzePhpSource } from "./php-source"
import { PhpWork, PhpWorkLimit } from "./php-source-work"
import { inspectPhpRuntimeInput } from "./php-runtime"
import { buildOperationUrl } from "./openapi-scanner-support"
import type { ScannerCoverageIssue } from "../scanner-coverage"

const execute = promisify(execFile)
const loader = createRequire(new URL("../../../package.json", import.meta.url)).resolve("tsx")
const scanner = (name: string) => new URL(`./${name}.ts`, import.meta.url).href

// Run hostile inputs out of process: a blocked event loop cannot enforce a Vitest timer.
async function isolated(body: string) {
  const result = await execute(
    process.execPath,
    ["--import", loader, "--input-type=module", "-e", body],
    {
      cwd: process.cwd(),
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    }
  )
  return JSON.parse(result.stdout.trim())
}

describe("scanner CPU safety", () => {
  it("bounds Docker directive whitespace without dropping long valid instructions", async () => {
    const result = await isolated(`
      import { inspectPhpRuntimeInput } from ${JSON.stringify(scanner("php-runtime"))};
      const result = inspectPhpRuntimeInput('Dockerfile', '#syntax=a' + ' '.repeat(120000) + 'x\\nFROM php:8.4.26-fpm', 'dockerfile', []);
      console.log(JSON.stringify(result));
    `)
    expect(result.phpPresent).toBe(true)
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it("bounds Gradle whitespace assignments and retains resolved dependency semantics", async () => {
    const result = await isolated(`
      import { mkdtemp, writeFile, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { collectScaDependencies } from ${JSON.stringify(scanner("dependency-manifests"))};
      const dir = await mkdtemp(join(tmpdir(), 'gradle-cpu-'));
      try {
        await writeFile(join(dir, 'build.gradle'), ' '.repeat(120000) + '!\\n' + ' \\n'.repeat(15000) + '!\\nfinal String version =\\n"1.2.3"\\nimplementation "org.example:library:$version"');
        console.log(JSON.stringify(await collectScaDependencies({repoPath: dir})));
      } finally { await rm(dir, {recursive:true, force:true}); }
    `)
    expect(JSON.stringify(result)).toContain("1.2.3")
  })

  it("leaves oversized Gradle catalogs explicitly unresolved", async () => {
    const result = await isolated(`
      import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { collectScaDependencies } from ${JSON.stringify(scanner("dependency-manifests"))};
      const dir = await mkdtemp(join(tmpdir(), 'gradle-catalog-cpu-'));
      try {
        await mkdir(join(dir, 'gradle'));
        await writeFile(join(dir, 'build.gradle'), 'implementation(libs.demo.lib)');
        await writeFile(join(dir, 'gradle/libs.versions.toml'), '[versions]\\nv = "1.2.3"\\n[libraries]\\ndemo-lib = { module = "org.example:library", version.ref = "v" }\\n' + ' '.repeat(524288));
        const issues = [];
        const dependencies = await collectScaDependencies({repoPath: dir, coverageIssues: issues});
        console.log(JSON.stringify({dependencies, issues}));
      } finally { await rm(dir, {recursive:true, force:true}); }
    `)
    expect(result.dependencies).toEqual([])
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        scanner: "sca",
        status: "partial",
        reason: expect.stringContaining("could not be resolved"),
      })
    )
  })

  it("bounds unmatched OpenAPI braces and preserves parameter replacement", async () => {
    const result = await isolated(`
      import { buildOperationUrl } from ${JSON.stringify(scanner("openapi-scanner-support"))};
      const hostile = buildOperationUrl('https://example.com', '/' + '{'.repeat(120000), []);
      const valid = buildOperationUrl('https://example.com', '/items/{id}', [{name:'id', in:'path', example:'a b'}]);
      console.log(JSON.stringify({hostile: hostile.issues, valid}));
    `)
    expect(result.valid.url).toBe("https://example.com/items/a%20b")
    expect(result.hostile).toHaveLength(0)
  })

  it("retains prior findings and explicitly reports PHP statement work exhaustion", () => {
    const result = analyzePhpSource(
      '<?php system($_GET["first"]) .\n' +
        "system(".repeat(600) +
        '$_GET["x"]' +
        ")".repeat(600) +
        ";",
      "endpoint.php"
    )
    expect(result.findings.some((finding) => finding.code_locations?.[0]?.start_line === 1)).toBe(
      true
    )
    expect(result.issues.join(" ")).toContain("statement token visit limit (100000)")
  })

  it.each([
    ['simplexml_load_string("safe", ', ")"],
    ["curl_setopt($handle, ", ', "safe")'],
  ])("charges flag-absent argument traversals before returning: %s", async (opening, closing) => {
    const result = await isolated(`
      import { analyzePhpSource } from ${JSON.stringify(scanner("php-source"))};
      import { PhpWork } from ${JSON.stringify(scanner("php-source-work"))};
      let active = false, traversals = 0, maximum = 0;
      const token = value => value && typeof value.position === 'number' && typeof value.kind === 'string';
      const begin = PhpWork.prototype.beginStatement;
      PhpWork.prototype.beginStatement = function () {
        maximum = Math.max(maximum, traversals);
        traversals = 0; active = true;
        return begin.call(this);
      };
      for (const method of ['slice', 'flat']) {
        const original = Array.prototype[method];
        Array.prototype[method] = function (...args) {
          const result = original.apply(this, args);
          if (active) for (let i = 0; i < result.length; i++) if (token(result[i])) traversals++;
          return result;
        };
      }
      const some = Array.prototype.some;
      Array.prototype.some = function (callback, receiver) {
        return some.call(this, (value, index, array) => {
          if (active && token(value)) traversals++;
          return callback.call(receiver, value, index, array);
        });
      };
      const push = Array.prototype.push;
      Array.prototype.push = function (...values) {
        if (active) for (let i = 0; i < values.length; i++) if (token(values[i])) traversals++;
        return push.apply(this, values);
      };
      Array.prototype[Symbol.iterator] = function* () {
        for (let i = 0; i < this.length; i++) {
          const value = this[i];
          if (active && token(value)) traversals++;
          yield value;
        }
      };
      const source = '<?php ' + ${JSON.stringify(opening)}.repeat(200) + '"safe"' + ${JSON.stringify(closing)}.repeat(200) + ';';
      const result = analyzePhpSource(source, 'endpoint.php');
      maximum = Math.max(maximum, traversals);
      console.log(JSON.stringify({maximum, issues:result.issues}));
    `)
    // These observed array traversals are a lower bound on actual parser visits.
    expect(result.maximum).toBeLessThanOrEqual(100_000)
    expect(result.issues.join(" ")).toContain("statement token visit limit (100000)")
  })

  it("enforces exact statement and file token visit ceilings", () => {
    const work = new PhpWork()
    for (let i = 0; i < 10; i++) {
      work.beginStatement()
      work.visit(100_000)
      if (i < 9) expect(() => work.visit()).toThrow("statement token visit limit (100000)")
    }
    work.beginStatement()
    expect(() => work.visit()).toThrow("file token visit limit (1000000)")
    expect(() => work.visit()).toThrow(PhpWorkLimit)
  })

  it("retains findings when repeated hostile PHP statements exhaust file work", async () => {
    const result = await isolated(`
      import { analyzePhpSource } from ${JSON.stringify(scanner("php-source"))};
      const nested = 'system('.repeat(600) + '$_GET["x"]' + ')'.repeat(600) + ';\\n';
      const result = analyzePhpSource('<?php system($_GET["first"]);\\n' + nested.repeat(20), 'endpoint.php');
      console.log(JSON.stringify(result));
    `)
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.issues.join(" ")).toContain("file token visit limit (1000000)")
  })

  it("bounds direct runtime parsing before evaluating oversized source declarations", () => {
    const issues: ScannerCoverageIssue[] = []
    const result = inspectPhpRuntimeInput(
      "Dockerfile",
      "FROM php:8.4.26-fpm\n" + " ".repeat(524_288),
      "dockerfile",
      issues
    )
    expect(result.findings).toEqual([])
    expect(issues).toContainEqual(
      expect.objectContaining({
        status: "bounded",
        reason: expect.stringContaining("byte scanner limit"),
      })
    )
  })

  it.each(["{}", "{}tail}", "literal", "{{"])(
    "preserves literal/empty OpenAPI braces: %s",
    (path) => {
      expect(buildOperationUrl("https://example.com", "/" + path, []).issues).toEqual([])
    }
  )
  it.each(["{id}", "{}{id}", "{{}"])("retains unresolved OpenAPI placeholders: %s", (path) => {
    expect(buildOperationUrl("https://example.com", "/" + path, []).issues).toHaveLength(1)
  })

  it("yields to worker heartbeat timers during bounded PHP analysis", async () => {
    const result = await isolated(`
      import { analyzePhpSourceAsync } from ${JSON.stringify(scanner("php-source"))};
      let beats = 0;
      const timer = setInterval(() => beats++, 0);
      const result = await analyzePhpSourceAsync('<?php ' + '$x=$_GET["x"];'.repeat(2500) + 'system($x);', 'endpoint.php');
      clearInterval(timer);
      console.log(JSON.stringify({beats, findings:result.findings.length}));
    `)
    expect(result.beats).toBeGreaterThan(0)
    expect(result.findings).toBeGreaterThan(0)
  })
})
