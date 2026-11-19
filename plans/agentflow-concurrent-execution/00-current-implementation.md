# Agentflow V2: Current Implementation Reference

> Baseline technical summary of how Agentflow V2 schedules and executes nodes today, with exact code references.

## 1. Request Entry & Dispatch

1. **External Route**: `packages/server/src/routes/predictions/index.ts` -> `packages/server/src/controllers/predictions/index.ts:14` (`createPrediction`).
2. **Internal Route**: `packages/server/src/routes/internal-predictions/index.ts` -> `packages/server/src/controllers/internal-predictions/index.ts:10`.
3. **Process-Level Concurrency Limit**: `packages/server/src/services/predictions/index.ts:8-14` wraps `utilBuildChatflow(req)` with `pLimit(PREDICTION_CONCURRENCY_LIMIT_PER_PROCESS || 100)`.
4. **Queue vs. Direct**: `packages/server/src/utils/buildChatflow.ts:979` (`utilBuildChatflow`) dispatches to BullMQ (`PredictionQueue.ts:103`) when `MODE === 'QUEUE'`, or calls `executeFlow` directly.
5. **Agentflow V2 Dispatch**: `packages/server/src/utils/buildChatflow.ts:471-495` checks `chatflow.type === 'AGENTFLOW'` and delegates to `executeAgentFlow` in `packages/server/src/utils/buildAgentflow.ts:1577`.

---

## 2. Core Data Structures (`packages/server/src/utils/buildAgentflow.ts`)

| Symbol | Type | Line | Role |
| :--- | :--- | :--- | :--- |
| `IWaitingNode` | interface | `66-72` | `{ nodeId, receivedInputs, expectedInputs, isConditional, conditionalGroups }` |
| `INodeQueue` | interface | `74-78` | `{ nodeId, data, inputs }` |
| `IAgentFlowRuntime` | interface | `96-100` | `{ state?, chatHistory?, form? }` |
| `graph` / `nodeDependencies` | `Record<string, string[]>` / `INodeDependencies` | `1630` | Forward adjacency list and in-degree counts via `constructGraphs` (`utils/index.ts:155`) |
| `reversedGraph` | `Record<string, string[]>` | `1631` | Incoming parent adjacency list via `constructGraphs(..., { isReversed: true })` |
| `agentFlowExecutedData` | `IAgentflowExecutedData[]` | `1677` | Append-only array of executed nodes, outputs, and statuses |
| `nodeExecutionQueue` | `INodeQueue[]` | `1682` | FIFO queue of nodes ready to execute |
| `waitingNodes` | `Map<string, IWaitingNode>` | `1683` | Pending join/merge nodes waiting for remaining upstream inputs |
| `loopCounts` | `Map<string, number>` | `1684` | Per-`loopAgentflow` iteration counter bounded by `MAX_LOOP_COUNT` (line `152`, default `10`) |

---

## 3. Execution Lifecycle in `executeAgentFlow` (`buildAgentflow.ts:1577-2497`)

### 3.1 Setup & Seeding
- **Parse & Filter** (`1626-1631`): Parses `chatflow.flowData`, strips `stickyNoteAgentflow`, builds `graph`, `nodeDependencies`, `reversedGraph`.
- **State / Form Persistence** (`1696-1794`): If `startPersistState === true` or `startInputType === 'formInput'`, lazily loads `previousExecution` from DB or client `trustedState` and restores `agentflowRuntime.state` / `agentflowRuntime.form`.
- **Human-in-the-Loop Resume** (`1796-1901`): When `humanInput` is present (and not a recursive iteration), validates previous execution is `STOPPED` (or `ERROR` right after `STOPPED`), locates `startNodeId`, prepopulates `agentFlowExecutedData`, and seeds `startingNodeIds = [startNodeId]`.
- **Fresh Start** (`1924-1940`): Calls `getStartingNode(nodeDependencies)` (`utils/index.ts:213`, in-degree `0`), creates DB `Execution` via `addExecution` (`205-245`), and pushes each start node onto `nodeExecutionQueue`.

### 3.2 Serial Execution Loop (`2022-2235`)
```typescript
while (nodeExecutionQueue.length > 0 && status === 'INPROGRESS') {
    if (iterations++ > maxIterations) throw new Error('Maximum iteration limit reached')
    const currentNode = nodeExecutionQueue.shift()
    // ... abort check
    const executionResult = await executeNode({ ... })
    if (executionResult.shouldStop) {
        status = 'STOPPED'
        break
    }
    agentFlowExecutedData.push({ ... })
    // ... SSE nextAgentFlow + agentFlowExecutedData
    // ... overwrite agentflowRuntime.state = nodeResult.state
    // ... append agentflowRuntime.chatHistory
    const processResult = await processNodeOutputs({ ... })
}
```

