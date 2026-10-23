#!/usr/bin/env bash
set -o pipefail
sudo apt update && sudo apt install -y build-essential python3 git curl || { echo "Failed: apt install"; exit 1; }
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash || { echo "Failed: nvm install"; exit 1; }
. ~/.nvm/nvm.sh && nvm install 26 && nvm alias default 26 || { echo "Failed: node 26 install"; exit 1; }
sudo apt remove -y cmdtest
npm install -g pnpm@11.15.1 yarn@1.22.22 || { echo "Failed: pnpm/yarn install"; exit 1; }
rm -rf node_modules/ packages/*/node_modules/ || { echo "Failed: rm node_modules"; exit 1; }
pnpm i || { echo "Failed: pnpm i"; exit 1; }
NODE_OPTIONS="--max-old-space-size=6096" pnpm build || { echo "Failed: pnpm build"; exit 1; }
echo "Done"
echo "Run with: ./start-node26.sh"
