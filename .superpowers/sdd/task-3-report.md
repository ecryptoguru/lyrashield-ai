# Task 3 report: deterministic blog image pipeline

## Status

Complete within the assigned lane. The pipeline consumes the seven top-level array manifests, deduplicates their 100 assignments into 36 image definitions, derives five deterministic outputs per source, writes the typed image catalog, records source and derivative SHA-256 values, updates manifest source hashes, and emits a byte-budget report.

No files were staged or committed. TDD checkpoint commits were intentionally omitted because the parallel-lane brief explicitly prohibited staging and committing.

## TDD evidence and verification

- RED: `node --test apps/marketing-motion/tests/blog-image-lib.test.mjs` failed with `ERR_MODULE_NOT_FOUND` for the intentionally missing `blog-image-lib.mjs`.
- GREEN: focused Node test passes with 8 tests.
- Coverage: `node --test --experimental-test-coverage apps/marketing-motion/tests/blog-image-lib.test.mjs` passes with 100% lines, 94.74% branches, and 90.91% functions for `blog-image-lib.mjs`.
- Required gate: `node --test apps/marketing-motion/tests/blog-image-lib.test.mjs && pnpm --filter @lyrashield/marketing-motion blog:images:verify -- --allow-empty` passes and reports `Verified 0 catalog images (allow-empty).`
- Package lint: `pnpm --filter @lyrashield/marketing-motion lint` passes.
- Focused ESLint: all three scripts and the Node test pass with zero warnings.
- Syntax: `node --check` passes for all three scripts.
- Package contract: JSON parses, Sharp is exactly `0.34.5`, both requested scripts exist, and the shared lockfile was confirmed not to contain this lane's Sharp importer entry.
- Whitespace checks pass for all five assigned files.

## Files created or changed

- `apps/marketing-motion/scripts/blog-image-lib.mjs`
- `apps/marketing-motion/scripts/derive-blog-images.mjs`
- `apps/marketing-motion/scripts/verify-blog-images.mjs`
- `apps/marketing-motion/tests/blog-image-lib.test.mjs`
- `apps/marketing-motion/package.json`

## Root-owned integration changes still required

The lane did not retain changes to `.gitignore` or `pnpm-lock.yaml`, as requested.

Add these existing-rule-preserving lines to `.gitignore`:

```gitignore
apps/marketing-motion/renders/blog-masters/
apps/marketing-motion/renders/blog-image-previews/
```

Refresh `pnpm-lock.yaml` after the package change. Against the current dirty lockfile baseline, the required semantic delta is this entry under `importers.apps/marketing-motion.devDependencies`:

```yaml
sharp:
  specifier: 0.34.5
  version: 0.34.5
```

The Sharp package and platform snapshots already exist elsewhere in the current lockfile; only the marketing-motion importer binding was absent after this lane restored its transient package-runner change.

## Implementation notes and concerns

- Derivatives use center cover crops with `withoutEnlargement: true`; source validation requires square PNG input at least 2048 by 2048.
- Encoding starts at AVIF 58/effort 7, WebP 76/effort 6, and progressive JPEG 80 with 4:2:0 chroma subsampling. Quality falls in two-point steps only to the specified minima before failing the whole preparation phase.
- Budgets are enforced as decimal KB: 220,000 bytes for hero AVIF, 320,000 for hero WebP/JPEG, and 350,000 for each social JPEG.
- All 180 buffers are prepared and budget-checked before catalog, manifest, report, or public asset writes begin. Filesystem write failure can still leave a partially written output set, but an encoding/budget failure cannot.
- Sharp strips metadata by default because no metadata-retention method is called; verification rejects EXIF, ICC, IPTC, or XMP payloads.
- The verifier checks ignored source masters when present, but remains CI-compatible after masters are omitted by validating the recorded manifest hashes and all committed derivatives.
- Full 36-source derivation was not run because Task 5 has not created the ignored source masters. This is the expected boundary for Task 3; the allow-empty verifier is the specified pre-creation gate.

## Hardening follow-up

Status: complete on 2026-07-17.

Review findings were addressed without changing the public `images.json` catalog shape:

- `sourceHash` remains canonical as `sha256:<64 lowercase hexadecimal characters>`.
- Production defaults require exactly `authority.json` and `batch-1.json` through `batch-6.json`, with exact release entry counts `1/17/17/17/16/16/16`, top-level arrays, 36 unique definitions, and every declared `usageCount` equal to its aggregate assignment count.
- Added committed `apps/marketing/src/content/blog-images/image-verification.json`. Derivation records source and derivative hashes, sizes, paths, qualities, dimensions, formats, and budgets deterministically. CI verification works without ignored masters; when masters exist, every derivative is re-encoded at its recorded quality and must be byte-identical.
- Verification rejects catalog, manifest, verification-record, derivative, and managed-directory mutations, including stale public image directories and unexpected per-image files.
- Derivation prepares and budget-checks all buffers before output mutation, stages the complete managed public library and swaps it by rename with rollback, and writes catalog, verification, manifest, and report JSON through same-directory temporary files and atomic renames.
- `--allow-empty` still validates the canonical manifest filenames, top-level shapes, exact release counts, 36 definitions, and aggregate usage declarations before accepting zero catalog images.

