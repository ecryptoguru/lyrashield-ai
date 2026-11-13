# @lyrashield/integrations

GitHub, notifications, Redis, and BullMQ queue helpers shared by LyraShield apps.

## Purpose

- GitHub App integration: JWT creation, installation tokens, repo listing, branch operations, file creation, and pull request creation.
- Notification dispatch via `sendNotification` and the `channels` registry.
- Redis connection helpers (`getRedis`, `closeRedis`).
- BullMQ scan queue primitives (`getScanQueue`, `enqueueScan`, `registerScanWorker`, `isScanWorkerAvailable`) used by `apps/web` and `apps/worker`.

## Main exports

- `createAppJWT`, `getInstallationToken`, `getRepositoryReadToken`, `listInstallationRepos`, `createPullRequest`, `createOrUpdateFile`, `getDefaultBranch`, `getBranchRefSha`
- `sendNotification`, `channels`
- `getRedis`, `closeRedis`
- `getScanQueue`, `enqueueScan`, `registerScanWorker`, `unregisterScanWorker`, `isScanWorkerAvailable`, `assertScanWorkerAvailable`, `ScanWorkerUnavailableError`

## Repository checkout credentials

`getRepositoryReadToken(installationId, repoFullName)` mints a fresh token restricted
to one GitHub repository with `contents:read`. It validates the repository's current
installation and rejects contradictory returned scope. It never reads or writes a
token cache. The worker's `prepareRepositoryAuth` owns workspace authorization and
checks the same active integration before and after minting, including deterministic
retests. Low-level minting does not authorize a workspace by itself.

`getInstallationToken` retains the existing default installation grant for authorized
API and write operations. Its shared Redis cache uses authenticated AES-GCM encryption
with a purpose-derived key from `BETTER_AUTH_SECRET`, bound to the app, installation,
and default grant. Legacy plaintext entries are ignored and expire naturally.

## See also

- `apps/web/src/app/api` for API route usage.
- `apps/worker` for queue consumption.
- `ops/worker` for operational egress refresh scripts.
