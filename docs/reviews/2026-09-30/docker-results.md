# Local Docker acceptance — 30 September 2026

This receipt covers the local Docker test stack for the approved cross-repository fixes. The final product code is `58cc2e46ec6c60f46f2d7ed9a8059205394aae88`; the engine is `c0cf936b4c3ee6f8f331681802645cc044d60911`. Production deployment, registry publication, paid provider execution, payments and signed Desktop release are separate gates.

## Scope and isolation

The official root `Dockerfile` supplies the web runner, worker and authenticated egress proxy. The official engine `containers/Dockerfile` supplies the sandbox. PostgreSQL 16.15 and Redis 7.4.11 use dedicated containers, database roles and networks. A second instance of the web runner represents the scanner deployment, following the actual deployment architecture; no `SCANNER_ONLY` or scanner credential switch exists in this source.

The review Compose file is [docker-test.compose.yml](./docker-test.compose.yml). Credentials in it are public synthetic fixtures. No production environment file, account cookie, provider credential or cloud-storage credential was loaded. Billing admission is disabled. The worker has an invalid model fixture directed at loopback discard port 9; actual scans use the deterministic SAFE profile only. The only admitted public target is the user-owned canonical marketing site, `https://lyrashieldai.com/`, with explicit authorization for bounded passive reads.

The runtime database role is neither superuser nor BYPASSRLS. [docker-runtime-grants.sql](./docker-runtime-grants.sql) mirrors CI's grants, including `app` schema usage and the deletion-task functions, while excluding platform-administration and billing-reconciliation state tables. The owner role is used for migration and exceptional system operations. Readback confirms the runtime restrictions.

| Surface                            | Local endpoint           | Result                                                                    |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Web/API                            | `http://localhost:33009` | Final image: health, auth and deterministic terminal passed               |
| Marketing generated Worker preview | `http://localhost:33010` | Pages, local D1 migration and idempotent signup passed                    |
| Scanner instance                   | `http://localhost:33011` | Health, readiness, origin/bot/SSRF denials and passive Lite result passed |
| Fault-injection web variant        | `http://localhost:33012` | Final lost-ack and absent-job lifecycle receipts passed                   |
| Authenticated egress proxy         | `http://localhost:34009` | Scoped HTTPS positive and negative boundaries passed                      |
| Redis fault receipt                | `http://localhost:39013` | Optional fault profile only; stopped after probes                         |
| PostgreSQL                         | `127.0.0.1:55439`        | Dedicated `ls_hardening` database                                         |
| Redis                              | `127.0.0.1:56389`        | Dedicated fixture instance                                                |

The worker uses a unique host-visible temporary directory with restrictive permissions, a dedicated evidence volume and a dedicated internal sandbox network. No shared temporary directory was recursively chowned. The three BullMQ consumers remain present. The worker is deliberately in development mode because local filesystem evidence storage is prohibited in production. This local readiness receipt does not establish cloud storage, authenticated model access or production admission.

## Final image identity

Product images are built from a clean `git archive` of the product code SHA above. The worker's engine context and sandbox image are built from a clean engine archive. Product images carry `org.opencontainers.image.revision`; the worker also carries `io.lyrashield.engine.revision`. Later receipt and test-fixture commits do not change the application or engine code attributed to these images.

Docker Desktop's image store returns an OCI index as `docker image inspect .Id` for these final builds. The exported platform manifest and config digests are distinct values. The config digest is not a registry image identity. Local OCI receipts do not establish a pushed registry digest, signature or deployment.

