# Task 02: Diff-Based Atomic State Merge & Runtime Isolation

- **Status**: Done
- **Design Status**: Ready to implement (Decision **D3** resolved)
- **Depends On**: [01-test-harness-and-refactor-seams.md](./01-test-harness-and-refactor-seams.md)
- **Primary Files**:
  - `packages/server/src/utils/agentflow/stateReconciler.ts` (new)
  - `packages/server/src/utils/buildAgentflow.ts`
  - `packages/server/test/utils/buildAgentflow/stateReconciler.test.ts` (new)

---

## 1. Objective

Prevent concurrent node executions from clobbering each other's updates to `agentflowRuntime` (`state`, `chatHistory`, `form`, and side-effect flags) by:
1. Passing each node execution an **isolated runtime snapshot** so in-flight nodes cannot mutate shared runtime state in place.
2. Computing a **per-key state diff** (added, modified, and deleted keys) between the node's start snapshot and returned `nodeResult.state`, then applying only that delta atomically to live `agentflowRuntime.state` on completion.

---

## 2. Current Behavior & Code References

In `packages/server/src/utils/buildAgentflow.ts`:
- `executeNode` clones `agentflowRuntime.state` into `updatedState` (`L1170`) for `flowConfig.state` (`L1181`), **but** passes the live shared `agentflowRuntime` object into `runParams` (`L1275`)!
  - Nodes like `LLM.ts:376` (`options.agentflowRuntime?.state`) and `CustomFunction.ts` (`$flow.state`) read `agentflowRuntime.state`. If any node mutates `options.agentflowRuntime.state` in place, it corrupts sibling nodes and breaks snapshot diffing.
- On node completion in `executeAgentFlow` (`L2130-L2159`):
  - `agentflowRuntime.state = nodeResult.state` (`L2131`) — **whole-object overwrite!** If Branch A sets `{ a: 1 }` and Branch B sets `{ b: 2 }` from `{}` concurrently, the second finisher erases the first branch's key.
  - `agentflowRuntime.chatHistory = [...(agentflowRuntime.chatHistory ?? []), ...nodeResult.chatHistory]` (`L2135`) — safe only if committed atomically without replacing concurrent appends.
  - `agentflowRuntime.form = nodeResult.output.form` (`L2139`)
  - `ephemeralMemory` (`L2142-L2147`) and `doNotIncludeFeedbackHistory` (`L2148-L2159`) mutate `pastChatHistory`, `trustedData.pastChatHistory`, and `incomingInput.question`.
- Note also `iterationAgentflow` (`L1404-L1421`) merges `subFlowResult.agentflowRuntime.state` via shallow spread (`{ ...updatedState, ...subFlowResult.agentflowRuntime.state }`).

---

## 3. Detailed Design

### 3.1 Isolated Runtime Snapshot per Node Launch
Before invoking `executeNode`:
- Capture an immutable snapshot of state:
  ```typescript
  const startStateSnapshot = cloneDeep(agentflowRuntime.state ?? {})
  ```
- Construct an isolated `nodeRuntimeSnapshot: IAgentFlowRuntime`:
  ```typescript
  const nodeRuntimeSnapshot: IAgentFlowRuntime = {
      state: cloneDeep(startStateSnapshot), // distinct clone so in-place mutations inside run() cannot affect startStateSnapshot
      chatHistory: cloneDeep(agentflowRuntime.chatHistory ?? []),
      form: cloneDeep(agentflowRuntime.form ?? {})
  }
  ```
- Pass `nodeRuntimeSnapshot` (NOT live `agentflowRuntime`) into `executeNode` / `runParams`.

### 3.2 Pure State Diff & Atomic Commit (`stateReconciler.ts`)
Create `packages/server/src/utils/agentflow/stateReconciler.ts` with pure, well-tested functions:

```typescript
export interface IStateDelta {
    upserted: Record<string, any> // keys added or modified relative to startSnapshot
    deleted: string[]             // keys present in startSnapshot that are absent in endState
}

export function computeStateDelta(
    startSnapshot: ICommonObject,
    endState: ICommonObject | undefined
): IStateDelta

export function applyStateDelta(
    liveState: ICommonObject,
    delta: IStateDelta
): ICommonObject
```

#### Diff Semantics:
1. If `endState` is `undefined` or `null`, return empty delta `{ upserted: {}, deleted: [] }` (node did not return state -> no changes).
2. **Upserted keys**: For each own enumerable key `k` in `endState`:
   - If `!(k in startSnapshot)` OR `!isEqual(startSnapshot[k], endState[k])`:
     - `delta.upserted[k] = cloneDeep(endState[k])`
