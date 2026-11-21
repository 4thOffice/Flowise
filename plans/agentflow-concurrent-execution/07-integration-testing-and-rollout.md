# Task 07: Integration Testing, Hardening, & Rollout

- **Status**: Done (verification matrix implemented, baselines replayed, rollout checklist complete)
- **Design Status**: Executes after Tasks 00b, 01–06, and 08 are complete
- **Depends On**:
  - [00b-baseline-flows-and-traces.md](./00b-baseline-flows-and-traces.md)
  - [04-dag-joins-condition-pruning-and-loops.md](./04-dag-joins-condition-pruning-and-loops.md)
  - [05-multiple-terminal-nodes-and-streaming.md](./05-multiple-terminal-nodes-and-streaming.md)
  - [06-error-handling-and-human-input-semantics.md](./06-error-handling-and-human-input-semantics.md)
  - [08-additive-canvas-ux-and-validation.md](./08-additive-canvas-ux-and-validation.md)
- **Primary Files**:
  - `packages/server/test/utils/buildAgentflow/integration.test.ts` (new)
  - `packages/server/.env.example`
  - `packages/server/src/utils/buildAgentflow.ts`

---

## 1. Objective

Validate the complete concurrent Agentflow V2 execution engine across realistic multi-node workflows, randomized timing/race fuzz tests, persistence modes (DB, `EXECUTIONS_DB_THREAD`, `useTrustedState`, `MODE=queue`), sequential fallback mode (`AGENTFLOW_MAX_NODE_CONCURRENCY=1`), and additive canvas UX/validation.

---

## 2. Verification Matrix

### 2.1 Concurrency & Timing Stress Tests (`integration.test.ts`)
- **Randomized Latency Fuzzing**:
  - Run complex DAGs (wide fan-out -> multi-hop & nested conditions -> joins -> `loopAgentflow` -> multiple terminal nodes) across 50+ iterations with randomized per-node delays (`0-20ms`).
  - Assert that for every run:
    - Every reachable node executes the exact expected number of times (no missed joins, no duplicate executions).
    - Every skipped branch node (via Kahn + DPE) executes 0 times.
    - Final `agentflowRuntime.state` contains all expected disjoint branch keys.
    - Final `result.text` matches streamed tokens (`\n\n`-separated across content-bearing terminal nodes) and `status` satisfies all invariants.
    - `maxObservedConcurrency <= AGENTFLOW_MAX_NODE_CONCURRENCY`.
- **Parity Test (`concurrency = 1` vs `concurrency = 10`)**:
  - Verify deterministic flows produce equivalent outputs and final state under both `AGENTFLOW_MAX_NODE_CONCURRENCY=1` and `AGENTFLOW_MAX_NODE_CONCURRENCY=10`.
- **Multi-Terminal + Non-Interrupting `STOPPED` Matrix**:
  - Fast `DirectReply` leaf + slow `LLM` leaf -> consecutive `\n\n` SSE stream & exact DB `ChatMessage.content` match.
  - Companion `DirectReply` branch + `HumanInput` branch -> `STOPPED` emitted after companion text finishes, `ChatMessage` carries both text and `action`, and resume continues cleanly.
  - Fail-fast error branch -> sibling in-flight branch receives child `AbortController` abort and settles before throwing root error.
- **Sequential `iterationAgentflow` with Parallel Subflow**:
  - Verify an `iterationAgentflow` running 3 items sequentially executes each item's internal parallel branches concurrently without cross-item state corruption.
- **High-Load Multi-Request Concurrency**:
  - Fire N concurrent `executeAgentFlow` calls for different `chatId`/`sessionId` values simultaneously to confirm zero cross-request state leakage (no module-level mutable state).

