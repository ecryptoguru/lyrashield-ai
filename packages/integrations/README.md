# @lyrashield/integrations

GitHub, notifications, Redis, and BullMQ queue helpers shared by LyraShield apps.

## Purpose

- GitHub App integration: JWT creation, installation tokens, repo listing, branch operations, file creation, and pull request creation.
- Notification dispatch via `sendNotification` and the `channels` registry.
- Redis connection helpers (`getRedis`, `closeRedis`).
- BullMQ scan queue primitives (`getScanQueue`, `enqueueScan`, `registerScanWorker`, `isScanWorkerAvailable`) used by `apps/web` and `apps/worker`.

## Main exports

- `createAppJWT`, `getInstallationToken`, `listInstallationRepos`, `createPullRequest`, `createOrUpdateFile`, `getDefaultBranch`, `getBranchRefSha`
- `sendNotification`, `channels`
- `getRedis`, `closeRedis`
- `getScanQueue`, `enqueueScan`, `registerScanWorker`, `unregisterScanWorker`, `isScanWorkerAvailable`, `assertScanWorkerAvailable`, `ScanWorkerUnavailableError`

## See also

- `apps/web/src/app/api` for API route usage.
- `apps/worker` for queue consumption.
- `ops/worker` for operational egress refresh scripts.
