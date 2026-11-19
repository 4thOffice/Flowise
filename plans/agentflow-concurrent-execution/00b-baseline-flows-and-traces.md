# Task 00b: Baseline Agentflows V2 Capture (Flows, Traces, & Screenshots)

- **Status**: Done (Captured on unmodified `master` before Task 01 / any code edits)
- **Depends On**: [00-current-implementation.md](./00-current-implementation.md)
- **Primary Outputs**:
  - `plans/agentflow-concurrent-execution/baselines/flows/*.json` (importable Agentflow V2 JSON definitions)
  - `plans/agentflow-concurrent-execution/baselines/traces/before/*.json` (wall-clock timing, REST/SSE event streams, `agentFlowExecutedData`, errors/timeouts)
  - `plans/agentflow-concurrent-execution/baselines/screenshots/before/*.png` (canvas layout & validation popup screenshots on unmodified UI)
  - `plans/agentflow-concurrent-execution/baselines/README.md` (baseline findings summary & before/after comparison table)

---

## 1. Objective

Capture a concrete, reproducible **pre-change baseline** on the unmodified `master` branch before touching any production code:
1. Build 6 importable Agentflow V2 JSON flows that run **100% locally with zero LLM API keys or external HTTP services**, using only built-in deterministic nodes.
2. Execute them against a running local Flowise instance to record exact baseline `durationMs`, REST/SSE event traces, `agentFlowExecutedData`, and observed bugs/deadlocks.
3. Capture baseline UI screenshots (canvas topology and `ValidationPopUp` checklist) for direct before/after visual comparison in Tasks 07 and 08.

---

## 2. Local Zero-API-Key Design Constraint

Every baseline flow MUST run without external credentials using strictly local Agentflow V2 components:
- `startAgentflow`: Entry node, optional initial `startState` key-value pairs.
- `customFunctionAgentflow` (`packages/components/nodes/agentflow/CustomFunction/CustomFunction.ts`):
  - Executes sandboxed JavaScript with `await new Promise((r) => setTimeout(r, ms))` for deterministic delays.
  - Supports `customFunctionUpdateState` (`L116-L137`, `L221-L223`) and `$flow.state` reads (`L168`) for testing state clobbering vs. diff merging.
  - Supports live token streaming via `streamOutput` (`L201-L212`) when `isLastNode === true`.
- `conditionAgentflow` (`packages/components/nodes/agentflow/Condition/Condition.ts`): Deterministic `string` / `number` / `boolean` branching.
- `directReplyAgentflow` (`packages/components/nodes/agentflow/DirectReply/DirectReply.ts`): Deterministic terminal or intermediate message outputs & token emission (`L43-L50`).
- `humanInputAgentflow`: Deterministic `STOPPED` checkpoint & `humanInputAction` Approve/Reject flow.
- `loopAgentflow` (`packages/components/nodes/agentflow/Loop/Loop.ts`): Deterministic cycle back to `loopBackToNode` bounded by `maxLoopCount`.

---

## 3. Curated Baseline Flow Suite (6 Flows)

Store all 6 flow definitions under `plans/agentflow-concurrent-execution/baselines/flows/`:

