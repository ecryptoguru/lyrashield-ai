#!/bin/sh
set -eu
if [ "$(uname -s)" != "Linux" ]; then
  echo "SKIP linux-fault-harness: requires Linux cgroup v2"
  exit 0
fi
case_root="/sys/fs/cgroup/lyrashield-fault-$$"
if ! mkdir "$case_root" 2>/dev/null; then
  echo "SKIP linux-fault-harness: cgroup v2 is not writable"
  exit 0
fi
cleanup() {
  rmdir "$case_root/process-owned" 2>/dev/null || true
  rmdir "$case_root" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
pnpm exec tsx test/linux-fault-harness.ts "$case_root"
