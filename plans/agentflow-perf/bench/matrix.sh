#!/usr/bin/env bash
# usage: matrix.sh <label>  — writes ../results/<label>-{small,cond,chain}.json
set -e
cd "$(dirname "$0")"
L=$1
node bench.mjs --flows direct,skip150 --modes token,recording --n 300 --warmup 50 --out $L-small.json | grep turn
node bench.mjs --flows conditions150 --modes token,recording --n 40 --warmup 5 --out $L-cond.json | grep turn
node bench.mjs --flows chain150 --modes token,recording --n 20 --warmup 3 --out $L-chain.json | grep turn