| # | Filename | Topology & Nodes | Baseline Behavior / Bug Exposed |
| :--- | :--- | :--- | :--- |
| **01** | `01-parallel-fork-join-timing-and-state.json` | `Start` (`state: { a: '', b: '' }`) -> fork `[CustomFunction A (250ms, sets state.a), CustomFunction B (250ms, sets state.b)]` -> Join `DirectReply` (`{{$flow.state.a}} / {{$flow.state.b}}`) | Exposes **~500ms sequential wall-clock time** (target `~250ms`) and **state overwrite clobbering** (`state.a` overwritten when `B` commits `agentflowRuntime.state = nodeResult.state`). |
| **02** | `02-multi-hop-and-nested-conditions.json` | `Start` -> `Cond1` -> (`True`: `Cond2 -> [CustomFunction A, CustomFunction B] -> Join`, `False`: `F1 -> F2 -> Join`) + `Start -> ParallelNode -> Join` | Directly reproduces **Task 04 Topologies A & D**: multi-hop skipped branches (`F1 -> F2`) and nested conditions (`Cond1 -> Cond2`) deadlocking `Join` / leaving unpruned `waitingNodes`. |
| **03** | `03-condition-multi-edge-fanout.json` | `Start` -> `Condition` with **2 target nodes** (`DirectReply A`, `DirectReply B`) both wired to the unfulfilled `Else` output handle | Directly reproduces the **`edges.find` bug** (`buildAgentflow.ts:873`): the 1st target on the unfulfilled handle is ignored, but the **2nd target mistakenly executes**. |
| **04** | `04-multi-terminal-streaming-and-silent-leaf.json` | `Start` -> fast `DirectReply` (`"I'm looking up the data..."`) + `Start` -> `CustomFunction` (300ms) -> `DirectReply` (`"Here is the result."`) + `Start` -> slow silent `CustomFunction` (450ms, returning `""`) leaf | Directly reproduces **Task 05**: sequential terminal execution and **`agentFlowExecutedData[length - 1]`** (`buildAgentflow.ts:2269`) overwriting/blanking final `content` when the silent leaf finishes last. |
| **05** | `05-human-input-with-companion-text.json` | `Start` -> `CustomFunction` (200ms) -> `DirectReply` (`"Review summary..."`) AND `Start` -> `HumanInput` (`"Approve?"`) -> `DirectReply` (`"Approved!"`) | Directly captures **Task 06**: premature `STOPPED` loop break (`buildAgentflow.ts:2105-2108`) dropping companion text (or running non-deterministically) plus baseline resume trace. |
| **06** | `06-loop-over-parallel-subgraph.json` | `Start` -> fork `[CustomFunction A (150ms), CustomFunction B (150ms)]` -> `Condition` (`{{loop_count}} < 2`) -> `Loop` back to fork entry vs. `DirectReply` exit | Captures baseline `loopAgentflow` timing across iterations, `loop_count` propagation, and `agentFlowExecutedData` trace. |

---

## 4. Capture Procedure (Unmodified `master`)

1. **Confirm Clean Baseline**: Verify workspace is on unmodified `master` with zero production `.ts` / `.jsx` edits.
2. **Import / Seed Flows Locally**: Start the local Flowise server (`packages/server`) and import the 6 JSON flows from `baselines/flows/` (creating Agentflow V2 `ChatFlow` rows with `type = 'AGENTFLOW'`).
3. **Capture Execution Traces (`baselines/traces/before/`)**:
   - Write a small reproducible capture script (e.g., `baselines/capture-traces.mjs` or `ts-node` script) that invokes `/api/v1/prediction/:id` (or `internal-prediction`) for each flow in both `streaming: true` and `streaming: false` modes (including the `humanInput` resume turn for Flow 05, and a bounded request timeout for any deadlocking flow like Flow 02).
   - Record per-flow JSON artifacts containing:
     - `durationMs`, HTTP status, error/timeout details (if any)
     - Ordered SSE event timeline (`event`, `data`, `offsetMs`)
     - Final JSON response (`text`, `executionId`, `action`, `agentFlowExecutedData`)
4. **Capture Canvas & Validation Screenshots (`baselines/screenshots/before/`)**:
   - Open each of the 6 flows in the unmodified Flowise UI (`Agentflow V2` canvas).
   - Save a canvas screenshot (`<flow-id>-canvas.png`) and a `ValidationPopUp` checklist screenshot (`<flow-id>-validation.png`).
5. **Summarize Findings (`baselines/README.md`)**:
   - Document observed baseline results (wall-clock durations, missing state keys, mistaken executions, blanked outputs, stopped behavior) with empty **"After"** columns ready to be populated in Tasks 07 and 08.

---

## 5. Edge Cases & Invariants

- **Bounded Timeout on Known Deadlocks**: Flow 02 may fail to invoke `Join` or stall/exit early without executing expected nodes depending on branch taken; run all captures with an explicit timeout and test both `Cond1 = True` and `Cond1 = False` inputs if needed to surface every failure mode.
- **Zero Production Edits**: Do not modify any `.ts` or `.jsx` source files while capturing baselines.
- **Repeatable Artifacts**: Keep `baselines/flows/*.json` clean and self-contained (strip workspace-specific secrets/tokens if exported from UI) so Task 01 (`baseline.test.ts`) and Task 07 (`integration.test.ts`) can load them directly as fixtures.

---

## 6. Acceptance Criteria & Verification

- [x] All 6 flow JSON fixtures exist in `plans/agentflow-concurrent-execution/baselines/flows/` and contain zero LLM/external API dependencies.
- [x] All baseline prediction traces (REST + SSE + `agentFlowExecutedData` + timings) are captured in `plans/agentflow-concurrent-execution/baselines/traces/before/`.
- [x] Canvas & validation screenshots on unmodified UI are saved in `plans/agentflow-concurrent-execution/baselines/screenshots/before/`.
- [x] `plans/agentflow-concurrent-execution/baselines/README.md` records exact baseline metrics and failure observations ready for before/after comparison.
