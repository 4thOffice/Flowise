#!/usr/bin/env bash
# Usage: start-server.sh <flowise checkout or worktree> <empty data dir>
# Starts Flowise on the capture port with every path under <data dir>, so ~/.flowise and port 3000 stay untouched.
set -euo pipefail

if [ $# -ne 2 ]; then
    echo "usage: $0 <flowise worktree> <data dir>" >&2
    exit 2
fi

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
exec ./run start
