# Agentflow V2 Concurrent Execution — Baseline Regression Suite

Pre-change regression suite captured on **unmodified `master`** (via local zero-API-key Agentflow V2 nodes: `startAgentflow`, `customFunctionAgentflow`, `conditionAgentflow`, `directReplyAgentflow`, `humanInputAgentflow`, `loopAgentflow`).

- **Captured At**: `2026-11-19T14:29:28Z`
- **Capture Script**: [`capture-traces.mjs`](./capture-traces.mjs)
- **Raw Trace Summary**: [`traces/before/summary.json`](./traces/before/summary.json)

---

## 1. Before vs. After Comparison Summary

| Flow | Scenario | Before Duration (REST / SSE) | After Duration (REST / SSE) | Before Executed Nodes & Output / Stream | After Executed Nodes & Output / Stream | Before Validation / Canvas | After Validation / Canvas |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **01** [`01-parallel-fork-join-timing-and-state.json`](./flows/01-parallel-fork-join-timing-and-state.json) | Fork `250ms` + `250ms` -> Join | `591.65 ms` / `537.77 ms` | _TBD (Task 07)_ | **Sequential**: `Branch A` (`12.51–272.11 ms`) runs before `Branch B` (`272.21–534.41 ms`). `Branch B` reads `Branch A`'s mutated state (`saw_a=A(saw_b=empty)`). Output: `"State: a=A(saw_b=empty) / b=B(saw_a=A(saw_b=empty))"`. | _TBD (Task 07)_ | `Checklist (0)` — no concurrency/wave info | `Checklist (0)` (no false positives; disjoint `a`/`b` keys). **Canvas waves**: `Step 1` -> `[Step 2.1 (Parallel), Step 2.2 (Parallel)]` -> `Step 3`. |
| **02** [`02-multi-hop-and-nested-conditions.json`](./flows/02-multi-hop-and-nested-conditions.json) | `Cond1=True` (`"true-branchA"`) | `283.24 ms` / `283.43 ms` | _TBD (Task 07)_ | **Join skipped / stalled**: executes `[Start, Cond1, ParallelNode, Cond2, Branch A]`; `Join Reply` (`directReplyAgentflow_0`) **never runs** (stuck in `waitingNodes` awaiting `Cond1: [F2]`). REST `text`: `"cond1-true-cond2-A"`, SSE tokens: `[]` (`""`). | _TBD (Task 07)_ | `Checklist (0)` | `Checklist (0)` (mutually exclusive `branch` writes across `Cond1`/`Cond2` silenced). **Canvas waves**: `Step 1` -> `[2.1, 2.2]` -> `[3.1, 3.2]` -> `[4.1, 4.2, 4.3]` -> `Step 5`. |
| **02** [`02-multi-hop-and-nested-conditions.json`](./flows/02-multi-hop-and-nested-conditions.json) | `Cond1=False` (`"false"`) | `337.18 ms` / `339.09 ms` | _TBD (Task 07)_ | **Join skipped / stalled**: executes `[Start, Cond1, ParallelNode, F1, F2]`; `Join Reply` (`directReplyAgentflow_0`) **never runs** (stuck in `waitingNodes` awaiting `Cond2: [Branch A, Branch B]`). REST `text`: `"cond1-false-F1-F2"`, SSE tokens: `[]` (`""`). | _TBD (Task 07)_ | `Checklist (0)` | `Checklist (0)` (same flow topology as above). **Canvas waves**: `Step 1` -> `Step 2.1–2.2` -> `Step 3.1–3.2` -> `Step 4.1–4.3` -> `Step 5`. |
| **03** [`03-condition-multi-edge-fanout.json`](./flows/03-condition-multi-edge-fanout.json) | `go-true` (`Else` has 2 targets) | `47.17 ms` / `27.43 ms` | _TBD (Task 07)_ | **`edges.find` bug** (`buildAgentflow.ts:873`): `Else Target A` skipped, **`Else Target B` mistakenly executed**. REST `text`: `"BUG: Else Target B executed!"`; SSE chunks: `["True branch executed cleanly.", "BUG: Else Target B executed!"]` concatenated without `\n\n`. | _TBD (Task 07)_ | `Checklist (0)` | `Checklist (1)` — **Multiple Terminal Nodes**: warns `(Else Target A, Else Target B)` stream with `\n\n`, tie-break `Else Target A -> Else Target B`. **Canvas waves**: `Step 1` -> `Step 2` -> `Step 3.1–3.3 (Parallel)`. |
| **04** [`04-multi-terminal-streaming-and-silent-leaf.json`](./flows/04-multi-terminal-streaming-and-silent-leaf.json) | 2 `DirectReply` leaves + `Silent Leaf (400ms)` | `793.86 ms` / `780.84 ms` | _TBD (Task 07)_ | **Sequential + blanked REST output**: runs `Fast Ack` -> `Lookup Worker (300ms)` -> `Telemetry Prep (50ms)` -> `Final Result` -> `Silent Leaf (400ms)`. REST `text` blanked to `""`; SSE tokens concatenated without `\n\n`: `"I'm looking up the data...Here is the result."`. | _TBD (Task 07)_ | `Checklist (0)` — no multi-terminal order notice | `Checklist (1)` — **Multiple Terminal Nodes**: warns `(Fast Ack, Final Result)` (silent `CustomFunction` leaf excluded), tie-break `Fast Ack -> Final Result`. **Canvas waves**: `Step 1` -> `Step 2.1–2.3` -> `Step 3.1–3.2`. |
| **05** [`05-human-input-with-companion-text.json`](./flows/05-human-input-with-companion-text.json) | Turn 1 (`STOPPED`) + Turn 2 (`proceed` resume) | Turn 1: `231.60 ms` / `235.36 ms`<br>Turn 2: `20.63 ms` / `16.36 ms` | _TBD (Task 07)_ | **Companion text dropped**: Turn 1 executes `[Start, Prepare Summary, Approval Gate (STOPPED)]` and breaks at `shouldStop`, **dropping `Companion Summary`** (REST/SSE `text`: `"\n\nApprove?"`, `action`: `Approval Gate`). Turn 2 resumes `Approval Gate` -> `Approved Reply` (`"Approved!"`); `Companion Summary` still never runs. | _TBD (Task 07)_ | `Checklist (0)` | `Checklist (1)` — **Multiple Terminal Nodes**: warns `(Companion Summary, Approved Reply, Rejected Reply)`, tie-break `Companion Summary -> Approved Reply -> Rejected Reply`. **Canvas waves**: `Step 1` -> `Step 2.1–2.2` -> `Step 3.1–3.3`. |
| **06** [`06-loop-over-parallel-subgraph.json`](./flows/06-loop-over-parallel-subgraph.json) | Loop (`loop_count < 2`) over `[150ms, 150ms]` fork | `981.96 ms` / `970.18 ms` | _TBD (Task 07)_ | **Sequential loop passes**: 3 passes x `(150ms + 150ms)` = `~970–982 ms`, 16 sequential node executions (`Start` -> 3x `[Fork Entry, Worker A, Worker B, Loop Check]` + 2x `Loop Back` + `Exit Reply`). Output: `"Loop exited at loop_count=2; iterA=A,A,A; iterB=B,B,B"`. | _TBD (Task 07)_ | `Checklist (0)` | `Checklist (0)` (disjoint `iterA`/`iterB`). **Canvas waves**: `Step 1` -> `Step 2` -> `Step 3.1–3.2 (Parallel)` -> `Step 4` -> `Step 5.1–5.2 (Parallel)`. |