| Image                   | Local inspect ID / OCI index                                              | Bytes         |
| ----------------------- | ------------------------------------------------------------------------- | ------------- |
| Final web               | `sha256:982f55ab2d13ee4d2a73c9d5ecac5d278899b0a04d98c1f784fcaf7411ef9a63` | 420,700,630   |
| Final worker            | `sha256:be2da839fe10675f71e9fffe3aaa301ee28d62b069254ce4e5a31e47b6751eff` | 1,038,361,257 |
| Final egress proxy      | `sha256:b3580053d4620935e78f1a8d9fcd27f81554a2251a85751d7580d2d63fc2168e` | 275,739,685   |
| Final sandbox           | `sha256:ffb8285994a69e02be793873031b6c9da60737c84a0405af5baa57f3dcac650d` | 6,070,174,215 |
| Marketing local preview | `sha256:6161b7e17bae215783307ee5346ea8ee15681208e880f323ff84986c4ceab7e5` | 942,336,507   |
| Packed local clients    | `sha256:c4b071628abfb61050b719a0fe9fe3061c5390f7b48b2ee4fd59f92e8cf1562d` | 378,435,707   |

Product platform/config receipts:

| Target       | Platform manifest                                                         | Config digest                                                             |
| ------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| web          | `sha256:43eaf8968d13fbd7feb87aebc0842a2b95919f4c516778ffd31991ac35e9e7de` | `sha256:e53a6251a9ddcc48053d307107f09eaef967fd0fa74f591eef51a20cbaa733ca` |
| worker       | `sha256:b4d7e62de619a434207fc2e9dee9e12b10da3ad13a30a41c2cadcf4deef77fb5` | `sha256:9f0e28273ae7ee47829146dd3b9153c6f87e7193b358318fee5a9b2eb6ea6199` |
| egress-proxy | `sha256:36b8e1d152bdba1f0661525b9d134d0b00a95c279b18aa2f80bcc75677e190f0` | `sha256:bcdea4dc43afdffe79a2b3b7cdbfcc95a3e34c34075636bb3d77f1883bcc026b` |

The sandbox platform manifest is `sha256:14ac993df15ae6c67a3e18a358864e8b7ce370ebf8910d668e0ec299d7a1a7d4`; its config digest is `sha256:545575cc92cd36147afc386b685eb3dd70fb03715b740e0d9137c89a3572ea03`. The metadata helper checksum matches the clean source, and `pip check` reports no broken requirements.

## Runtime acceptance

| Final HTTP fixture                          | Terminal state          | Durable accounting                                                                                      |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Ordinary SAFE admission and same-key replay | COMPLETED               | One scan, one operation, zero agent-minute records/quantity                                             |
| Lost successful Redis acknowledgement       | COMPLETED               | One scan, one operation, one completed event; job attemptsMade 1 after worker restart; zero consumption |
| Add effect absent with uncertain admission  | FAILED / QUEUE_ORPHANED | One scan, one operation, job absent, same ID after terminal replay; zero consumption                    |

The final runner reports Next 16.3.6; the final egress runtime reports Undici 8.10.2. All three official product targets completed their clean archive builds; the web build includes optimized compilation, TypeScript and static generation.

The authenticated HTTP harness uses the actual API for signup, session readback, signout, signin, workspace creation, dashboard access and admission. Unauthenticated dashboard access redirects to signin. Private-address target creation fails with `400 / SSRF_BLOCKED` before a scan is created. A bounded SAFE scan of the owned marketing site returns 201, repeats as 200 with the same idempotency key and reaches COMPLETED. The database retains one scan and one operation, with zero agent-minute consumption and no provider usage. Stored manifest checksum input is present. The coverage receipt retains blocked and not-applicable categories; a successful terminal state does not imply comprehensive security coverage.

[docker-redis-ack-drop.mjs](./docker-redis-ack-drop.mjs) injects transport faults only between the optional web variant and the isolated Redis instance. The worker connects directly to Redis. In lost-ack mode, the proxy forwards the add command and drops its successful reply; NOSCRIPT replies are forwarded so Lua can execute. The actual HTTP request retains the admitted ID, same-key replay retains that ID, and the worker completes the single job. After worker restart, normal BullMQ Queue APIs report attemptsMade 1 and no waiting, active or delayed duplicate. Database readback records one completed event, one operation and zero agent-minute consumption.

