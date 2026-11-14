# Environment configuration ownership

The application schema in `packages/config/src/env.ts` owns web, worker and shared service settings. `.env.example` is the developer starting point, not a copy of every provider, CI or engine variable. `pnpm lint:env-ownership` checks literal production-source reads against schema keys and exact external-owner bindings; it does not claim to inventory dynamic environment maps or validate deployed values.

| Owner                       | Examples                                                                                                 | Source of truth                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Application                 | `OPENAI_APPS_DOMAIN_VERIFICATION_TOKEN`, `LYRASHIELD_SCAN_PLAN_REQUIRED`, `OUTBOUND_CONNECTOR_ADMISSION` | Central schema and staged deployment configuration                         |
| Build and browser           | `NEXT_PUBLIC_SENTRY_RELEASE`, `NEXT_PUBLIC_MARKETING_URL`                                                | Build environment; public values only                                      |
| Framework and host          | `NEXT_PHASE`, `NEXT_RUNTIME`, `HOSTNAME`, `PATH`, `PORT`                                                 | Next.js or process/container launcher                                      |
| CI and fixtures             | `VITEST`, `LYRASHIELD_TEST_DB_DISPOSABLE`, auth-mail owned-directory markers                             | Disposable test runner; never enable in production                         |
| CLI, credentials and MCP    | `NO_COLOR`, `CI`, `LYRASHIELD_OAUTH_ACCESS_TOKEN`, `LYRASHIELD_LOG_DESTINATION`                          | Their entrypoint or credential transport                                   |
| Engine boundary             | `STRIX_SANDBOX_MIN_DISK_MB`                                                                              | Worker preflight and engine host configuration                             |
| Operator tooling            | Log Analytics identity and worker-stop receipts                                                          | The relevant operations command/runbook                                    |
| Managed deployment identity | Product/engine revision and worker image digest                                                          | Digest-pinned launcher and OCI labels; never synthetic production defaults |

Turnstile always binds to the exact hostname of `NEXT_PUBLIC_MARKETING_URL`. The scan and Myra widgets set the `lyrashield-public` action. `TURNSTILE_ENFORCE_ACTION=0` is the staged default: only the exact action or an absent/empty legacy action is accepted; any other action is denied. This keeps independently deployed backends compatible with cached/active old widgets. After widget rollout and cache/active-session review, an authorized operator can opt in with the trusted deployment variable `TURNSTILE_ENFORCE_ACTION=1`; the backend then requires the exact action. Provider success, challenge freshness and global one-use proof consumption stay enforced in both modes. No live setting was changed by adding this option. Dummy secrets and Cloudflare's documented `localhost` / `test` response metadata are supported outside production; production rejects dummy secrets. The proof digest is still consumed once across all public callers. See [Cloudflare testing documentation](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).

When adding a literal runtime read, declare an application schema field or review an exact path and external owner in `lint/env-ownership.mjs`. Do not add broad prefix exemptions. Optional schema keys without root examples may be hosted credentials, managed identities or test-only markers; that alone does not prove drift. Verify the owning deployment or provider configuration before operational changes.

## Engine evidence rollout controls

The worker forwards these controls from the central schema's validated startup configuration. Changes require a worker restart; scan requests, profiles, chat and relay context cannot select them. Values other than the exact strings below fail configuration loading before engine/model work. These settings belong to the trusted worker deployment environment, never tenant settings or public/browser variables.

| `LYRASHIELD_RUN_RECORD_V1_1` | `LYRASHIELD_PENDING_HTTP_EVIDENCE` | Engine writer behavior                            |
| ---------------------------- | ---------------------------------- | ------------------------------------------------- |
| `0` (default)                | `0` (default)                      | Existing 1.0 records                              |
| `1`                          | `0`                                | Explicit 1.1 records                              |
| `1`                          | `1`                                | Controlled 1.2 records with pending HTTP evidence |
| `0`                          | `1`                                | Invalid; startup fails                            |

Set hosted writer controls and endpoint modes in the root-owned `/etc/lyrashield/worker-runtime.conf`. The production launcher and promotion preflight validate that file before constructing Docker arguments. Secret refresh regenerates the separate worker environment file on every start.

The hosted worker also accepts optional canonical `LLM_API_MODE` and `DEDUPE_LLM_API_MODE` values of `auto`, `responses` or `chat_completions`. Unset main policy uses the engine's automatic policy; unset dedupe policy inherits the main policy. Do not install a default dedupe override merely to populate the environment. Engine-only aliases (`LYRASHIELD_LLM_API_MODE`, `LYRASHIELD_DEDUPE_LLM_API_MODE`), arbitrary request bodies/headers and new dedupe credentials are not forwarded. These options do not replace provider qualification or the existing immutable, owned `LYRASHIELD_IMAGE` digest requirement.

Roll out in this order after the separate release and runtime qualifications pass:

1. Deploy and qualify reader-capable worker **and web** images first, paired with the previous engine `3001517530300ca5f602536bfadcbd3c95ad3039`. Keep both writer controls at `0`. Retain these exact reader-capable images and this engine pairing as the rollback baseline. Verify existing 1.0/1.1 reads and retained 1.2 fixture reads before allowing 1.2 production writes.
2. Upgrade to the separately qualified engine with both writer controls still `0`. Verify its immutable image identity, startup, normal runs and reader compatibility. This source change does not alter the engine pin or release workflow and does not itself qualify an engine/runtime image.
3. With admissions restricted to a single controlled canary, explicitly configure `1`/`1`, restart the controlled worker and run only the authorized canary. Verify artifact identity, complete/pending/incomplete reader behavior, retained evidence and web rendering. Keep the explicit `1`/`0` path available for separate 1.1 qualification; it does not enable pending evidence.
4. To roll back, stop new admissions, set pending evidence to `0` and run-record 1.1 to `0`, then drain/stop the canary worker before restoring the qualified previous-engine pairing. Keep the reader-capable worker and web images so already-created 1.2 runs remain readable. Verify those retained runs and readiness before restoring admissions. Disabling writers affects future output; never rewrite existing records to downgrade them.

Do not roll the application directly back to the original `d488862bd269c07194afe87a918ca413e4a62217` baseline after any 1.2 run exists: that baseline lacks the new reader. Writer disablement alone does not make older readers compatible with retained 1.2 artifacts. Keep the reader-capable rollback deployment until retention and compatibility evidence permits a separately reviewed change.
