# Agentflow V2 prediction latency (2026-11-24)

Measured on `master` at `de12c121` (`before`) and with the fixes below (`after`). Both builds ran in the shared checkout as an isolated server on :3100 with SQLite (`start-server.sh` and `capture.env` from `plans/agentflow-trusted-state/baselines`). One sequential client sent non-streaming `POST /api/v1/prediction/:id` requests over loopback.

Each sample is a conversation: turn 1 has no token, and turn 2 sends turn 1's token back. All flows reply with the same Direct Reply text.

## Flows (`flows/`, importable canvas JSON)

| Flow            | Nodes |                                                                                             Nodes executed | flowData |
| :-------------- | ----: | ---------------------------------------------------------------------------------------------------------: | -------: |
| `direct`        |     2 |                                                                                   Start → Direct Reply (2) |     4 KB |
| `skip150`       |   150 | 3 (the gate Condition sends everything to Direct Reply; the 147-node Function/Condition branch never runs) |   555 KB |
| `conditions150` |   150 |                                            150 (Start → 148 Conditions on `{{ question }}` → Direct Reply) |   571 KB |
| `chain150`      |   150 |                              150 (Start → 74 × (Custom Function → Condition on its output) → Direct Reply) |   555 KB |

Modes:

-   `token`: Client State is on with zero retention, so no ChatMessage or Execution rows are written.
-   `recording`: Client State is off, so the rows are written.

## Results (client p50, ms)

| Flow          | Mode      | before t1 / t2 | after t1 / t2 |
| :------------ | :-------- | -------------: | ------------: |
| direct        | token     |      4.6 / 4.9 |     2.1 / 2.3 |
| direct        | recording |      6.7 / 6.9 |     4.0 / 4.2 |
| skip150       | token     |    10.3 / 10.4 |     5.3 / 5.5 |
| skip150       | recording |    11.1 / 11.8 |     7.3 / 7.5 |
| conditions150 | token     |    63.7 / 62.9 |   19.9 / 20.0 |
| conditions150 | recording |    56.5 / 61.8 |   21.5 / 22.1 |
| chain150      | token     |      180 / 175 |     163 / 166 |
| chain150      | recording |      203 / 200 |     153 / 155 |

Raw data and span breakdowns are in `results/base-*.json` (before) and `results/after-*.json`. The `results/fixes-*.json` files are an earlier run that emulated fixes 1–3 in the preload: about 2.3 ms for `direct` and 26 ms for `conditions150`.

Database queries per request:

| Mode                 |                        before | after |
| :------------------- | ----------------------------: | ----: |
| Token                |                             3 |     2 |
| Recording            |                             8 |     7 |
| Extra for `chain150` | +74 (one per Custom Function) |    +1 |

History (`bench/longconv.mjs`, 40 turns of 1.5 KB questions): `conditions150` went from 33 ms at turn 1 to 45 ms at 78 history messages with fixes 1–3 only. After all fixes it goes from 29 ms to 33 ms.

### Where a trivial request went before (`direct`, token, turn 2, server 4.4 ms)

| Part                                                                                       |      ms |
| :----------------------------------------------------------------------------------------- | ------: |
| HTTP and middleware before the handler, plus response                                      |     0.5 |
| Controller: chatflow lookup (0.26), redirect check, origin log                             |     0.6 |
| `utilBuildChatflow`: Workspace and organization lookup (0.38), quota                       |     0.5 |
| `getAppVersion` × 2 (one direct call, one inside `sendTelemetry`)                          | **1.1** |
| Scheduler: Start and Direct Reply, including the Variable query (0.11) and Turndown (0.12) |     0.6 |
| Token read and write                                                                       |     0.7 |
| Remaining `executeAgentFlow` work: debug log formatting, graphs, telemetry                 |     0.4 |

### Scaling

-   **Executed nodes dominate.** Each executed Condition cost about 0.39 ms before and about 0.12 ms after. The Condition's own `run()` takes about 0.015 ms; the rest is per-node framework work.
-   **Each Custom Function costs about 1.6 ms more than a Condition.** `new NodeVM` alone takes 1.33 ms (not changed).
-   **Flow size matters little.** 147 non-executed nodes (555 KB) add about 3 ms after the fixes. That comes from `JSON.parse(flowData)` (1.6 ms), the larger row read, building graphs and the dependency engine, and GC.

## Fixes (implemented)

