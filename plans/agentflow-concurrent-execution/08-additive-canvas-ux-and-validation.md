# Task 08: Additive Canvas UX & Concurrency Validation

- **Status**: Pending (Ready to implement — Decision **D7** resolved)
- **Depends On**:
  - [04-dag-joins-condition-pruning-and-loops.md](./04-dag-joins-condition-pruning-and-loops.md)
  - [00b-baseline-flows-and-traces.md](./00b-baseline-flows-and-traces.md) (optional visual reference for before/after screenshots)
- **Primary Files**:
  - `packages/server/src/services/validation/index.ts`
  - `packages/ui/src/views/agentflowsv2/executionOrder.js` (new)
  - `packages/ui/src/views/agentflowsv2/AgentFlowNode.jsx`
  - `packages/ui/src/views/agentflowsv2/Canvas.jsx`
  - `packages/ui/src/views/chatmessage/ValidationPopUp.jsx` (verify rendering only; likely no changes needed)
  - `packages/server/test/utils/buildAgentflow/validation.test.ts` (new)

---

## 1. Objective

Give Agentflow V2 designers clear visibility into **execution order, parallel waves, and potential concurrency hazards** on the canvas and in the flow validation checklist — while keeping saved flows **100% backwards-compatible** (zero required schema changes or migrations).

---

## 2. Current Behavior & Code References

- **Server Flow Validation**: `packages/server/src/services/validation/index.ts`
  - `checkFlowValidation(flowId, workspaceId)` (`L16-L324`) checks disconnected nodes, missing required inputs, and hanging edges, returning `IValidationResult[]` (`{ id, label, name, issues }`).
- **UI Validation Display**: `packages/ui/src/views/chatmessage/ValidationPopUp.jsx`
  - `validateFlow` (`L53-L84`) calls `validationApi.checkValidation(chatflowid)`.
  - `L191-L253` renders every `item` in `previews` with its `item.issues` list styled as `#FFB938` checklist alerts — new server validation warnings surface automatically with zero UI changes.
- **Agentflow V2 Canvas & Nodes**:
  - `packages/ui/src/views/agentflowsv2/Canvas.jsx` renders `<ReactFlow>` (`L706-L765`) with toggle buttons inside `<Controls>` (`L727-L756`, e.g., snapping and background toggles).
  - `packages/ui/src/views/agentflowsv2/AgentFlowNode.jsx` renders the execution status badge around `L275-L305` (`data.status`).

---

## 3. Detailed Design

### 3.1 Backwards Compatibility Guarantee
- Zero breaking schema changes: existing saved `flowData` JSON files require **no** new fields or migrations.
- Execution wave/step metadata is derived deterministically from existing `(nodes, edges)` topology and `node.position.y`.

### 3.2 Read-Only Execution Wave / Order Overlay on Canvas
1. **Pure Client Graph Helper (`packages/ui/src/views/agentflowsv2/executionOrder.js`)**:
   - Mirror Task 04's longest-path topological leveling algorithm:
     - Exclude `stickyNoteAgentflow` nodes.
     - Identify reachable nodes from in-degree-0 start nodes (`level = 0`).
     - Compute `level(v) = max_{u -> v} (level(u) + 1)` via Kahn topological order.
     - Group nodes by `level` (wave `1, 2, ...` using 1-based display indices) and sort siblings in the same wave by `(node.data?.executionOrder ?? node.position?.y ?? 0, node.id)`.
   - Assign display labels:
     - Single node in wave `k`: `Step k` (or `Wave k`).
     - Multiple nodes (`N > 1`) in wave `k`: `Step k.1 (Parallel)`, `Step k.2 (Parallel)` (or `Wave k · Parallel`), visually showing concurrent fan-out and join points!
     - Unreachable / disconnected nodes: `Unreachable` (no wave number).
