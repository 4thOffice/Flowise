# Task 06: State & History Semantics

- **Status**: Done (2026-11-23; results and decisions taken here in §4)
- **Depends On**: [05-token-only-core.md](./05-token-only-core.md); design: [04 §2](./04-decision-gate-and-token-v2-design.md), decisions D7, D13–D16
- **Parallel with**: none; Task 08 runs after it (shared characterization tests and components build in one checkout)
- **Fixes**: F02, F03, F04, F11; TS25 for Agent and LLM
- **Primary Files**:
  - `packages/components/nodes/agentflow/Start/Start.ts`
  - `packages/components/nodes/agentflow/Agent/Agent.ts`, `LLM/LLM.ts`, `utils.ts` (prepend removal, override trim, Return Response As)
  - `packages/server/src/utils/buildAgentflow.ts` (state and form at turn start, `$form.*` source)
  - `packages/server/src/utils/agentflow/stateReconciler.ts` (ephemeral memory)
  - `packages/server/src/utils/agentflow/trustedState.ts` (turn history selection)
  - `packages/ui/src/ui-component/extended/ClientState.jsx` (TS13a switch), `packages/ui/src/utils/genericHelper.js` (`updateOutdatedNodeData`)
  - `packages/server/test/utils/buildAgentflow/trustedState/`

---

## 1. Objective

History is the single source of truth for messages, flow state and form values live in their own token fields, and no option changes where any of them comes from.

---

## 2. Scope

- **State always carries over (TS11, D14)**: remove `startPersistState` from the Start node (version 1.1 → 1.2); the turn starts from `flowState` with an enabled `startState` override over it (not on resume turns), and the Start node merges the carried keys over its defaults unconditionally (04 §2.5): override > carried > defaults, as S04a today.
- **Form values in their own field (TS12)**: `agentflowRuntime.form = incomingInput.form ?? formValues`; the Start node's `output.form` and `$form.*` read it; the builder writes it back. The Start record `output.form` channel goes.
- **Ephemeral memory dropped (TS17, D14)**: remove `startEphemeralMemory` from the Start node (same version bump); stored values are ignored; the Start node no longer returns `ephemeralMemory` and the reconciler branch (`stateReconciler.ts:182-187`) goes; a flow that still has it on logs one warning per turn.
- **Client overrides (D13)**: no override is blocked; overrides apply as today where the flow enables them. `startEphemeralMemory` has nothing left to change.
- **Request `history` (TS13, TS13a, D7, 04 §2.7)**: `clientState.acceptClientHistory` (off by default) and its `ClientState.jsx` switch "Accept conversation history from the client". On: the client history is the turn history (`historySource: 'client'`) and is saved in the token; warning when the token's last message (role, trimmed content) is not in it. Off: `history` ignored with a warning. Resume turns ignore `history` with a warning (D7). The harness key is already `{ clientState: { acceptClientHistory: true } }`.
- **History reaches nodes only through memory (TS22)**: remove the first-node prepend in Agent and LLM (`Agent.ts:1003-1013`, `LLM.ts:404-414`; Condition Agent has none) and the `prependedChatHistory` run param.
- **Overrides that repeat the history (D16)**: in Agent and LLM, before an `agentMessages` / `llmMessages` override is used, remove a tail that repeats the turn history (`countTrailingHistoryCopy`) with a warning when the node has memory on or `historySource` is `'client'`; a memory-off node fed from the token history keeps the override as sent (VoIP). The question rule and the runtime-history input messages use the trimmed array (04 §2.7).
- **Same-turn replies (TS25, D15)**: a reply appended to the runtime history is an `assistant` message. Remove the User Message option from Agent (3.2 → 3.3) and LLM (1.1 → 1.2), default Assistant Message; at runtime any value but `ignore` means assistant. `updateOutdatedNodeData` replaces a stored value of a static `options` input that the new definition no longer offers with the input's default (also used by Task 08's Execute Flow).

---

## 3. Acceptance Criteria

- [x] Failing tests for F02, F03, F04, F11 now pass (F11 as revised in Task 04).
  - In `findings: target behaviour` (`characterization.test.ts`), F02's five tests, F03, F04 and F11 changed from `test.failing` to `test`, and they pass. F02 runs the S10a accept-on variant.
  - F05–F07, F09, F10, F18 and F19 still fail as intended; F17 is a todo.