1. **`getAppVersion()` is memoized** (`utils/index.ts`). It used to probe up to 5 paths and read and parse `package.json` twice per prediction.
2. **Turndown output is cached by input string** (`buildAgentflow.ts`, `toMarkdown`).
    - Every `acceptVariable` string of every executed node used to get a new `TurndownService` and a domino DOM parse on every request.
    - The converted strings are almost all flow configuration. The cache returns the same output, so model input is unchanged.
    - It is bounded to 8M characters, FIFO; strings over 80k characters are not cached.
3. **Disabled log levels return early** (`utils/logger.ts`). winston used to run timestamp, `format.json()` and printf on every `logger.debug` call before the transports dropped it. The check is `logger.isLevelEnabled(level)`, which also counts transports with their own level.
4. **Node data is cloned once per executed node.**
    - `executeNode` only clones before `replaceInputsWithConfig`, which rewrites the data it is given; `resolveVariables` clones anyway.
    - The scheduler no longer deep-clones the history for each node. `executeNode` still gives each node's `run()` its own copy.
5. **Workspace variables are read lazily, once per turn.**
    - They are read the first time a `{{ $vars.* }}` reference or a node needs them, not unconditionally for every turn.
    - Nodes get them through `options.getAvailableVariables`, which `getVars` (components) uses instead of its own query. That covers Custom Function and anything else calling `getVars` with the run's options.
    - Every caller gets copies, because `getGlobalVariable` and `getVars` rewrite the variables they get.

Tests:

-   New tests in `test/utils/buildAgentflow/variables.test.ts`: no query without `$vars`, one query for several nodes, copies per node, and Custom Function without its own query.
-   All 13 `test/utils/buildAgentflow` suites pass, including the trusted-state characterization; the rest of the server suite and the components suite also pass.

### Not done (bigger or riskier)

-   **`new NodeVM` per Custom Function execution** is about 80% of a Function node's cost. In the CPU profile, `createContext` and the nodevm bridge and builtin setup dominate. A fresh sandbox per execution is the isolation boundary, so reusing one is not a safe tweak. Changing this means designing a different sandbox, such as pooled contexts or isolated-vm.
-   **The remaining `cloneDeep` work**: the node-data clone in `resolveVariables` (about 6 ms in `conditions150`) copies `inputParams` along with `inputs`. Cloning only `inputs` would need every node checked for writes to the rest of `nodeData`.
-   **`flowData` is parsed on every request**, along with the graphs and dependency engine (about 2–4 ms at 555 KB). Caching it by chatflow id and `updatedDate` requires that nothing mutates `nodes` or `edges`.
-   **The Workspace and organization lookup runs on every request** (one round trip). It could be cached with invalidation. Small gain.

### Caveats

-   **SQLite runs in-process and synchronously** (better-sqlite3), so DB time here is main-thread CPU. On Postgres each query is also a network round trip, so the removed queries matter more there.
-   **A browser request with an `Origin` header** adds one more chatflow lookup in the CORS check.
-   **Throughput was not measured.** The client was single and sequential. The work is CPU-bound and runs on a single thread, so one process serves roughly 1 / (CPU time per request).
-   **LLM calls are not in these flows.** In a flow with an LLM call (usually hundreds of ms to seconds), the framework time is secondary. It matters for flows with many deterministic nodes and for CPU per request.

## Rerun

Use the same layout as the trusted-state capture: port 3100 and a data dir outside `~/.flowise`. `$D` is any empty directory.

```bash
B=plans/agentflow-trusted-state/baselines
P=plans/agentflow-perf/bench
BENCH_OUT=$D/spans.jsonl NODE_OPTIONS="-r $PWD/$P/preload.cjs" $B/start-server.sh $PWD $D/data > $D/server.log 2>&1 &
BENCH_OUT=$D/spans.jsonl $P/matrix.sh <label>      # results/<label>-*.json; run it once to warm up first
# CPU profile around any run:
curl "localhost:3100/__bench/prof/start?us=100"; BENCH_OUT=$D/spans.jsonl node $P/bench.mjs --flows conditions150 --n 20 --out prof.json
curl "localhost:3100/__bench/prof/stop?file=$D/c150.cpuprofile"; node $P/analyze-prof.mjs $D/c150.cpuprofile
node $P/callers.mjs $D/c150.cpuprofile cloneDeep
```

`bench.mjs` creates or updates the flows through the API from the server's node definitions, so `flows/` is only for importing them into the canvas. `BENCH_FIXES` in the preload emulates fixes 1–3 on a build without them.