In absent mode, the proxy closes the producer before forwarding the complete add command. The request retains its existing QUEUED scan ID despite uncertainty, and there is no queue job. Only that exact disposable scan's `createdAt` and `updatedAt` are backdated beyond the source's five-minute grace period. Normal unconditional worker startup reconciliation changes it to `FAILED / QUEUE / QUEUE_ORPHANED`. It does not autoenqueue or invoke a provider. Authenticated same-key replay retains the same failed ID, with one scan, one operation and zero consumption. No BullMQ key is deleted.

All six public scorecard PNG combinations passed actual HTTP checks: grade/fixes at 1200×630, 1080×1080 and 1080×1350. PNG signatures, dimensions, content type and `no-store` are checked. Wide-grade and signed Lite images were visually inspected without clipping. The signed Lite mint returns 201; its image returns 200 at 1200×630; tampered and wrong-key signatures return 404. The same published image/page return 404 after expiration. The fixture is cleaned and reseeded; a fresh same-URL image returns 200 before revocation, then both image/page return 404 after revocation. This establishes a fresh database read rather than carrying a cached positive response.

The scanner fixture uses Cloudflare's documented public Turnstile test secret/token, never a production secret. It passed health/readiness, an untrusted-origin denial, missing bot-check denial, private-address denial and a passive Lite result for the owned marketing site. The [Cloudflare testing documentation](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) defines these public fixtures.

The egress proxy passed authenticated scoped HTTPS GET, unauthorized administration rejection, host/path/method denial, revocation denial and private-address SSRF rejection. An opaque CONNECT attempt was rejected. These are bounded local policy probes, not a paid scan or production firewall receipt.

The exact sandbox passed the official smoke script: real RS256 accepted; forged and expired tokens rejected; JWKS redirects rejected; real Semgrep CLI finding produced. Its default entrypoint also passed nine composed relay checks: trusted HTTPS curl, untrusted CA rejection, HEAD length, 204 framing, 304 framing, connection-header stripping, scoped method/path rejection and trusted/scoped Chromium behavior. TLS verification remained enabled. Chromium used `--no-sandbox` only inside the test container.

An ephemeral worker with `NODE_ENV=production` and missing attribution exits 1 before readiness at the production provenance guard. A synthetic HTTPS proxy URL is used only to pass environment parsing; the guard fails before requests or job claims. Positive production startup would additionally require valid managed evidence storage and the production sandbox/provider contract, which were not supplied.

Final desktop and mobile signin screenshots were captured from the final running image after waiting for the actual email input; the form is readable without horizontal overflow.

## Marketing and public clients

[Dockerfile.marketing-test](./Dockerfile.marketing-test) runs Wrangler 4.125.0 on Debian Node 24. It consumes the generated `apps/marketing/dist/server/wrangler.json`, migrates only local D1 bindings, and serves the existing local-preview artifact. It does not deploy the source Wrangler configuration or contact a remote database. A synthetic waitlist salt is injected. Pages, methodology, pricing, robots and llms routes return 200. Canonical-origin fixture requests return 403 for an untrusted origin, 400 for invalid input and two identical 201 signup responses with the same referral code; local D1 readback confirms one row. This is an API/local-binding receipt, not full browser form or production deployment proof. Public links retain the repository's canonical-origin policy and were not followed into production.

[Dockerfile.client-test](./Dockerfile.client-test) installs locally packed canonical CLI, MCP and plugin artifacts. [docker-client-probe.mjs](./docker-client-probe.mjs) runs with `--network none`, without host credentials. CLI 0.2.13 version/help and actual MCP stdio initialize/tools/list passed; protocol 2025-11-25 negotiated and 21 tools were listed. This does not prove authenticated public clients, marketplace publication or a signed native Desktop release.

The root also inspected the actual Docker sign-in page in the in-app browser; the desktop form rendered correctly and the captured browser error log was empty. Changed scan-list mobile and accessibility behaviors have separate rendered Chromium regression coverage.

## Measured local Redis window

