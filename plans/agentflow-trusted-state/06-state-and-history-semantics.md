# Task 06: State & History Semantics

- **Status**: Not started (spec finalised in the Task 04 design review)
- **Depends On**: [05-token-only-core.md](./05-token-only-core.md); design: [04 §2](./04-decision-gate-and-token-v2-design.md), decisions D7, D13–D16
- **Parallel with**: Task 08 (disjoint files)
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

- [ ] Failing tests for F02, F03, F04, F11 now pass (F11 as revised in Task 04).
- [ ] S03, S04b, S05, S09, S10a (both setting variants), S10b show exactly the intended differences in `compare.config.json` (F02, F03, F04, F11, TS25 entries); all other scenarios unchanged.
- [ ] Existing saved flows load without errors in the UI; a saved Start 1.1 node and an Agent/LLM with `userMessage` show the update badge and sync to the new inputs.
- [ ] `pnpm --filter ./packages/server build`, `pnpm --filter ./packages/server test`, components tests and the UI build green.