---

## 2. Artifact Index

| # | Flow JSON | Before Trace | Before Canvas Screenshot | Before Validation Screenshot | After Canvas Screenshot | After Validation Screenshot |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **01** | [`01-parallel-fork-join-timing-and-state.json`](./flows/01-parallel-fork-join-timing-and-state.json) | [`01-...json`](./traces/before/01-parallel-fork-join-timing-and-state.json) | [`01-...-canvas.png`](./screenshots/before/01-parallel-fork-join-timing-and-state-canvas.png) | [`01-...-validation.png`](./screenshots/before/01-parallel-fork-join-timing-and-state-validation.png) | [`01-...-canvas.png`](./screenshots/after/01-parallel-fork-join-timing-and-state-canvas.png) | [`01-...-validation.png`](./screenshots/after/01-parallel-fork-join-timing-and-state-validation.png) |
| **02** | [`02-multi-hop-and-nested-conditions.json`](./flows/02-multi-hop-and-nested-conditions.json) | [`02-...json`](./traces/before/02-multi-hop-and-nested-conditions.json) | [`02-...-canvas.png`](./screenshots/before/02-multi-hop-and-nested-conditions-canvas.png) | [`02-...-validation.png`](./screenshots/before/02-multi-hop-and-nested-conditions-validation.png) | [`02-...-canvas.png`](./screenshots/after/02-multi-hop-and-nested-conditions-canvas.png) | [`02-...-validation.png`](./screenshots/after/02-multi-hop-and-nested-conditions-validation.png) |
| **03** | [`03-condition-multi-edge-fanout.json`](./flows/03-condition-multi-edge-fanout.json) | [`03-...json`](./traces/before/03-condition-multi-edge-fanout.json) | [`03-...-canvas.png`](./screenshots/before/03-condition-multi-edge-fanout-canvas.png) | [`03-...-validation.png`](./screenshots/before/03-condition-multi-edge-fanout-validation.png) | [`03-...-canvas.png`](./screenshots/after/03-condition-multi-edge-fanout-canvas.png) | [`03-...-validation.png`](./screenshots/after/03-condition-multi-edge-fanout-validation.png) |
| **04** | [`04-multi-terminal-streaming-and-silent-leaf.json`](./flows/04-multi-terminal-streaming-and-silent-leaf.json) | [`04-...json`](./traces/before/04-multi-terminal-streaming-and-silent-leaf.json) | [`04-...-canvas.png`](./screenshots/before/04-multi-terminal-streaming-and-silent-leaf-canvas.png) | [`04-...-validation.png`](./screenshots/before/04-multi-terminal-streaming-and-silent-leaf-validation.png) | [`04-...-canvas.png`](./screenshots/after/04-multi-terminal-streaming-and-silent-leaf-canvas.png) | [`04-...-validation.png`](./screenshots/after/04-multi-terminal-streaming-and-silent-leaf-validation.png) |
| **05** | [`05-human-input-with-companion-text.json`](./flows/05-human-input-with-companion-text.json) | [`05-...json`](./traces/before/05-human-input-with-companion-text.json) | [`05-...-canvas.png`](./screenshots/before/05-human-input-with-companion-text-canvas.png) | [`05-...-validation.png`](./screenshots/before/05-human-input-with-companion-text-validation.png) | [`05-...-canvas.png`](./screenshots/after/05-human-input-with-companion-text-canvas.png) | [`05-...-validation.png`](./screenshots/after/05-human-input-with-companion-text-validation.png) |
| **06** | [`06-loop-over-parallel-subgraph.json`](./flows/06-loop-over-parallel-subgraph.json) | [`06-...json`](./traces/before/06-loop-over-parallel-subgraph.json) | [`06-...-canvas.png`](./screenshots/before/06-loop-over-parallel-subgraph-canvas.png) | [`06-...-validation.png`](./screenshots/before/06-loop-over-parallel-subgraph-validation.png) | [`06-...-canvas.png`](./screenshots/after/06-loop-over-parallel-subgraph-canvas.png) | [`06-...-validation.png`](./screenshots/after/06-loop-over-parallel-subgraph-validation.png) |

---

## 3. Reproducing / Re-Running Traces (`before` or `after`)

Start Flowise with an isolated database directory (leaving `~/.flowise` untouched):

```bash
mkdir -p /tmp/flowise-baseline-db/{storage,logs}
DATABASE_PATH=/tmp/flowise-baseline-db \
SECRETKEY_PATH=/tmp/flowise-baseline-db \
BLOB_STORAGE_PATH=/tmp/flowise-baseline-db/storage \
LOG_PATH=/tmp/flowise-baseline-db/logs \
PORT=3000 \
bash -c 'cd packages/server/bin && ./run start'
```

Run the capture script (defaults to `traces/before`; override `--out-dir` in Task 07 for `traces/after`):

```bash
# Baseline (unmodified master)
node plans/agentflow-concurrent-execution/baselines/capture-traces.mjs

# Task 07 replay (after concurrent execution changes)
node plans/agentflow-concurrent-execution/baselines/capture-traces.mjs \
  --out-dir plans/agentflow-concurrent-execution/baselines/traces/after
```