### 2.1b Before vs. After Baseline Replay (`baselines/flows/` -> `baselines/traces/after/`)
- Replay all 6 zero-API-key baseline flows captured in [00b-baseline-flows-and-traces.md](./00b-baseline-flows-and-traces.md) against the updated server and save outputs to `plans/agentflow-concurrent-execution/baselines/traces/after/`.
- Update `plans/agentflow-concurrent-execution/baselines/README.md` with a side-by-side **Before vs. After** comparison covering:
  - Wall-clock speedups on parallel fork-join & loop subgraphs (e.g., ~500ms -> ~250ms on Flow 01).
  - Resolved multi-hop/nested condition deadlocks (Flow 02) and multi-edge condition handle fan-out fixes (Flow 03).
  - Consecutive `\n\n` SSE streaming & non-blanked terminal output when a silent leaf finishes last (Flow 04).
  - Non-interrupting `STOPPED` companion text + approval buttons & resume parity (Flow 05).
  - Parity verification with `AGENTFLOW_MAX_NODE_CONCURRENCY=1`.

### 2.2 Infrastructure, UI, & Mode Checks
- [x] **SSE Streaming**: Verify live `nextAgentFlow` events (multiple nodes `INPROGRESS` simultaneously -> `FINISHED`), consecutive non-interleaved `\n\n` `token` events, final `agentFlowExecutedData`, `trustedStateData`, and `end` (`[DONE]`).
- [x] **Database Persistence**: Verify `Execution` and `ChatMessage` writes with default TypeORM path AND serialized `updateExecution` updates with `EXECUTIONS_DB_THREAD=1`.
- [x] **Zero-Retention / Trusted State**: Verify `useTrustedState` / `zeroRetention` flows produce valid encrypted state payload on `FINISHED`, `STOPPED`, and `ERROR`.
- [x] **Queue Mode (`MODE=queue`)**: Verify `PredictionQueue` worker execution path (`packages/server/src/queue/PredictionQueue.ts`) works seamlessly with concurrent node scheduling.
- [x] **Analytics / Tracing**: Verify `analyticHandlers` (`onChainStart`, `onChainEnd`, `onChainError`) receive clean lifecycle calls even under parallel branches.
- [x] **Canvas UX & Validation**: Verify wave badges render cleanly in UI without setting dirty state, and `checkFlowValidation` catches unlinked `{{node}}` references and parallel state-key write conflicts.

### 2.3 Documentation & Rollout Checklist
- [x] Confirm `AGENTFLOW_MAX_NODE_CONCURRENCY` is documented in `packages/server/.env.example` (including default value and `=1` sequential fallback note).
- [x] Remove any temporary debug logs or dead legacy helpers (e.g., unused `findConditionParent`, `setupNodeDependencies`, `hasReceivedRequiredInputs` once superseded by `dependencyEngine.ts`).
- [x] Full workspace build succeeds: `pnpm build` (covers `flowise` server and `flowise-ui` touched in Task 08).
- [x] Full server test suite passes with zero open handles: `pnpm --filter flowise test`.
- [x] Update `plans/agentflow-concurrent-execution/PLAN.md` task statuses to `Done`.

---

## 3. Verification Results