With the fault profile stopped and no HTTP scan workload, a 45-second local window recorded 1,842→1,869 commands (+27), 12→12 connected clients, 3→3 blocked clients, 79→85 total connections, 2,637,992→2,556,648 bytes used memory and zero evictions. INFO probes, container health checks and local schedulers are included. This short fixture window is not a production quota/capacity estimate or an optimization baseline comparison. Controlled lifecycle/cost measurements belong to the separate measurement receipt.

## Failures and recovery

The initial 64 GiB Docker VM filled during builds. PostgreSQL emitted `could not write init file` and later failed a checkpoint/recovery with ENOSPC; affected database tests were rerun. Only reclaimable build cache was pruned. No unrelated images, containers or volumes were deleted. With all database tests idle, Docker Desktop was stopped and only its disk capacity changed from 64 to 96 GiB, then services and grants were restored. Existing data and settings were preserved.

An early app image captured an incomplete concurrent webhook/queue interface and failed typechecking; later complete builds passed. Missing synthetic salts and an unused relay-signing setting were corrected in the test configuration. A production marketing artifact's HTTPS middleware requires the existing local-preview build for Wrangler emulation. Custom localhost-site overrides conflicted with the preview origin checks; the standard preview configuration was restored. A temporary Wrangler/workerd `Network connection lost` exit during concurrent builds was retained in the logs and followed by a successful restored preview/API retest. No production control was weakened for these fixtures.

## Reproduction and retained evidence

Run only from the review checkout with the fixture Compose file. Do not provide a production env file. The dedicated PostgreSQL/Redis containers and their migrations are provisioned first; the guarded grant SQL is then applied. The fixture credentials below are already public in the test configuration. Create these unique names only when absent, and preserve existing containers/volumes for a repeated run.