3. **Deleted keys**: For each own enumerable key `k` in `startSnapshot`:
   - If `!(k in endState)`:
     - `delta.deleted.push(k)`
4. **Apply**:
   - Create/update live state synchronously:
     - For each `k` in `delta.deleted`: `delete nextState[k]`
     - For each `[k, v]` in `Object.entries(delta.upserted)`: `nextState[k] = v`
5. **Special flag cleanup**: Handle `doNotIncludeFeedbackHistory` cleanly so deleting it after processing (`L2158`) does not leak into live `agentflowRuntime.state`.

#### Reconciling Other `agentflowRuntime` Fields on Commit:
- `chatHistory`: Append `nodeResult.chatHistory` onto live `agentflowRuntime.chatHistory` synchronously during the commit phase.
- `form`: Merge/assign `nodeResult.output.form` if present.
- `agentFlowExecutedData`: Push node result record synchronously in the same commit phase (note: `executeNode` should return delta executed data, e.g. from `iterationAgentflow` subflows, rather than mutating/replacing the shared `agentFlowExecutedData` array reference concurrently!).
  - **Important check**: Currently `executeNode` returns `agentFlowExecutedData` and `executeAgentFlow:2096` does `agentFlowExecutedData = executionResult.agentFlowExecutedData`! Under concurrency, replacing the array reference would wipe out entries pushed by sibling nodes! Refactor so `executeNode` returns `additionalExecutedData?: IAgentflowExecutedData[]` (or records deltas) and the scheduler commits them synchronously to the single canonical `agentFlowExecutedData` array.
  - Also check `humanInput` filtering at `L1226`: `agentFlowExecutedData = agentFlowExecutedData.filter((execData) => execData.nodeId !== nodeId)` — move this removal to a synchronous helper before/during commit so it never drops concurrent entries.

---

## 4. Implementation Steps

1. Implement `computeStateDelta`, `applyStateDelta`, and `reconcileRuntimeCommit` in `packages/server/src/utils/agentflow/stateReconciler.ts`.
2. Update `executeNode` in `packages/server/src/utils/buildAgentflow.ts`:
   - Accept isolated `nodeRuntimeSnapshot` and pass it into `runParams.agentflowRuntime` and `flowConfig.state`.
   - Avoid replacing the shared `agentFlowExecutedData` array reference inside `executeNode`; return incremental subflow/stopped records for the caller to commit cleanly.
3. Update the completion section of `executeAgentFlow` to call `computeStateDelta(startStateSnapshot, nodeResult?.state)` and `applyStateDelta(agentflowRuntime.state, delta)`.
4. Write thorough unit tests in `packages/server/test/utils/buildAgentflow/stateReconciler.test.ts` and integration tests with `executeAgentFlow`.

---

## 5. Edge Cases & Invariants

- **In-place mutation inside a node**: Because `nodeRuntimeSnapshot.state` is a separate clone from `startStateSnapshot`, even if a `CustomFunction` mutates `$flow.state.x = 2` directly in place and returns `$flow.state`, `startStateSnapshot.x` remains untouched and the diff accurately detects the change!
- **Nested object updates**: Top-level key diff via `lodash.isEqual` detects nested modifications (e.g., `state.user.name` changed -> key `user` is in `upserted`). Document clearly that conflict granularity is top-level state keys (last-finisher-wins if two concurrent branches modify the exact same top-level key).
- **Explicit `undefined` vs deleted key**: Distinguish `Object.prototype.hasOwnProperty.call(endState, k)` vs `endState[k] === undefined`.
- **Sequential `iterationAgentflow`**: Verify nested iteration state merging (`L1404-L1421`) continues to pass updated state from iteration `i` to iteration `i + 1` and back to parent.

---

## 6. Acceptance Criteria & Verification

- [x] Unit tests verify `computeStateDelta` & `applyStateDelta` for: disjoint parallel writes, key deletions, unchanged keys, nested value edits, conflicting key LWW, and `undefined` `nodeResult.state`.
- [x] Parallel-simulation test proves Branch A writing `{ a: 1 }` and Branch B writing `{ b: 2 }` from the same initial snapshot both survive in `agentflowRuntime.state` (`{ a: 1, b: 2 }`).
- [x] In-place mutation inside a mock node does not corrupt `startStateSnapshot` or sibling nodes' `runParams.agentflowRuntime`.
- [x] `agentFlowExecutedData` never loses entries when `executeNode` returns subflow or humanInput data.
- [x] `pnpm --filter flowise build` and `pnpm --filter flowise test -- test/utils/buildAgentflow` pass.