### 3.3 Single Node Execution (`executeNode`, `1091-1543`)
1. Streams `INPROGRESS` via `sseStreamer?.streamNextAgentFlowEvent` (`1147-1151`).
2. Dynamically imports node implementation from `componentNodes[name].filePath` (`1154-1156`).
3. Clones `agentflowRuntime.state` into `flowConfig.state` (`1170-1195`) and resolves `{{...}}` templates via `resolveVariables` (`307-688`, called at `1198-1211`).
   - Node output references (`{{nodeId.output.path}}` and `{{nodeId}}`, lines `451-500`) look up the latest matching record in `agentFlowExecutedData`.
4. Reads `humanInputAction` from `agentFlowExecutedData[agentFlowExecutedData.length - 1]` (`1217-1220`).
5. Computes `isLastNode` (`1234-1236`):
   `!isRecursive && (!graph[nodeId] || graph[nodeId].length === 0 || (!humanInput && reactFlowNode.data.name === 'humanInputAgentflow'))`.
6. Builds `runParams` (`1253-1283`) — **note**: passes live `agentflowRuntime` reference at line `1275`!
7. Calls `await newNodeInstance.run(reactFlowNodeData, finalInput, runParams)` (`1286`).
8. If `iterationAgentflow` (`1289-1437`): executes child subflow recursively in a sequential `for` loop per item.
9. If `humanInputAgentflow` (without `humanInput`, `1440-1489`) or `agentAgentflow` with `isWaitingForHumanInput` (`1492-1536`): pushes a `STOPPED` record, streams `STOPPED` + `action`, and returns `{ shouldStop: true }`.

### 3.4 Downstream Scheduling (`processNodeOutputs`, `887-989`)
1. Calls `determineNodesToIgnore` (`847-882`) — marked `async` despite containing no `await`s; inspects `result.output.conditions` on decision nodes (`conditionAgentflow`, `conditionAgentAgentflow`, `humanInputAgentflow`) and returns immediate `ignoreEdge.target` IDs.
2. For each non-ignored `childId` in `graph[nodeId]`:
   - Initializes `waitingNode` via `setupNodeDependencies` (`720-762`) if absent, using `getNodeInputConnections` (`701-715`) and `findConditionParent` (`767-813`).
   - Records `waitingNode.receivedInputs.set(nodeId, result)` (`933`).
   - Evaluates `hasReceivedRequiredInputs(waitingNode)` (`818-837`): requires all `expectedInputs` AND at least one source from each group in `conditionalGroups`.
   - If ready, deletes from `waitingNodes` and pushes `{ nodeId: childId, data: combineNodeInputs(...), inputs: ... }` onto `nodeExecutionQueue` (`939-944`).
3. If `loopAgentflow` (`958-986`): increments `loopCounts` and pushes `result.output.nodeID` back onto `nodeExecutionQueue` if under `maxLoopCount`.

### 3.5 Finalization (`2237-2496`)
- Derives final `status` by scanning `agentFlowExecutedData` for `TERMINATED` / `ERROR` / `STOPPED` (`2238-2250`).
- Persists execution via `updateExecution` (`254-305`, optionally offloaded to `executionsWorker.ts`).
- Extracts final content from **`agentFlowExecutedData[agentFlowExecutedData.length - 1].data?.output`** (`2269-2270`).
- Runs optional post-processing (`2273-2316`), saves `ChatMessage` rows (`2374-2435`), updates `trustedState`, and returns response.

---

## 4. Known Concurrency & Correctness Hazards

1. **Premature Loop Exit**: `while (nodeExecutionQueue.length > 0)` exits as soon as ready items are dispatched, before in-flight promises settle.
2. **State Clobbering**: `agentflowRuntime.state = nodeResult.state` overwrites sibling updates; `runParams.agentflowRuntime` exposes the shared object reference directly to concurrent nodes.
3. **`waitingNodes` Interleaving**: `processNodeOutputs` is `async` (unnecessarily awaiting `determineNodesToIgnore`), allowing concurrent completions to interleave reads/writes on `waitingNodes`.
4. **Condition Pruning & Multi-Parent Join Bugs**:
   - `determineNodesToIgnore` only prunes immediate targets (`ignoreEdge.target`), leaving multi-hop unfulfilled branches dangling.
   - `findConditionParent` uses `edges.find((edge) => edge.target === currentId)`, ignoring all incoming edges except the first.
   - `loopAgentflow` back-edges do not reset stale `waitingNodes` state.
5. **Non-Deterministic Final Output & Streaming Collisions**:
   - `agentFlowExecutedData[length - 1]` is non-deterministic under concurrency.
   - Multiple terminal nodes all see `isLastNode === true` and stream interleaved tokens to the same `chatId`.
6. **Fault & Stop Coordination**:
   - `break` on `shouldStop` or `throw` on error does not coordinate sibling in-flight tasks, multi-node `STOPPED` checkpoints, or concurrent `updateExecution` calls.
   - `humanInputAction` lookup at `1218` also relies on `agentFlowExecutedData[length - 1]`.
