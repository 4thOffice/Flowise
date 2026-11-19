# Task 07: Integration Testing, Hardening, & Rollout

- **Status**: Pending
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
- [ ] **SSE Streaming**: Verify live `nextAgentFlow` events (multiple nodes `INPROGRESS` simultaneously -> `FINISHED`), consecutive non-interleaved `\n\n` `token` events, final `agentFlowExecutedData`, `trustedStateData`, and `end` (`[DONE]`).
- [ ] **Database Persistence**: Verify `Execution` and `ChatMessage` writes with default TypeORM path AND serialized `updateExecution` updates with `EXECUTIONS_DB_THREAD=1`.
- [ ] **Zero-Retention / Trusted State**: Verify `useTrustedState` / `zeroRetention` flows produce valid encrypted state payload on `FINISHED`, `STOPPED`, and `ERROR`.
- [ ] **Queue Mode (`MODE=queue`)**: Verify `PredictionQueue` worker execution path (`packages/server/src/queue/PredictionQueue.ts`) works seamlessly with concurrent node scheduling.
- [ ] **Analytics / Tracing**: Verify `analyticHandlers` (`onChainStart`, `onChainEnd`, `onChainError`) receive clean lifecycle calls even under parallel branches.
- [ ] **Canvas UX & Validation**: Verify wave badges render cleanly in UI without setting dirty state, and `checkFlowValidation` catches unlinked `{{node}}` references and parallel state-key write conflicts.

### 2.3 Documentation & Rollout Checklist
- [ ] Confirm `AGENTFLOW_MAX_NODE_CONCURRENCY` is documented in `packages/server/.env.example` (including default value and `=1` sequential fallback note).
- [ ] Remove any temporary debug logs or dead legacy helpers (e.g., unused `findConditionParent`, `setupNodeDependencies`, `hasReceivedRequiredInputs` once superseded by `dependencyEngine.ts`).
- [ ] Full workspace build succeeds: `pnpm build` (covers `flowise` server and `flowise-ui` touched in Task 08).
- [ ] Full server test suite passes with zero open handles: `pnpm --filter flowise test`.
- [ ] Update `plans/agentflow-concurrent-execution/PLAN.md` task statuses to `Done`.
