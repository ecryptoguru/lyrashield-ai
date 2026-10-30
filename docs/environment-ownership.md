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

Turnstile binds to the exact hostname of `NEXT_PUBLIC_MARKETING_URL` and the `lyrashield-public` action set by the scan and Myra widgets. Keep these frontend/backend changes in one release. Dummy secrets and Cloudflare's documented `localhost` / `test` response metadata are supported outside production; production rejects dummy secrets. The proof digest is still consumed once across all public callers. See [Cloudflare testing documentation](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).

When adding a literal runtime read, declare an application schema field or review an exact path and external owner in `lint/env-ownership.mjs`. Do not add broad prefix exemptions. Optional schema keys without root examples may be hosted credentials, managed identities or test-only markers; that alone does not prove drift. Verify the owning deployment or provider configuration before operational changes.