2. **Canvas Toggle (`Canvas.jsx`)**:
   - Add an optional toggle button inside `<Controls>` (`L727-L756`, following the existing `isSnappingEnabled` / `isBackgroundEnabled` pattern; local UI toggle state or `localStorage`, defaulting to `true` or toggleable on/off cleanly without marking the flow dirty!).
   - Pass computed badge info to nodes via a lightweight context or derived node prop (making sure **never** to mutate persisted `nodes` `data` in ReactFlow state on read-only view, so opening a flow doesn't trigger unsaved-changes prompts!).
3. **Node Badge (`AgentFlowNode.jsx`)**:
   - Render a subtle, compact pill/chip (e.g. `Wave 2 · Parallel` or `#2.1`) anchored cleanly (avoiding overlap with the `data.status` circle at `top: -10, right: -10` around `L275-L305`, e.g. top-left corner or subtle header tag) with tooltip explaining *"Runs concurrently with other Wave 2 nodes"*.

### 3.3 Concurrency-Aware Flow Validation (`packages/server/src/services/validation/index.ts`)
Scope concurrency checks to Agentflow V2 (`flow.type === 'AGENTFLOW'`, ignoring `stickyNoteAgentflow`):

1. **Unlinked Variable Reference Warning**:
   - Scan node `inputs` (including nested arrays/objects and condition fields) for template references matching `/{{(.*?)}}/g` (same pattern as `buildAgentflow.ts:347`).
   - Extract referenced node IDs (`{{nodeId}}` and `{{nodeId.output.path}}`, ignoring built-ins like `question`, `$vars.*`, `$flow.*`, `$form.*`, `$iteration.*`, `chat_history`, `file_attachment`, `current_date_time`, `loop_count`, `runtime_messages_length`).
   - If the referenced `sourceNodeId` exists in `nodes`, check whether `sourceNodeId` is a **strict DAG ancestor** of the current node (reachability via `reversedGraph`).
   - If NOT an ancestor (e.g., sibling branch or unrelated node): emit issue:
     - `"References output from '<label>' (${sourceNodeId}), which is not an upstream ancestor. Under concurrent execution, this node may run before '${label}' finishes — connect an edge from '${label}' to guarantee ordering."`
2. **Concurrent State-Key Write Conflict Warning**:
   - Inspect `startState` and `*UpdateState` input arrays (`llmUpdateState`, `agentUpdateState`, `customFunctionUpdateState`, `loopUpdateState`, etc.) to map each node to the top-level `state` keys it writes.
   - For any pair of nodes `(A, B)` writing the same state key `k`:
     - Skip if `A` is an ancestor of `B` or `B` is an ancestor of `A` (ordered execution).
     - Skip if `A` and `B` are **mutually exclusive** (optional/best-effort check: e.g., separated cleanly under different outgoing handles of a common single-choice `conditionAgentflow` / `conditionAgentAgentflow` without sharing another parallel path).
     - Otherwise emit warning on both nodes:
       - `"Shares runtime state key '${k}' with potentially concurrent node '${otherLabel}'. Disjoint keys merge safely, but concurrent writes to the same key follow last-finisher-wins."`
3. **Multiple Terminal Nodes Notice**:
   - Identify reachable content-bearing terminal nodes (out-degree 0, excluding `stickyNoteAgentflow`; or all out-degree 0 nodes).
   - If `> 1` content-producing terminal nodes exist (e.g. `DirectReply`, `LLM`, `Agent`), add an informational checklist entry explaining execution/stream order (sorted by `executionOrder ?? position.y` as fallback, streamed consecutively separated by `\n\n`, and which node runs first if both finish together).

### 3.4 Optional Phase-2 Additive Editing Hook (Future-Friendly)
- Support an optional numeric `data.executionOrder` property on node data in both `compareNodesDeterministically` (Task 04) and `executionOrder.js` (this task):
  - Default when `undefined`: falls back to `node.position?.y ?? 0`.
  - Can be exposed later as an optional field in `EditNodeDialog.jsx` without any migration or breaking change to existing flows.

---

## 4. Implementation Steps

1. Implement `packages/ui/src/views/agentflowsv2/executionOrder.js` and add unit tests if UI test runner supports it (or verify logic parity with `dependencyEngine.ts`'s `computeTopologicalLevels`).
2. Add the toggleable wave/order overlay in `packages/ui/src/views/agentflowsv2/Canvas.jsx` and `AgentFlowNode.jsx`, ensuring toggling does **not** mark the canvas dirty or alter saved `flowData`.
3. Extract/implement concurrency validation helpers in `packages/server/src/services/validation/` and integrate into `checkFlowValidation` when `flow.type === 'AGENTFLOW'`.
4. Verify `ValidationPopUp.jsx` renders the new warnings cleanly without regressions.
5. Write Jest tests in `packages/server/test/utils/buildAgentflow/validation.test.ts`.
6. Run `pnpm build` across workspace (`flowise` server + `flowise-ui`) and `pnpm --filter flowise test`.
7. Capture post-change canvas wave-badge and validation-checklist screenshots of the baseline flows from `plans/agentflow-concurrent-execution/baselines/flows/` into `plans/agentflow-concurrent-execution/baselines/screenshots/after/` for direct visual comparison against `screenshots/before/`.

---

## 5. Edge Cases & Invariants

- **Zero Dirty Flag on Read**: Opening an existing Agentflow V2 flow and toggling the execution-wave overlay MUST NOT call `setDirty()` or mutate persisted `flowData`.
- **No False Positives on Valid Sequential Dependencies**: If `A -> B` and `B` references `{{A.output.text}}` or both write state key `foo`, validation MUST NOT warn because `A` is an ancestor of `B`.
- **Non-AGENTFLOW Flows Untouched**: `checkFlowValidation` concurrency checks only run when `flow.type === 'AGENTFLOW'`.
- **Disconnected Nodes**: Disconnected nodes on canvas should display as `Unreachable` in the overlay rather than crashing topological leveling (`NaN` or infinite loop).

---

## 6. Acceptance Criteria & Verification

- [ ] `executionOrder.js` computes identical topological levels and deterministic wave sorting as `dependencyEngine.ts` (`computeTopologicalLevels`).
- [ ] `Canvas.jsx` + `AgentFlowNode.jsx` display toggleable wave badges (`Step 1`, `Step 2.1 (Parallel)`, `Step 2.2 (Parallel)`) cleanly without overlapping status icons or triggering unsaved changes.
- [ ] `checkFlowValidation` detects:
  - Unlinked `{{nodeId}}` / `{{nodeId.output...}}` references to non-ancestor nodes.
  - Concurrent writes to the same top-level `state` key across unordered sibling branches (while staying silent on ordered `A -> B` writes).
  - Multiple terminal nodes notice.
- [ ] `packages/server/test/utils/buildAgentflow/validation.test.ts` passes.
- [ ] Full workspace build (`pnpm build`) and server tests (`pnpm --filter flowise test`) succeed.
- [ ] Post-change canvas wave-badge and validation-checklist screenshots saved to `plans/agentflow-concurrent-execution/baselines/screenshots/after/` matching the `screenshots/before/` baseline set.
