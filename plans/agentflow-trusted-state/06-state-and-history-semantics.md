# Task 06: State & History Semantics

- **Status**: Not started (spec finalised in the Task 04 design review)
- **Depends On**: [05-token-only-core.md](./05-token-only-core.md)
- **Parallel with**: Task 08 (disjoint files)
- **Fixes**: F02, F03, F04, F11
- **Primary Files**:
  - `packages/components/nodes/agentflow/Start/Start.ts`
  - `packages/server/src/utils/buildAgentflow.ts` (history assembly, `resolveVariables` form source)
  - `packages/server/src/utils/agentflow/stateReconciler.ts` (ephemeral memory)
  - `packages/server/src/utils/agentflow/trustedState.ts` (history merge)
  - `packages/components/nodes/agentflow/Agent/Agent.ts`, `LLM/LLM.ts`, `utils.ts` (prepended history, `countTrailingHistoryCopy`)
  - `packages/server/test/utils/buildAgentflow/trustedState/`

---

## 1. Objective

History is the single source of truth for messages, flow state and form values live in their own token fields, and no option changes where any of them comes from.

---

## 2. Scope

- **State always carries over (TS11)**: remove Persist State from the Start node. Decide in this task (with the user) whether the input is removed with a node version bump or ignored and hidden; the Start node is a frequent upstream merge-conflict point (flow-redirect plan R5). Start values fill only keys missing from the carried state; `overrideConfig.startState` keeps merging as today.
- **Form values in their own field (TS12, TS19)**: a form submission writes the values into the token's form field; `$form.*` and the Start node read them from there; a new submission replaces them. Remove the Start record `output.form` channel.
- **Ephemeral memory dropped (TS17)**: the Start option no longer changes what nodes see; saved flows with it on are handled as Task 04 decides; flow state carries over as usual.
- **Client memory overrides blocked (TS24)**: `startEphemeralMemory`, `llmEnableMemory` and the others Task 04 confirms are ignored even where the flow allows overrides, with a warning log. VoIP flows as TS-O3 decides.
- **Request `history` (TS13, TS13a)**: new flow setting "Accept conversation history from the client" (off by default). When on and `history` is present, it is the turn's history and is saved in the token; log a warning if the token holds history whose last message is not in `history`. When off, ignore `history` with a warning log.
- **History reaches nodes only through memory (TS22)**: output of other nodes only through Add Messages, with same-turn replies as TS-O2 decides; remove the first-node prepend of `history` in Agent, LLM and Condition Agent. Keep the `a4f69051` de-duplication, now against the history the node gets through memory, and log a warning when an override repeats it.

---

## 3. Acceptance Criteria

- [ ] Failing tests for F02, F03, F04, F11 now pass.
- [ ] S04b, S05, S10a (both setting variants), S10b show exactly the intended differences in `compare.config.json`; all other scenarios unchanged.
- [ ] Existing saved flows load without errors in the UI (Start node without Persist State).
- [ ] `pnpm --filter ./packages/server build`, `pnpm --filter ./packages/server test`, components tests and the UI build green.