```sh
# Initial disposable infrastructure (fresh names only):
docker network create ls-hardening-20260930
docker network create --internal ls-hardening-20260930-sandbox
docker run -d --name ls-hardening-20260930-postgres --network ls-hardening-20260930 --network-alias postgres -p 127.0.0.1:55439:5432 -e POSTGRES_DB=ls_hardening -e POSTGRES_USER=ls_test_owner -e POSTGRES_PASSWORD=ls_fixture_owner postgres:16-alpine
docker run -d --name ls-hardening-20260930-redis --network ls-hardening-20260930 --network-alias redis -p 127.0.0.1:56389:6379 redis:7-alpine redis-server --requirepass ls_fixture_redis
# Once PostgreSQL is ready:
docker exec ls-hardening-20260930-postgres psql -U ls_test_owner -d ls_hardening -c "CREATE ROLE ls_test_runtime LOGIN PASSWORD 'ls_fixture_runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;"
DATABASE_URL='postgresql://ls_test_owner:ls_fixture_owner@127.0.0.1:55439/ls_hardening?schema=public' pnpm --filter @lyrashield/db exec prisma migrate deploy
mkdir -p /tmp/ls-hardening-20260930/worker-tmp
chmod 0770 /tmp/ls-hardening-20260930/worker-tmp
product_code=58cc2e46ec6c60f46f2d7ed9a8059205394aae88
engine_code=c0cf936b4c3ee6f8f331681802645cc044d60911
mkdir -p /tmp/ls-hardening-20260930/product-58cc2e46
mkdir -p /tmp/ls-hardening-20260930/engine-c0cf936b
git archive "$product_code" | tar -x -C /tmp/ls-hardening-20260930/product-58cc2e46
# From the engine repository:
git archive "$engine_code" | tar -x -C /tmp/ls-hardening-20260930/engine-c0cf936b
# From the clean product archive:
docker build --target runner --label org.opencontainers.image.revision="$product_code" --build-arg BUILD_APP_URL=http://localhost:33009 --build-arg BUILD_PUBLIC_APP_URL=http://localhost:33009 --build-arg BUILD_PUBLIC_MARKETING_URL=http://localhost:33010 --build-arg BUILD_LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0 -t ls-hardening-20260930:web .
docker build --target worker --label org.opencontainers.image.revision="$product_code" --label io.lyrashield.engine.revision="$engine_code" --build-context engine=/tmp/ls-hardening-20260930/engine-c0cf936b -t ls-hardening-20260930:worker .
docker build --target egress-proxy --label org.opencontainers.image.revision="$product_code" -t ls-hardening-20260930:egress-proxy .
docker build -f /tmp/ls-hardening-20260930/engine-c0cf936b/containers/Dockerfile -t lyrashield-sandbox:cross-repo-ls06-pyjwt-20260930 /tmp/ls-hardening-20260930/engine-c0cf936b
# From the review checkout:
docker compose -f docs/reviews/2026-09-30/docker-test.compose.yml config --quiet
docker exec -i ls-hardening-20260930-postgres psql -U ls_test_owner -d ls_hardening < docs/reviews/2026-09-30/docker-runtime-grants.sql
LYRASHIELD_MARKETING_REVISION="$product_code" pnpm --filter @lyrashield/marketing preview:build
docker build --label org.opencontainers.image.revision="$product_code" -f docs/reviews/2026-09-30/Dockerfile.marketing-test -t ls-hardening-20260930:marketing apps/marketing
docker compose -f docs/reviews/2026-09-30/docker-test.compose.yml up -d
DATABASE_URL='postgresql://ls_test_owner:ls_fixture_owner@127.0.0.1:55439/ls_hardening?schema=public' pnpm --filter @lyrashield/db exec tsx ../../docs/reviews/2026-09-30/docker-og-fixture.ts seed
# Wait for /api/ready/scans to return 200 before running the harness:
node docs/reviews/2026-09-30/docker-http-probe.mjs
pnpm --filter @lyrashield/db exec tsx ../../docs/reviews/2026-09-30/docker-egress-probe.mjs
FIXTURE_FAULT_MODE=lost-ack docker compose -f docs/reviews/2026-09-30/docker-test.compose.yml --profile fault up -d --force-recreate redis-ack-drop web-lost-ack
DOCKER_HTTP_ORIGIN=http://localhost:33012 DOCKER_HTTP_OUTPUT=/tmp/ls-hardening-20260930/evidence/lost-ack node docs/reviews/2026-09-30/docker-http-probe.mjs
curl http://localhost:39013/
docker compose -f docs/reviews/2026-09-30/docker-test.compose.yml --profile fault stop web-lost-ack redis-ack-drop
docker compose -f docs/reviews/2026-09-30/docker-test.compose.yml stop
```

For absent mode, set `FIXTURE_FAULT_MODE=absent` and `DOCKER_HTTP_EXPECT_TERMINAL=FAILED`; backdate only the newly admitted exact fixture IDs, then restart the isolated worker before the harness's terminal timeout. [docker-og-fixture.ts](./docker-og-fixture.ts) is the guarded reusable seed/expire/revoke/cleanup helper; it uses the sole public payload constructor. Keep the public OG fixture active until the image matrix finishes. The retained run cleaned its scorecard workspace after the mutation proofs. Stop the worker before integration tests that temporarily share its queue.

The final key receipts are `web-58cc-archive-build.log`, `worker-58cc-archive-build.log`, `egress-58cc-archive-build.log`, `final-image-digests.json`, `http-58cc-probe.log`, `http-58cc-ledger.log`, `lost-ack-58cc-*`, `absent-58cc-*`, `og-expire-58cc-http.log`, `og-revoke-58cc-http.log`, `scanner-58cc-probe.log`, `egress-58cc-probe.log`, `marketing-58cc-probe.log`, `client-58cc-docker-probe.log`, `sandbox-final-archive-*` and `worker-58cc-provenance-denial.log`.

Raw build, identity, service, HTTP, ledger, queue, image and Redis receipts are retained in `/tmp/ls-hardening-20260930/evidence/`; generated PNGs are excluded from commits. No raw account cookies or production secrets are included in this document.
