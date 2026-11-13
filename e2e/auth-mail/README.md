# Local reset mail browser proof

Use only a migrated disposable loopback PostgreSQL database with a restricted runtime role and a separate owner URL. No Brevo credentials are needed or used.

```sh
LYRASHIELD_TEST_DB_DISPOSABLE=1 \
  DATABASE_URL="$RLS_RUNTIME_DATABASE_URL" \
  DATABASE_SYSTEM_URL="$RLS_SYSTEM_DATABASE_URL" \
  pnpm test:auth-mail-browser
```

The runner creates a fresh private mail directory once, before starting Playwright. The config, Next server and browser worker reuse that exact owned path even though Playwright loads the config again in workers. The suite starts a separate development app on `127.0.0.1:3102`, creates an `example.test` account, requests reset through the browser, reads the privately captured delivery and redeems its link. It verifies old-password rejection, session revocation, replay rejection and exactly one successful concurrent redemption of a second delivered token. Only this run's disposable user/token rows are deleted.

`LYRASHIELD_TEST_AUTH_MAIL_DIR` remains unset in normal environments. The fixture ignores any caller-supplied path and creates a new owner-only temporary directory for each run. Capture requires the separate owned-path marker to match; teardown removes only that recorded path. It writes complete deliveries atomically in private randomly named files. There is no public mailbox endpoint or token logging. Capture rejects production, including production builds; provider credentials; remote app/database origins or PostgreSQL query overrides; non-synthetic recipients; and unsafe directories. Traces, screenshots, video and failed-page snapshots are disabled. Navigation and initial form failures report a fixed message without the captured URL; normal browser assertions resume only after it is stripped. Debug logging is rejected.

Knip statically analyzes every root `e2e` file through its existing entry/project patterns. Its root Playwright plugin is disabled so ordinary dependency analysis cannot execute this guarded config, create a capture directory or require fixture credentials.

This proof covers local delivery and the application journey. It does not establish production mailbox delivery or live Brevo behavior.
