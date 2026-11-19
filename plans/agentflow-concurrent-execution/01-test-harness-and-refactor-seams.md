# Task 01: Test Harness & Refactor Seams

- **Status**: Pending
- **Design Status**: Ready to implement
- **Depends On**: [00b-baseline-flows-and-traces.md](./00b-baseline-flows-and-traces.md) (recommended before refactoring so baseline traces reflect unmodified `master`)
- **Primary Files**:
  - `packages/server/src/utils/buildAgentflow.ts`
  - `packages/server/src/utils/agentflow/` (new internal helper directory)
  - `packages/server/test/utils/buildAgentflow/` (new Jest test suite)

---

## 1. Objective

Create clean, zero-behavior-change refactor seams around Agentflow V2's scheduling, dependency resolution, and node execution logic, and establish a fast, deterministic Jest unit test harness with controllable async mock nodes.

Currently, `packages/server/src/utils/buildAgentflow.ts` (~2,500 lines) has **zero** unit tests, and its internal helpers (`processNodeOutputs`, `setupNodeDependencies`, `findConditionParent`, `hasReceivedRequiredInputs`, `determineNodesToIgnore`, `combineNodeInputs`, `executeNode`) are unexported private functions tightly coupled to TypeORM, Express SSE, and dynamic `import(filePath)` calls.

---

## 2. Current Behavior & Code References

- Private types and functions in `packages/server/src/utils/buildAgentflow.ts`:
  - `IWaitingNode`, `INodeQueue`, `IProcessNodeOutputsParams`, `IAgentFlowRuntime` (`L66-L100`)
  - `getNodeInputConnections`, `setupNodeDependencies`, `findConditionParent`, `hasReceivedRequiredInputs`, `determineNodesToIgnore`, `processNodeOutputs`, `combineNodeInputs` (`L701-L1089`)
  - `executeNode` (`L1091-L1543`) — dynamically imports `componentNodes[name].filePath` (`L1154-L1156`) and queries `appDataSource.getRepository(Variable)` (`L1167`).
  - `executeAgentFlow` (`L1577-L2497`) — mixes DB persistence, SSE streaming, trusted state, and the `while` scheduling loop.
- Existing test runner configuration: `packages/server/package.json:50` (`jest --runInBand --detectOpenHandles --forceExit`).

---

## 3. Detailed Design

### 3.1 Extract Pure Module Seams
Create `packages/server/src/utils/agentflow/` with modular, unit-testable units (preserving exact existing behavior in this task):
1. `packages/server/src/utils/agentflow/types.ts`
   - Move/export `IWaitingNode`, `INodeQueue`, `IProcessNodeOutputsParams`, `IAgentFlowRuntime`, and new scheduler/state interfaces.
2. `packages/server/src/utils/agentflow/schedulerHelpers.ts` (initial lift-and-shift of existing dependency helpers)
   - Export `getNodeInputConnections`, `setupNodeDependencies`, `findConditionParent`, `hasReceivedRequiredInputs`, `determineNodesToIgnore`, `processNodeOutputs`, `combineNodeInputs`.
3. **Optional injectable node runner seam** in `executeAgentFlow` / `executeNode` (or test-only hook / mockable `componentNodes` fixture files):
   - Allow tests to execute arbitrary synthetic Agentflow V2 graphs with mock nodes that:
     - Resolve after a controlled delay (e.g., `delayMs` or manual deferred promises `createDeferred()`).
     - Record exact `startTime`, `endTime`, and max observed concurrency.
     - Read/write/delete keys on `state`, append `chatHistory`, emit SSE tokens, trigger `conditions`, trigger `shouldStop` (HumanInput), or reject with controlled errors.
   - Keep production `executeAgentFlow` signature 100% backwards-compatible.

### 3.2 Jest Test Harness (`packages/server/test/utils/buildAgentflow/`)
Create test utilities:
- `testHelpers.ts`:
  - Graph builder DSL (`createFlow(nodes, edges)`) generating valid `IReactFlowObject` JSON strings for `chatflow.flowData`.
  - Mock `appDataSource` (in-memory stubs for `Execution`, `ChatMessage`, `Variable` repositories so tests run in milliseconds with zero DB setup).
  - Mock `sseStreamer` recording all emitted events in chronological order (`events: Array<{ type, chatId, data }>`).
  - Controlled-timing mock node factory (using deferred promises / barriers to deterministically trigger specific completion orderings and race conditions, avoiding flaky `setTimeout`-only assertions).
- `baseline.test.ts` (loading or mirroring the JSON flow fixtures from `plans/agentflow-concurrent-execution/baselines/flows/` captured in Task 00b so Jest tests and live baseline captures stay aligned):
  - Linear chain (`Start -> A -> B`)
  - Fork + Join (`Start -> [A, B] -> Join`)
  - Simple conditional branch (`Start -> Condition -> [TrueBranch, FalseBranch] -> Join`)
  - State propagation (`Start -> SetA -> ReadA`)
  - Loop node (`Start -> A -> Loop -> A`, stops at `maxLoopCount`)
  - HumanInput pause & resume (`STOPPED` -> resume with `humanInput`)
  - Error propagation (`ERROR` status + SSE error event)

---

## 4. Implementation Steps

1. Inspect `packages/server/jest.config.js` (or root Jest config) and run existing tests to confirm the baseline Jest environment works cleanly.
2. Extract shared Agentflow V2 internal types to `packages/server/src/utils/agentflow/types.ts` and dependency/output helpers to `packages/server/src/utils/agentflow/schedulerHelpers.ts`, re-importing them in `packages/server/src/utils/buildAgentflow.ts`.
3. Add a clean, minimal seam for injecting or mocking node execution in tests without polluting production call sites.
4. Implement `packages/server/test/utils/buildAgentflow/testHelpers.ts` and `baseline.test.ts`.
5. Run `pnpm --filter flowise build` and `pnpm --filter flowise test -- test/utils/buildAgentflow`.

---

## 5. Edge Cases & Invariants

- **Zero behavioral change**: Task 01 must NOT change execution order, state handling, or external API signatures.
- **No flaky timers**: Prefer deferred-promise barriers (`barrier.resolve()`) over wall-clock `setTimeout` assertions when testing interleavings; use wall-clock checks only with generous bounds or fake timers where appropriate.
- **No external network/DB dependencies**: All tests in `test/utils/buildAgentflow/` must run offline and fast (<2s total).

---

## 6. Acceptance Criteria & Verification

- [ ] `packages/server/src/utils/agentflow/types.ts` and `schedulerHelpers.ts` cleanly extracted and imported by `buildAgentflow.ts`.
- [ ] `pnpm --filter flowise build` succeeds with zero TypeScript errors.
- [ ] `pnpm --filter flowise test -- test/utils/buildAgentflow` passes all baseline scenarios.
- [ ] Existing server test suite (`pnpm --filter flowise test`) remains green.
