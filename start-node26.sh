#!/bin/bash

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh" || { echo "nvm not found" >&2; exit 1; }
nvm use 26 || exit 1
pnpm start