- [x] S03, S04b, S05, S09, S10a (both setting variants), S10b show exactly the intended differences in `compare.config.json` (F02, F03, F04, F11, TS25 entries); all other scenarios unchanged.
  - `before/ traces` (`characterization.test.ts`): every scenario × mode × turn of `traces/before/` matches, except these listed differences:
    - M1/S03 t1–t4 and M1/S09 t1, t3 (TS25): exactly the captured requests, with each same-turn reply as an assistant message.
    - M1/S04b t2–t4 (F03): requests, text, nodes, state.
    - M1/S05 t4 and M3/S05 t4 (F04): requests.
    - M1/S10a t1–t4, setting off (F02): requests.
    - S10a@accept-client-history-on t1–t4 (F02), compared with the same `before/` trace: requests and token history.
    - M1/S10b t2–t3 (F11): requests and token history.
    - Every listed turn differs; Task 05's F14 and F01 entries are unchanged.
  - `compare.config.json checks`: every check of F02-S10a-accept-on, F02-S10a-accept-off, F03-S04b-state-carries, F04-S05-new-form-wins (M1, M3), F11-S10b-ephemeral-dropped, TS25-S03-composer and TS25-S09-aggregator passes on the harness turns.
- [x] Existing saved flows load without errors in the UI; a saved Start 1.1 node and an Agent/LLM with `userMessage` show the update badge and sync to the new inputs.
  - Isolated server (`baselines/start-server.sh`, port 3100) on this build, with the saved S10b, S03 and S05 flows (Start 1.1, Agent 3.2 and LLM 1.1 with `userMessage`).
  - The flows load with no console or server errors, and the Start, Agent and LLM nodes show the outdated badge.
  - Sync Nodes and Save store Start 1.2 without `startPersistState` / `startEphemeralMemory`; Flow State, input type and form inputs are kept.
  - They store Agent 3.3 and LLM 1.2 with `assistantMessage`; memory settings and messages are kept.
  - The new switch saves `clientState.acceptClientHistory: true`, also on a flow that had no saved config (§4.2, decision 8).
- [x] `pnpm --filter ./packages/server build`, `pnpm --filter ./packages/server test`, components tests and the UI build green.
  - Builds: `pnpm --filter flowise-components build`, `pnpm --filter ./packages/server build`, `pnpm --filter flowise-ui build`.
  - Server tests: 18 suites, 453 passed + 1 todo, 69 snapshots.
  - Components tests: 7 suites, 96 passed.

---

## 4. Results

### 4.1 Code

- **Start node** (1.2): Persist State and Ephemeral Memory are gone; the carried state keys go over the node's defaults unconditionally; `output.form` is `agentflowRuntime.form`; no `ephemeralMemory` or `persistState` output.
- **`trustedState.ts`**: `readTurnInput(incomingInput, { acceptClientHistory })` chooses the turn history (04 §2.7) and returns `historySource`. With the setting on, the request `history` (role, content) is the turn history and the token keeps it; a warning when the token's last message (role, trimmed content) is not in it. With the setting off, or on a resume turn (D7), `history` is ignored with a warning. `formValues = incomingInput.form ?? token formValues`.
- **`buildAgentflow.ts`**: `agentflowRuntime.form` is the turn's form values in every run, iteration runs included, and `$form.*` reads it. A top-level turn that is not a resume starts from `flowState` with an enabled `startState` override over it. One warning per top-level turn when the saved Start node still has Ephemeral Memory on. `historySource` is a run param; `prependedChatHistory` is gone.
- **`stateReconciler.ts`**: the Start `output.form` channel and the `ephemeralMemory` branch are removed.
- **Agent (3.3) and LLM (1.2)**: the first-node prepend is removed. `trimTrailingHistoryCopy` (`nodes/agentflow/utils.ts`) removes the tail of the message list that repeats the turn history, with a warning, when the node has memory on or `historySource` is `'client'`. The question rule and the runtime-history input messages use the trimmed list. Return Response As offers Assistant Message (default) and Do not append to chat history; any other stored value appends an assistant message. `countTrailingHistoryCopy` also reads node-form roles (`user` / `assistant`).
- **UI**: `updateOutdatedNodeData` keeps the new default for an Agentflow V2 `options` input whose stored value the new version no longer offers. `ClientState.jsx` has the "Accept conversation history from the client" switch (`clientState.acceptClientHistory`). The dialog now also starts from an empty config when the flow has never saved one; before, all three switches were dropped there.

