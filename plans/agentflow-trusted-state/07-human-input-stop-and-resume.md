# Task 07: Human-Input Stop & Resume

- **Status**: Not started (spec finalised in the Task 04 design review)
- **Depends On**: [06-state-and-history-semantics.md](./06-state-and-history-semantics.md)
- **Fixes**: F05, F06, F07, F08, F09
- **Primary Files**:
  - `packages/server/src/utils/buildAgentflow.ts` (stopped records `:1016–1100`, resume `:1383–1500`, history after resume `:2135–2205`)
  - `packages/server/src/utils/agentflow/trustedState.ts` (pending resume data)
  - `packages/server/src/utils/agentflow/stateReconciler.ts` (remove `doNotIncludeFeedbackHistory` handling)
  - `packages/server/src/utils/agentflow/faultCoordinator.ts`
  - `packages/components/nodes/agentflow/HumanInput/HumanInput.ts`
  - `packages/components/nodes/agentflow/Agent/Agent.ts` (prompt rebuilt on resume, TS26)
  - `packages/server/test/utils/buildAgentflow/trustedState/`

---

## 1. Objective

Stopping for human input and resuming work entirely from the token, with history recording what was asked and what the user answered, and resume data that stays small and does not grow.

---

## 2. Scope

- **Answers in history (TS15)**: the resume turn's user message is the feedback text, otherwise the button label. History toggle off: neither the approval prompt nor the answer is saved. No `doNotIncludeFeedbackHistory` state flag, no question rewriting, no `action.extra`.
- **Pending resume data (TS26, TS19)**: only what TS26 and [field-inventory.md](./field-inventory.md) §6 list, in the pending field, and the stopped Agent rebuilds its prompt on resume; not inside history (F08) and not by copying the previous records into the new turn (F09). Today `commitExecutedDataDelta` drops every record of the resumed node id, not only the stopped one (Task 03).
- **Recorded chat messages (TS21)**: when chat message recording is on, clear the saved `action` of the stopped turn's bot message on resume by its id (kept in the pending data), without reading the table.
- **Empty stopped-turn replies (F07)**: what is saved as the bot message when an Agent stops for a tool approval.
- Parallel stops resumed one by one (S08); resume inside loops (S06 reject → loop back).
- **v1 tokens paused at an approval** before the deploy: upgraded on read, then resumed.

---

## 3. Acceptance Criteria

- [ ] Failing tests for F05–F09 now pass.
- [ ] S06, S06b, S07, S08 show exactly the intended differences; resumed model input has the answer between the approval prompt and the next reply.
- [ ] Resuming from v1 tokens captured at paused turns in `before/` (S06 turn 1, S07 turn 2, S08 turn 1) works, with model calls as `compare.config.json` expects.
- [ ] Token size of a chained stop/resume conversation does not grow with the number of stops.
- [ ] `pnpm --filter ./packages/server build`, `pnpm --filter ./packages/server test` and components tests green.
