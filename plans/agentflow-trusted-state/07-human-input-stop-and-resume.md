# Task 07: Human-Input Stop & Resume

- **Status**: Not started (spec finalised in the Task 04 design review)
- **Depends On**: [06-state-and-history-semantics.md](./06-state-and-history-semantics.md); design: [04 §2.4, §2.6, §2.7](./04-decision-gate-and-token-v2-design.md), decisions D4–D6, D8–D11
- **Fixes**: F05, F06, F07, F08, F09
- **Primary Files**:
  - `packages/server/src/utils/buildAgentflow.ts` (stopped records `:1016-1100`, resume `:1387-1500`, history after resume `:2135-2245`)
  - `packages/server/src/utils/agentflow/trustedState.ts` (pending resume data, rehydration, v1 upgrade)
  - `packages/server/src/utils/agentflow/stateReconciler.ts` (remove `doNotIncludeFeedbackHistory` handling)
  - `packages/server/src/utils/agentflow/faultCoordinator.ts`
  - `packages/components/nodes/agentflow/HumanInput/HumanInput.ts`
  - `packages/components/nodes/agentflow/Agent/Agent.ts` (checkpoint at the stop, rebuild on resume)
  - `packages/server/test/utils/buildAgentflow/trustedState/`

---

## 1. Objective

Stopping for human input and resuming work entirely from the token, with history recording what was asked and what the user answered, and resume data that stays small and holds no prompt.

---

## 2. Scope

- **Pending resume data (TS26, 04 §2.6)**: replace Task 05's interim `legacyExecution` with `PendingResume`: the run skeleton (node id, status, decision outcomes, loop target and max count per top-level record), referenced outputs, the slim action and `prompt` of each stopped node, the Agent checkpoint, and `executionId` / `stopMessageId` when recorded. Built by the builder at every `STOPPED` turn; on resume rehydrated into records that start the turn's executed data. Not inside history (F08); no copy of the previous records (F09). `commitExecutedDataDelta` drops every record of the resumed node id, which the skeleton rules follow.
- **Agent checkpoint (D5)**: at a tool-approval stop the Agent returns `output.resumeCheckpoint = { conversation, toolCallMessage }` (prompt after its own Messages list, history runs as `{ history: [i, j] }`); the server adds `historyLength`. On resume it rebuilds: its Messages list resolved from the current flow + `conversation` + `toolCallMessage`.
- **v1 paused tokens (D4)**: `upgradeV1` builds the skeleton from the v1 records; a stopped Agent keeps its stored checkpoint as `legacyMessages`, replayed exactly as today and carried unchanged while that Agent stays stopped.
- **Answers in history (TS15)**: the resume turn's user message is `humanInput.feedback`, else `question`, else the clicked button's label. No `doNotIncludeFeedbackHistory` state flag, no question rewriting, no `action.extra`.
- **History toggle off (D8)**: the stop turn saves only its user message, the resume turn only its reply (HumanInput with `humanInputHistoryToggle === false` as the primary stopped node, resp. the resumed node).
- **Blank stop message (F07, D9)**: a turn that ends stopped with blank content saves the primary stopped node's `prompt` as the bot message (S08 t2); nothing extra is streamed. An Agent tool-approval stop is never blank ("Attempting to use tool", `Agent.ts:2080`).
- **Failed resume (D6)**: an `ERROR` / `TERMINATED` resume turn returns the incoming token unchanged; answering again retries. Replaces the ERROR-after-STOPPED rule (`:1405-1427`).
- **Recorded rows (D10, D11)**: the resume continues the Execution row `executionId` (row records minus the resumed node's, plus the turn's own; rehydrated records excluded); the stop message's `action` is cleared by `stopMessageId`, or the row deleted when the toggle is off. No query by chat or session id.
- Parallel stops resumed one by one (S08, probes P2, P5); resume inside loops (S06 reject → loop back, P1).

---

## 3. Acceptance Criteria

- [ ] Failing tests for F05–F09 now pass.
- [ ] S06, S06b, S07, S08 show exactly the intended differences (F05–F09 entries); resumed model input has the answer between the approval prompt and the next reply; S07 t3/t5 and S08 t2 Agent resumes send today's model input (TS26-resume-input).
- [ ] Task 03's resume boundaries (S06, S06b, S07, S08, P1–P5) keep class A with v2 tokens.
- [ ] Resuming from v1 tokens captured at paused turns in `before/` (S06 t1, S07 t2, S08 t1) works, with model calls as `compare.config.json` expects.
- [ ] Sentinel count 0 in every paused v2 token not upgraded from v1; after a resume that finishes, the token has no pending data; within a paused run the skeleton grows by one entry per node run.
- [ ] `pnpm --filter ./packages/server build`, `pnpm --filter ./packages/server test` and components tests green.