- **`integration.test.ts`** (39 tests): 60 seeded fuzz runs over a 5-wide fan-out -> nested/multi-hop conditions -> join -> `loopAgentflow` (1–3 passes) -> 4 terminal leaves (1 silent) with `AGENTFLOW_MAX_NODE_CONCURRENCY` cycling `1, 2, 3, 4, 6, 10` and streaming on/off; `=1` vs `=10` parity on the fuzz DAG and baseline Flows 01–06; fast `DirectReply` + slow `LLM` streams; companion + `HumanInput` (`proceed`/`reject`, REST/SSE); fail-fast abort (`concurrency 3/10`, REST/SSE); 3-item `iterationAgentflow` with a concurrent inner subflow; 9 concurrent requests on a shared `SSEStreamer` + datasource; default TypeORM vs `EXECUTIONS_DB_THREAD=1` (real `executionsWorker`); `zeroRetention` on `FINISHED` / `STOPPED` (+ stateless resume) / `ERROR` and `useTrustedState`-only; `PredictionQueue.processJob` (env limit + `AbortControllerPool` cancellation); `analyticHandlers` on `FINISHED` / `ERROR` / `STOPPED` plus the real `AnalyticHandler` with overlapping LLM spans; a failing final `Execution` write; iteration checkpoint freshness; Flow 04 SSE lifecycle on the wire.
- **Mutation check**: 7 deliberately injected engine regressions (whole-state overwrite instead of delta merge, stream lock bypass, DPE treating skipped joins as activated, ignored concurrency limit, rejecting before in-flight siblings settle, unserialized DB queue, child abort scope not passed to nodes) each failed the suite.
- **Baseline replay**: [`baselines/traces/after/`](./baselines/traces/after/) (`=10`) and [`baselines/traces/after/concurrency-1/`](./baselines/traces/after/concurrency-1/) (`=1`), compared in [`baselines/README.md`](./baselines/README.md).
- **Canvas UX**: on the built UI, the Flow 01 overlay toggles `Step 1` -> `Step 2.1/2.2 (Parallel)` -> `Step 3` badges on and off without setting the unsaved-changes marker; validation counts from the replay (`0, 0, 1, 1, 1, 0`) match Task 08.
- **Legacy helpers**: `findConditionParent`, `setupNodeDependencies`, `hasReceivedRequiredInputs`, `determineNodesToIgnore`, and `processNodeOutputs` are no longer called by the scheduler but are kept because `baseline.test.ts`, `concurrentScheduler.test.ts`, and `dagSemantics.test.ts` still import them; their `@deprecated` notes say so. Four dead imports were removed from `buildAgentflow.ts`; no stray debug logging was found.
- **Test infrastructure**: `pnpm --filter flowise test` runs the server suite twice in parallel (root `turbo run test` + the package script). `test/setupEnv.ts` now pre-creates the shared log directory, and `test/index.test.ts` boots its server on a free port with a throwaway data directory instead of `:3000` and `~/.flowise`.
- **Independent review** (static reviewer over `git diff master -- packages/`). Fixed:
  - Parallel LLM/tool spans evicted each other in the per-chat `AnalyticHandler` (`packages/components/src/handler.ts`). Run maps are now additive and finished LLM/tool entries are removed; this also stops langWatch LLM spans from evicting the chain span, and adds the missing `opik` key in `onLLMStart`.
  - A failed final `Execution` write no longer fails an already-produced answer or replaces the root node error.
  - Iteration checkpoints serialize the committed records when the queued write runs, so records from parallel siblings are no longer dropped.
  - The multi-terminal validation notice now also counts `toolAgentflow`, `retrieverAgentflow`, and `iterationAgentflow` leaves.
  - `.env.example` states that `=1` keeps the new scheduling semantics and that each iteration subflow gets its own budget.
- **Known limitations and deliberate choices** (unchanged):
  - The final `Execution` write is still awaited before the response, as §4.3 of Task 06 requires. With `EXECUTIONS_DB_THREAD=1` that waits on the process-wide single worker thread, whereas master fired and forgot it.
  - A streaming leaf inside a loop body that is still running when the loop restarts can stream text that is then dropped as a stale completion, so the wire text differs from the saved content. Master also streamed every pass, so this is not a regression.
  - Disconnected non-start nodes are skipped instead of rejected (Task 04); structural validation still flags them.
  - Nodes inside `iterationAgentflow` subflows get no SSE streamer (Task 05), which also drops their tool and metadata events.
  - Wave badges default to on (allowed by Task 08) and are recomputed on every node change.
  - Two Execute Flow nodes calling the same sub-flow in parallel share one `${chatflowId}_${chatId}` abort-controller key in `buildChatflow.ts`, so a stop request can miss one of them.
