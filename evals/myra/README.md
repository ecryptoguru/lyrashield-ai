# Myra public knowledge evaluation

`knowledge-v1.json` is the reviewed public support corpus and 60-question retrieval fixture. Each entry links to a public LyraShield route; do not add account data, internal procedures, unpublished prices, or restricted operator material here.

The PostgreSQL test at `packages/myra/src/server/kb.corpus.test.ts` seeds these entries under a temporary release, checks at least 90% expected-source top-five retrieval, and asserts that a restricted decoy never appears in anonymous results. Run it with the CI runtime-role database; without `RLS_RUNTIME_DATABASE_URL` the test skips. Import is dry-run-only by default through `packages/myra/scripts/import-knowledge.ts`; applying a release requires an explicit approver and a reviewed database target.

Keep lexical search unless the measured gate fails. If it fails, investigate missed questions first, then add role-filtered hybrid retrieval with the existing Azure `text-embedding-3-small` deployment and a full-text fallback.
