# Task 03: Concurrent Event-Driven Scheduler Loop

- **Status**: Pending
- **Design Status**: Ready to implement (Decision **D1** resolved)
- **Depends On**:
  - [01-test-harness-and-refactor-seams.md](./01-test-harness-and-refactor-seams.md)
  - [02-diff-based-atomic-state-merge.md](./02-diff-based-atomic-state-merge.md)
- **Primary Files**:
  - `packages/server/src/utils/agentflow/scheduler.ts` (new)
  - `packages/server/src/utils/agentflow/schedulerHelpers.ts`
  - `packages/server/src/utils/buildAgentflow.ts`
  - `packages/server/.env.example`
  - `packages/server/test/utils/buildAgentflow/concurrentScheduler.test.ts` (new)

---

## 1. Objective

Replace the strictly sequential `while (nodeExecutionQueue.length > 0 && status === 'INPROGRESS')` loop in `executeAgentFlow` with an **event-driven concurrent scheduler** that:
- Executes independent ready DAG branches concurrently, bounded by a configurable per-flow concurrency limit (`AGENTFLOW_MAX_NODE_CONCURRENCY` + `p-limit`).
- Tracks both queued nodes and in-flight promises so the loop terminates only when **both** `nodeExecutionQueue` and `inFlightTasks` are empty (or a stop/error condition terminates scheduling).
- Performs all scheduler state transitions (`waitingNodes`, `nodeExecutionQueue`, `agentFlowExecutedData`, `agentflowRuntime`, `loopCounts`) **synchronously** in the commit phase to eliminate microtask interleaving races.
- Keeps `iterationAgentflow` loops sequential (per Decision D1).

---

## 2. Current Behavior & Code References

- Main execution loop in `packages/server/src/utils/buildAgentflow.ts:2022-2235`:
  - `while (nodeExecutionQueue.length > 0 && status === 'INPROGRESS')` (`L2022`)
  - Shifts a single node (`L2034`), awaits `executeNode` (`L2050`), commits results (`L2113-L2159`), and awaits `processNodeOutputs` (`L2161`).
- Unnecessary `async` in scheduling helpers:
  - `determineNodesToIgnore` (`L847-L882`) is declared `async Promise<string[]>` even though it contains **zero** `await` expressions.
  - `processNodeOutputs` (`L887-L989`) only `await`s `determineNodesToIgnore` (`L912`).
  - Removing `async`/`await` from both makes the entire output-processing and `waitingNodes` update path strictly synchronous in JS's single-threaded event loop — completely preventing read-modify-write races on `waitingNodes`!

---

## 3. Detailed Design

### 3.1 Configuration
Introduce env var `AGENTFLOW_MAX_NODE_CONCURRENCY`:
- Parse helper:
  ```typescript
  const rawLimit = Number.parseInt(process.env.AGENTFLOW_MAX_NODE_CONCURRENCY || '', 10)
  const maxNodeConcurrency = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 10 // default e.g. 10
  ```
- Setting `AGENTFLOW_MAX_NODE_CONCURRENCY=1` acts as a clean, deterministic sequential fallback without needing a separate execution engine.
- Document in `packages/server/.env.example` under `EXTRA RUNTIME OPTIONS`.

### 3.2 Make `determineNodesToIgnore` and `processNodeOutputs` Synchronous
In `packages/server/src/utils/agentflow/schedulerHelpers.ts`:
- Change `determineNodesToIgnore(...)` from `async (...): Promise<string[]>` to synchronous `(...): string[]`.
- Change `processNodeOutputs(...)` from `async (...): Promise<{ humanInput?: IHumanInput }>` to synchronous `(...): { humanInput?: IHumanInput }`.
- This guarantees that when two sibling nodes finish concurrently, their completion callbacks execute atomically one-after-another on the JS event loop with zero interleaving on `waitingNodes`, `nodeExecutionQueue`, or `loopCounts`.

### 3.3 Event-Driven Concurrent Scheduler (`scheduler.ts`)
Encapsulate the scheduling loop in a dedicated reusable coordinator (e.g. `runConcurrentNodeScheduler` in `packages/server/src/utils/agentflow/scheduler.ts`) with clean hooks:

```typescript
// Core scheduling invariant:
// Continue pumping whenever ready nodes exist AND capacity is available.
// Terminate only when inFlightTasks.size === 0 && (nodeExecutionQueue.length === 0 || !canScheduleMore())
```

Execution flow:
1. Initialize:
   - `const limit = pLimit(maxNodeConcurrency)` (or explicit `inFlightTasks.size < maxNodeConcurrency` gate — note: an explicit `inFlightTasks: Set<Promise<void>>` gate with `maxNodeConcurrency` avoids queuing already-popped promises inside `p-limit`, ensuring `startStateSnapshot` is captured at actual **launch time**, not early dequeue time! Capture `startStateSnapshot` right when a slot is free and the node actually begins running!).
   - **Important insight**: If we shift a node while `inFlightTasks.size === maxNodeConcurrency` and wrap it in `p-limit`, we would capture a stale `startStateSnapshot` before earlier nodes finish! Instead, either:
     - Gate `nodeExecutionQueue.shift()` on `inFlightTasks.size < maxNodeConcurrency` (preferred — snapshot is always fresh at actual start time), OR
     - Capture `startStateSnapshot` *inside* the `limit(async () => { ... })` callback.
     Using `p-limit` + capturing snapshot inside `limit(...)` or gating shift directly ensures state snapshots reflect all previously completed nodes.
