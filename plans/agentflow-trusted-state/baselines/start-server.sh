#!/usr/bin/env bash
# Usage: start-server.sh <flowise checkout or worktree> <empty data dir> [start|worker]
# Starts Flowise on the capture port with every path under <data dir>, so ~/.flowise and port 3000 stay untouched.
# Queue mode (Task 10): run it once with `start` and once with `worker`, both with MODE=queue and REDIS_URL set.
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
    echo "usage: $0 <flowise worktree> <data dir> [start|worker]" >&2
    exit 2
fi
COMMAND="${3:-start}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE="$(cd "$1" && pwd)"
DATA_DIR="$2"
mkdir -p "$DATA_DIR/storage" "$DATA_DIR/logs"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"

set -a
# shellcheck disable=SC1091
. "$HERE/capture.env"
set +a

export DATABASE_PATH="$DATA_DIR"
export SECRETKEY_PATH="$DATA_DIR"
export BLOB_STORAGE_PATH="$DATA_DIR/storage"
export LOG_PATH="$DATA_DIR/logs"

cd "$WORKTREE/packages/server/bin"
exec ./run "$COMMAND"