Hardening verification:

- RED: the new integration suite initially failed because `BLOG_IMAGE_MANIFEST_CONTRACT` was not exported.
- GREEN: 12 focused Node tests pass, including real Sharp derivation from a temporary 2048x2048 source, center-crop sampling, stripped metadata, progressive 4:2:0 JPEG metadata, exact AVIF/WebP/JPEG options, minimum-quality budget failure, failed-derive output preservation, deterministic reruns, catalog and manifest mutation, CI verification without masters, derivative tampering, and stale output detection.
- Coverage: 89.80% lines, 80.50% branches, and 86.21% functions across the three pipeline modules.
- The repository `blog:images:verify -- --allow-empty`, marketing-motion lint, Prettier check, and focused `git diff --check` pass.

Scope note: `.gitignore` and `pnpm-lock.yaml` already contained the original Task 3 integration in ancestor commit `e8b4e63`, together with broader preexisting premium marketing-motion workspace entries. This hardening follow-up did not modify or restage either file and does not claim the broader premium scope as new work.

## Transactional verification follow-up

Status: complete on 2026-07-17 in commit `f890795` (`fix(marketing): make blog image persistence transactional`).

- The verifier now reruns each source through the complete canonical quality-selection sequence and separately requires the selected quality and derivative hash to match. A verification record plus derivative regenerated at a different otherwise-allowed quality no longer passes by trusting the record.
- Top-level verification `imageCount` must equal the catalog count and `outputCount` must equal five times the catalog count, including the allow-empty state.
- Derivation stages the complete replacement library, catalog, verification manifest, every editorial manifest, and byte-budget report before entering a single persistence transaction. Any commit failure restores all prior targets; rollback backups are retained if rollback itself is incomplete.
- The injected-failure regression changes the source, fails during verification metadata persistence after earlier swaps, and byte-compares the restored library, catalog, verification manifest, editorial manifest, and report against their complete prior snapshots.

Verification evidence:

- RED: count-tamper cases and the induced metadata-write failure initially reported missing expected rejections; the pre-fix verifier also accepted the self-consistent noncanonical quality record and derivative.
- GREEN: 13 focused Node tests pass.
- Coverage: 89.35% lines, 82.48% branches, and 87.50% functions across the three pipeline modules.
- Repository allow-empty verification reports `Verified 0 catalog images (allow-empty).`
- Marketing-motion ESLint, exact-file Prettier check, and focused `git diff --check` pass.

## Final P1 verification-contract remediation

Status: complete on 2026-07-17.

- Present ignored masters now pass the same source inspection used by derivation: decoded format must be PNG, dimensions must be square, and both axes must be at least 2048 pixels.
- Masterless verification now rejects each JPEG output unless Sharp reports a progressive JPEG with `4:2:0` chroma subsampling.
- Verification records must contain exactly `avif`, `webp`, `jpeg`, `og`, and `socialPortrait`. Derivation rejects noncanonical output overrides, persisted counts increment from records actually written, and verifier results increment only after each derivative passes every check.
- Transactional persistence, ignored-master behavior, canonical catalog paths, and deterministic re-encoding remain unchanged.

Exact commands and results:

- RED: `node --test apps/marketing-motion/tests/blog-image-lib.test.mjs apps/marketing-motion/tests/blog-image-pipeline.test.mjs` -> **failed as expected, 13/16 passed and 3/16 failed**. The verifier reached derivative mismatch instead of rejecting a non-square master, accepted a self-consistent baseline `4:4:4` JPEG without masters, and accepted a stale sixth verification output key.
- GREEN: `node --test apps/marketing-motion/tests/blog-image-lib.test.mjs apps/marketing-motion/tests/blog-image-pipeline.test.mjs` -> **passed, 16/16 tests**.
- `pnpm --filter @lyrashield/marketing-motion lint` -> **passed**, ESLint exited 0 with zero warnings.
- `pnpm exec prettier --check apps/marketing-motion/scripts/derive-blog-images.mjs apps/marketing-motion/scripts/verify-blog-images.mjs apps/marketing-motion/tests/blog-image-lib.test.mjs apps/marketing-motion/tests/blog-image-pipeline.test.mjs .superpowers/sdd/task-3-report.md` -> **passed**, all matched files use Prettier code style.
- `git diff --check -- apps/marketing-motion/scripts/derive-blog-images.mjs apps/marketing-motion/scripts/verify-blog-images.mjs apps/marketing-motion/tests/blog-image-lib.test.mjs apps/marketing-motion/tests/blog-image-pipeline.test.mjs .superpowers/sdd/task-3-report.md` -> **passed** with no output.
- `pnpm --filter @lyrashield/marketing-motion blog:images:verify -- --allow-empty` -> **passed**, reporting `Verified 0 catalog images (allow-empty).`