### 4.2 Decisions taken in this task (for the plan session)

None changes model input beyond `compare.config.json`.

1. **Withdrawn options sync only for Agentflow V2 nodes** (category Agent Flows). Chatflow nodes keep stored values as before, per `AGENTS.md`.
2. **Form values for every flow**: `agentflowRuntime.form = incomingInput.form ?? formValues` is not gated by the Start input type (04 §2.5). Iteration items now see the carried values on a chat turn; before, `$form.*` there saw only the turn's own submission. No scenario exercises it.
3. **`startState` override without a token**: applied at turn start whenever the flow enables it. Task 05 applied it only with a token, but the result is the same: without a token, the override already replaced the Start node's defaults.
4. **Start `output.form`**: `{}` on a form-start turn with neither a submission nor carried values. Before, it held the question string. Nothing reads it for model input.
5. **D16 scope**: the trim runs on the node's whole message list, the configured messages plus the appended override, as the LLM de-duplication did. It runs in every Agent and LLM node, not only the first one.
6. **Ephemeral warning**: top-level turns only, from the saved Start node value. An override has nothing left to change.
7. **Invalid `history` field**: a request whose `history` fails validation still fails, even with the setting off (unchanged).
8. **Client State dialog on a flow without a saved config**: the switches now save there. Before, a first toggle was lost (the dialog saved `{}`).

Observation for Task 10's node-sync rollout item (not changed here): the canvas shows the Sync Nodes button only when the node definitions are already loaded when the flow arrives. That happens with in-app navigation; after a full page load the button can stay hidden, while the per-node outdated badges always show (`Canvas.jsx` `checkIfSyncNodesAvailable`).

### 4.3 Tests changed

- `characterization.test.ts`:
  - F02 (5 tests), F03, F04 and F11 changed from `test.failing` to `test`.
  - `before/ traces` lists intended differences per aspect: requests, status, text, nodes, state, action, history. Every other aspect must match `before/`, and every listed turn must differ.
  - For TS25, the turn must send exactly the captured requests, with each same-turn reply (a user message named after its node) turned into an assistant message.
  - The S10a accept-on variant is compared with the plain `before/` trace.
  - New `compare.config.json checks` block: evaluates the checks of the F02 (both variants), F03, F04, F11 and TS25 entries on harness turns, with `compare-traces.mjs` semantics.
  - S10b is no longer exempt from "the next turn depends on the token".
- `characterization.expected.ts`: S04b t2–t4 now as S04a; S10b history `uaua` / `uauaua` and token sizes 452 / 573 bytes. Snapshots updated for S03 t1–t4, S04b t2–t4, S05 t4, S09 t1 and t3, S10a t1–t4, S10b t2 and t3, in a run of the whole file. S03's parallel replies keep the order of `before/`, which a filtered run reverses.
- `fieldRemoval.test.ts`, which records what each removed field changes:
  - History removal now also changes S10b t2.
  - Flow state removal also changes S04b t2–t4.
  - Form values removal no longer changes S05 t3, whose new form replaces them.
- `codec.test.ts`: `historySource` in the turn input; turn-history choice (TS13, TS13a, D7, empty `history`) and form replacement (TS12).
- Older engine suites:
  - `publicInterface`: state carries over without Persist State.
  - `concurrentScheduler`: the sibling-isolation test shortens the shared history with the remaining `doNotIncludeFeedbackHistory` flag; Task 07 removes that flag.
  - `stateReconciler`: the iteration isolation test no longer passes `prependedChatHistory`.
- Components: `LLM.test.ts` rewritten for D16 and TS25. New `Agent.test.ts` covers the same for Agent; new `Start.test.ts` covers Start 1.2.