2. Pump loop:
   ```typescript
   await new Promise<void>((resolve, reject) => {
       const schedule = () => {
           // Pump ready nodes while scheduling is active and capacity remains
           while (
               canScheduleMore() &&
               nodeExecutionQueue.length > 0 &&
               inFlightTasks.size < maxNodeConcurrency
           ) {
               if (iterations++ > maxIterations) {
                   handleFatalError(new Error('Maximum iteration limit reached'))
                   return
               }
               const currentNode = nodeExecutionQueue.shift()!
               launchNode(currentNode)
           }

           if (inFlightTasks.size === 0 && (nodeExecutionQueue.length === 0 || !canScheduleMore())) {
               finish()
           }
       }

       const launchNode = (currentNode: INodeQueue) => {
           const task = (async () => {
               // 1. Capture fresh startStateSnapshot & nodeRuntimeSnapshot
               // 2. Await executeNode(...)
               // 3. Synchronously commit state delta, agentFlowExecutedData, SSE events
               // 4. Synchronously run processNodeOutputs(...) to enqueue newly ready children
           })()
               .catch((err) => {
                   // Delegate to fault coordinator hook (Task 06 refines policy)
                   handleNodeError(currentNode, err)
               })
               .finally(() => {
                   inFlightTasks.delete(task)
                   schedule()
               })

           inFlightTasks.add(task)
       }

       schedule()
   })
   ```
3. **Hooks for Future Open-Design Tasks (04, 05, 06)**:
   - Keep `canScheduleMore()`, `handleNodeError()`, `handleNodeStopped()`, and `selectTerminalOutput()` as explicit, cleanly separated hooks/callbacks in the scheduler so Tasks 04, 05, and 06 can plug in their finalized designs without rewriting the core scheduler loop!
   - For interim behavior before Tasks 05/06 are finalized:
     - Preserve existing behavior on single-branch flows.
     - On error: record error, stop scheduling new nodes, wait for `inFlightTasks` to settle before rejecting (no orphaned unhandled rejections!).
     - On `shouldStop`: stop scheduling new nodes (or defer to Task 06 hook), wait for `inFlightTasks` to settle cleanly before returning.

### 3.4 First-Iteration SSE Event
- Currently `L2026`: `if (iterations === 0 && !isRecursive) sseStreamer?.streamAgentFlowEvent(chatId, 'INPROGRESS')`.
- Emit `INPROGRESS` once before the first node launches (not gated on a race-prone counter check inside async tasks).

---

## 4. Implementation Steps

1. Make `determineNodesToIgnore` and `processNodeOutputs` synchronous in `schedulerHelpers.ts`.
2. Implement `runConcurrentNodeScheduler` in `packages/server/src/utils/agentflow/scheduler.ts`.
3. Wire `executeAgentFlow` in `packages/server/src/utils/buildAgentflow.ts` to use `runConcurrentNodeScheduler` and `AGENTFLOW_MAX_NODE_CONCURRENCY`.
4. Add `AGENTFLOW_MAX_NODE_CONCURRENCY` documentation to `packages/server/.env.example`.
5. Add unit tests in `packages/server/test/utils/buildAgentflow/concurrentScheduler.test.ts`.

---

## 5. Edge Cases & Invariants

- **No unhandled promise rejections**: Every task added to `inFlightTasks` must handle errors inside `.catch(...)` and settle before the outer scheduler promise rejects.
- **No premature exit**: When `Start` forks into `A` and `B`, `nodeExecutionQueue` drops to length `0` immediately after both launch, while `inFlightTasks.size === 2`. Scheduler MUST NOT resolve until `A`, `B`, and their downstream `Join` node all finish.
- **Fresh state snapshots**: When concurrency limit is `2` and `3` nodes (`A`, `B`, `C`) are ready, `C` must NOT snapshot state until either `A` or `B` finishes and frees a slot.
- **No duplicate concurrent launch of same nodeId** unless explicitly triggered by a loop back-edge (guard/log warning if the same `nodeId` is already in-flight).
- **`iterationAgentflow`**: Continues running items sequentially in its `for` loop (`L1323`), while parallel nodes *inside* a single iteration subflow can benefit from the same scheduler (sharing or inheriting `maxNodeConcurrency`).
- **`maxIterations` accounting**: Incremented synchronously at node launch time so runaway concurrent loops cannot bypass `maxIterations`.

---

## 6. Acceptance Criteria & Verification

- [ ] **True concurrency proof**: Fork `Start -> [A, B] -> Join` where `A` and `B` both wait on a mutual barrier (deadlocks if sequential; resolves immediately if concurrent!) succeeds when `AGENTFLOW_MAX_NODE_CONCURRENCY >= 2`.
- [ ] **Concurrency bound proof**: Fork `Start -> [A, B, C, D] -> Join` with `AGENTFLOW_MAX_NODE_CONCURRENCY=2` never exceeds `maxObservedActive === 2`.
- [ ] **Sequential fallback proof**: With `AGENTFLOW_MAX_NODE_CONCURRENCY=1`, `maxObservedActive === 1` and all baseline tests pass identically.
- [ ] **Fresh snapshot proof**: With limit `1` (or queued node `C` waiting on `A`), `C` observes state written by `A`.
- [ ] **Zero orphaned promises**: Error in `A` while `B` is in-flight waits for `B` to settle without Jest `--detectOpenHandles` warnings or unhandled rejections.
- [ ] `pnpm --filter flowise build` and `pnpm --filter flowise test -- test/utils/buildAgentflow` pass.
