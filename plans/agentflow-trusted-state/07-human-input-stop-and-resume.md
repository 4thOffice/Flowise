# Task 07: Human-Input Stop & Resume

- **Status**: Done (2026-11-23; results and decisions taken here in §4)
- **Depends On**: [06-state-and-history-semantics.md](./06-state-and-history-semantics.md); design: [04 §2.4, §2.6, §2.7](./04-decision-gate-and-token-v2-design.md), decisions D4–D6, D8–D11
- **Fixes**: F05, F06, F07, F08, F09
- **Primary Files** (line references from before Tasks 05–08):
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

- **Pending resume data (TS26, 04 §2.6)**: replace Task 05's interim `legacyExecution` with `PendingResume`: the run skeleton (node id, status, decision outcomes, loop target and max count per top-level record), referenced outputs, the slim action and `prompt` of each stopped node, the Agent checkpoint, and `executionId` / `stopMessageId` when recorded. Built by the builder at every `STOPPED` turn; on resume rehydrated into records that start the turn's executed data. Not inside history (F08); no copy of the previous records (F09). `commitExecutedDataDelta` drops every record of the resumed node id, which the skeleton rules follow. Also replace the interim `actionMessageIndex` marker and the ERROR-after-STOPPED retry that Task 05 kept (05 §4.2, items 1–2).
- **Agent checkpoint (D5)**: at a tool-approval stop the Agent returns `output.resumeCheckpoint = { conversation, toolCallMessage }` (prompt after its own Messages list, history runs as `{ history: [i, j] }`); the server adds `historyLength`. On resume it rebuilds: its Messages list resolved from the current flow + `conversation` + `toolCallMessage`.
- **v1 paused tokens (D4)**: `upgradeV1` builds the skeleton from the v1 records; a stopped Agent keeps its stored checkpoint as `legacyMessages`, replayed exactly as today and carried unchanged while that Agent stays stopped.
- **Answers in history (TS15)**: the resume turn's user message is `humanInput.feedback`, else `question`, else the clicked button's label. No `doNotIncludeFeedbackHistory` state flag, no question rewriting, no `action.extra`. Since Task 06 the `concurrentScheduler` sibling-isolation test shortens the shared history with that flag: rework or drop it (06 §4.3).
- **History toggle off (D8)**: the stop turn saves only its user message, the resume turn only its reply (HumanInput with `humanInputHistoryToggle === false` as the primary stopped node, resp. the resumed node).
- **Blank stop message (F07, D9)**: a turn that ends stopped with blank content saves the primary stopped node's `prompt` as the bot message (S08 t2); nothing extra is streamed. An Agent tool-approval stop is never blank ("Attempting to use tool", `Agent.ts:2080`).
- **Failed resume (D6)**: an `ERROR` / `TERMINATED` resume turn returns the incoming token unchanged; answering again retries. Replaces the ERROR-after-STOPPED rule (`:1405-1427`).
- **Recorded rows (D10, D11)**: the resume continues the Execution row `executionId` (row records minus the resumed node's, plus the turn's own; rehydrated records excluded); the stop message's `action` is cleared by `stopMessageId`, or the row deleted when the toggle is off. No query by chat or session id. Flip the tests Task 05 pinned with a "Task 07 (D11)" note (`faultAndHumanInput`, `publicInterface`, `integration`).
- Parallel stops resumed one by one (S08, probes P2, P5); resume inside loops (S06 reject → loop back, P1).

---

## 3. Acceptance Criteria

- [x] Failing tests for F05–F09 now pass.
  - In `findings: target behaviour` (`characterization.test.ts`), F05 (3 tests), F06, F07 and F09 changed from `test.failing` to `test` and pass; F08 passes since Task 05.
  - A fourth F05 test: later turns of S06 and S07 send exactly the history DB mode kept in `before/` M3, with the button label in place of the " " DB mode saved.
  - F18 and F19 still fail as intended (Task 09); F17 is a todo.
- [x] S06, S06b, S07, S08 show exactly the intended differences (F05–F09 entries); resumed model input has the answer between the approval prompt and the next reply; S07 t3/t5 and S08 t2 Agent resumes send today's model input (TS26-resume-input).
  - `before/ traces`: M1, M2 and M1-internal differ only in the token history (F05, F07, D8, D9), the removed `action.extra` (F06) and the model input of turns after a saved answer: S06 t3–t5, S06b t3–t4, S07 t4–t6, S08 t3–t4 (`APPROVAL_DIFFERENCES`). Status, text, nodes and state match `before/` at every turn.
  - M3/S06 and M3/S07 differ from DB mode's `before/` only in the button label and `extra` (§4.2 item 8).
  - `compare.config.json checks` pass for F05-S06, F05-S07, F05-S08, F06-S06b-toggle-off (its `actionKeysOnly` check waits for Task 09's slim action), F07-alternating-history, F07-S08-blank-stop-message, F08, F09, F13-tool-approval-pending and TS26-pending-only-while-stopped.
  - The resumed model input has the answer after the approval prompt: S06 t2's Drafter gets the question, the stop message and the feedback, as in `before/`. The F05 entries check the later turns.
  - TS26-resume-input: S07 t3 and S08 t2 send exactly the `before/` requests. S07 t5 replays the t4 prompt, which now holds t3's answer (F05); it equals DB mode's `before/` M3 with the label.
  - In `fieldRemoval.test.ts`, every Agent resume rebuilt from its checkpoint gives the outcome of replaying its stored prompt: S07 t3/t5, S08 t2, P2 t2, P4 t3, P5 t3.
- [x] Task 03's resume boundaries (S06, S06b, S07, S08, P1–P5) keep class A with v2 tokens.
  - `resumes: class A as before Task 07` (`fieldRemoval.test.ts`): every turn of the nine cases equals the outcome captured before this task (`resumeBoundaries.before.json`, at `d0afdbed`). That covers status, error, text, streamed tokens, node runs, state, action and model input.
  - The only exception is the model input of turns that read a saved answer: S06 t3–t5, S06b t3–t4, S07 t4–t6, S08 t3–t4, P2 t3, P3 t3–t5, P5 t3. The history alternates at every turn.
  - `resumes: single-field removals` on the v2 pending data change the boundaries Task 03 found for each field (§4.3).
- [x] Resuming from v1 tokens captured at paused turns in `before/` (S06 t1, S07 t2, S08 t1) works, with model calls as `compare.config.json` expects.
  - `v1 tokens paused before the deploy resume…` (`characterization.test.ts`): the resume turn sends exactly the `before/` requests; S07 t3 and S08 t2 replay the stored prompt (D4).
  - The turn writes a v2 token without a prompt, and every later turn sends the same requests and text as the v2 conversation.
- [x] Sentinel count 0 in every paused v2 token not upgraded from v1 (child tokens are encrypted inside the parent token: decode them, as the F10 tests do, 08 §4.2); after a resume that finishes, the token has no pending data; within a paused run the skeleton grows by one entry per node run.
  - `a paused token holds one skeleton entry per node run…` (S06, S06b, S07, S08 in M1, M2 and M3): 0 sentinels in every token, child tokens decoded. Pending data appears only on stopped turns; the skeleton equals the turn's node runs in order; `executionId` and `stopMessageId` only where recorded.
  - `a child flow paused for human input…`: S06 run as S12's child. The paused child token inside the parent token holds the child's pending data and no prompt.
  - `TS26-pending-only-while-stopped` holds for every scenario and mode with a `before/` trace.
- [x] `pnpm --filter ./packages/server build`, `pnpm --filter ./packages/server test` and components tests green.
  - Builds: `pnpm --filter flowise-components build`, `pnpm --filter ./packages/server build`.
  - Server tests: `pnpm --filter ./packages/server test`, 18 suites, 488 passed + 1 todo, 69 snapshots (trusted state folder: characterization 210 passed + 1 todo, codec 25, field removal 49).
  - Components tests: `pnpm --filter flowise-components test`, 8 suites, 105 passed (4 new in `Agent.test.ts`).

---

## 4. Results

### 4.1 Code

- **Pending data** (`trustedState.ts`): `PendingResume` = `{ nodes, executionId?, stopMessageId? }` with the 04 §2.6 `PendingNode` entries.
  - `buildPendingResume` writes one entry per top-level record when a turn ends `STOPPED`. An entry keeps the decision outcomes, the loop target and max count, the output paths the flow references (`findOutputReferences`), and for a stopped node the slim action (`toSlimAction`), the `prompt` and the Agent checkpoint.
  - Records rehydrated from the incoming pending data that are still present carry their entry over unchanged.
  - `rehydratePendingResume` turns the entries back into records that start the resume turn's executed data, with label and name from the current flow.
  - `upgradeV1` builds the same skeleton from v1 records (retry rule kept, the `ERROR` record dropped). A stopped v1 Agent keeps its stored prompt as `legacyMessages`; `executionId` comes from a non-`mock-` execution, `stopMessageId` from the last history message with an action.
- **Agent** (`Agent.ts`, helpers in `nodes/agentflow/utils.ts`):
  - At a tool-approval stop it returns `output.resumeCheckpoint = { conversation, toolCallMessage }`: the stored prompt after its own Messages list, with every run of exact history copies as `{ history: [i, j] }` (`toCheckpointConversation`). The server adds `historyLength`.
  - On resume it rebuilds the prompt as its Messages list resolved from the current flow + the expanded conversation (`fromCheckpointConversation`) + the tool-call message. With `legacyMessages` (rehydrated into the action, where today's code reads it) it replays them as today (D4).
- **HumanInput**: no `doNotIncludeFeedbackHistory` in state; the history toggle only decides the runtime chat history, as before.
- **Server** (`buildAgentflow.ts`):
  - The resume starts from the rehydrated records and the token's `flowState`. The ERROR-after-STOPPED retry, `legacyExecution`, `actionMessageIndex`, the question rewrite and `action.extra` are gone.
  - The answered node gets its checkpoint through `findResumeCheckpoint` (`faultCoordinator.ts`).
  - `stateReconciler.ts` no longer handles the flag or shortens the history.
- **History** (04 §2.7):
  - The resume turn's user message is the feedback, else the request `question`, else the label of the answered button from the pending action.
  - A HumanInput with the toggle off leaves no trace (D8): no stop message at its stop, no answer at its resume.
  - A stop with blank content saves the primary stopped node's prompt (D9). Only the saved message changes; the streamed text and `result.text` stay blank.
- **Failed resume** (D6): a resume that fails, thrown or ending `ERROR`/`TERMINATED`, returns the incoming token string and saves no message.
- **Recorded rows**:
  - D10: a resume with `executionId` reads the paused run's row once (`findOneBy({ id, workspaceId })`) and writes it back as its records minus the resumed node's, plus the turn's own; rehydrated records are never written. The iteration progress writes of a resume turn use the same records (`getRecordedData`). A missing row warns and the final write inserts a new one.
  - D11: the stop message's row is updated to `action: null` by `stopMessageId`, or deleted when the answered HumanInput has the toggle off.

### 4.2 Decisions taken in this task (for the plan session)

None changes model input beyond `compare.config.json` (§3 evidence).

1. **History references are exact copies.** 04 §2.6 says a run equal by (role, content) becomes a reference. Here only messages deep-equal to the history entries do, so a reference expands to exactly the message the stop sent. A message that differs in any other field is stored as it is.
2. **Resume answer fallback.** After feedback, `question` and the answered button's label, the mapping label and then `humanInput.type` are used, so no answer is saved blank.
3. **D9 changes the saved message only.** The token history and the recorded bot message get the prompt; the stream and the JSON `text` stay blank (" ").
4. **D8 and recorded rows.** At a toggle-off stop the bot message row is still recorded with its action, so the Flowise chat can show the buttons; the resume deletes it (D11). The answer of a toggle-off resume is not recorded, as in DB mode today. Rows follow the token history otherwise.
5. **D6 on both failure paths.** It also covers a resume whose run ends `ERROR`/`TERMINATED` without a thrown error. Nothing is recorded as chat messages, and the stop message keeps its action. Child flow tokens a finished Execute Flow node returned in the failed resume are dropped with the rest of the turn.
6. **D10 with the worker thread.** The paused row is read in the main thread at the start of the resume, also with `EXECUTIONS_DB_THREAD`, because the worker writes what it receives. Recorded rows after S06, S07 and S08 hold the same records as `before/` M2.
7. **v1 upgrade and references.** `readTurnInput` receives the current flow's output references, so a v1 paused token keeps the outputs the flow references (04 §2.4). Entries carried over keep the output paths of their stop.
8. **DB mode (M3) matches `before/` M3 again for S06 and S07**, except the button label: DB mode saved " " for an answer without feedback (F05). Task 05's F01 entries for M3/S06 t2–t5 and M3/S07 t3–t6 are replaced by these F05/F06 differences.
9. **`findResumeCheckpoint` needs the `STOPPED` entry.** Unlike `findResumedHumanInputAction`, it has no fallback to other records of the node. The `entry status` removal shows it (§4.3).
10. **The Execute Flow fallback and the HumanInput node** need no version bump: no input changed.

Observations for later tasks (not changed here):
- **`{{question}}` in an Agent's Messages list on resume.** D5 re-resolves the Messages list on the resume request, so `{{question}}` resolves to that request's `question`: empty for API clients, the button label or feedback from the Flowise UI. Before, the stopped turn's question was replayed. No scenario uses it. Kept by the user (PLAN TS29).
- **A v1 replay that stops again.** An Agent resumed from `legacyMessages` that asks for another approval computes its new checkpoint after the current Messages list's length. If the flow's Messages list changed while paused, the next rebuild can start one message off. That needs a token paused before the deploy and a flow edit while paused.
- **Task 09**: the `actionKeysOnly` check of `F06-S06b-toggle-off` waits for the slim action (TS20); the entry's other checks pass. A carried stopped node is announced again with its slim action (S08 t2), since the token no longer holds the full one. The D5 = D4 test (§4.3) reads the stored prompt from the stopped record's `data.input.messages` in M1 executed data; once Task 09 prunes external executed data, read it in M1-internal or from the recorded execution.
- **Task 10**: paused tokens from before the deploy keep the Agent's prompt (`legacyMessages`) until that Agent is resumed (D4).

### 4.3 Tests changed

- **`characterization.test.ts`**:
  - F05 (3 tests), F06, F07 and F09 flipped from `test.failing` to `test`. A fourth F05 test checks that later turns of S06 and S07 send exactly the history DB mode kept in `before/` M3, with the button label in place of " ".
  - `INTENDED_DIFFERENCES`: S06, S06b, S07, S08 in M1, M2 and M1-internal (`APPROVAL_DIFFERENCES`: history, the removed `extra`, model input of later turns); M3/S06 and M3/S07 as in §4.2 item 8.
  - `compare.config.json checks`: F05 (S06, S07, S08), F06 (`actionKeysOnly` left to Task 09), F07 (both entries), F08, F09, F13-tool-approval-pending and TS26-pending-only-while-stopped, with the check types they use. `'*'` modes mean the modes with a `before/` trace.
  - New block `human input stop and resume (Task 07)`: paused tokens (skeleton = node runs, no prompt, ids only where recorded); a paused child flow token inside the parent token; D6 retry; D9 prompt; D10 rows equal `before/` M2; D11 rows in M3, S06b included; v1 paused tokens from `before/`.
  - The D10 missing-row test reads `pendingResume.executionId`.
- **`characterization.expected.ts`**: S06–S08 history and actions without `extra`; token contents. Snapshots changed for S06 t3–t5, S06b t3–t4, S07 t4–t6 and S08 t3–t4 only, in a run of the whole file.
- **`codec.test.ts`**: round trip and turn input with the v2 pending data; v1 upgrade to the skeleton (with `legacyMessages` for stopped Agents, outputs the flow references, the execution id); the retry rule; new tests for the references, the skeleton, rehydration and carried entries.
- **`fieldRemoval.test.ts`** (Task 03's contract proof):
  - Resumes run on the v2 tokens the server writes. Each removal from the pending data changes the outcome at the boundaries Task 03 found for the same field:
    - pending data and entry `nodeId`: every resume;
    - Agent checkpoint: every Agent resume;
    - action id, mapping, node id and label: S08 t2, P2 t2, P5 t2;
    - prompt: those three, where the waiting node's prompt is saved;
    - referenced outputs: P3 t3/t5;
    - conditions: P5 t3;
    - loop: S06, S06b, P1 and P3 t3;
    - flow state: P3 t2/t3/t5;
    - finished entries: P1, P2, P3 t3, P3 t5.
  - New results: entry `status` also changes S06 t3, S07 t3/t5, P3 t3 and P4 t3, where the resume finds no checkpoint or button label; `elements` changes S06 t3 and P3 t3 (label) and the three re-announcements.
  - `resumes: class A as before Task 07`: every turn of S06, S06b, S07, S08 and P1–P5 equals the outcome captured before this task (`resumeBoundaries.before.json`, captured at `d0afdbed`), except model input of the later turns that read a saved answer. The history alternates at every turn.
  - `pending resume data (TS26)`: paused tokens hold only the TS26 fields and no prompt. An Agent resume rebuilt from the checkpoint gives the same outcome as replaying its stored prompt (D5 = D4) at S07 t3/t5, S08 t2, P2 t2, P4 t3 and P5 t3. Paused token sizes are pinned.
  - The TS-O1 variant tests are removed: variant (b) is what the server writes now.
- **Harness**: `tokenRecords()` reads the skeleton of a v2 token. The mock ChatMessage repositories (`testHelpers.ts`, `publicInterface.test.ts`) gained `update` and `delete`.
- **Older suites**:
  - The "Task 07 (D11)" assertions in `faultAndHumanInput`, `publicInterface` and `integration` now expect no action left.
  - Reads of `legacyExecution` read the skeleton.
  - `concurrentScheduler`'s sibling-isolation test now has a sibling empty its own history copy (06 §4.3).
  - `stateReconciler`'s flag test is removed.
- **Components**: `Agent.test.ts` covers the checkpoint at a stop, the rebuild on resume with an edited Messages list, the legacy replay, and the history references.

### 4.4 Paused token sizes (Jest, M1)

| Paused turn | v1 token, `before/` (base64) | v2 token (base64) | v2 raw JSON | Prompt sentinels |
| :--- | ---: | ---: | ---: | ---: |
| S06 t1 | 15,336 | 740 | 1,116 | 0 |
| S06 t2 | 27,816 | 892 | 1,614 | 0 |
| S06 t4 | 16,108 | 960 | 1,847 | 0 |
| S06b t1 | 15,192 | 684 | 900 | 0 |
| S06b t2 | 27,380 | 776 | 1,145 | 0 |
| S06b t4 | 15,768 | 824 | 1,139 | 0 |
| S07 t2 | 39,844 | 956 | 1,588 | 0 |
| S07 t4 | 40,516 | 1,032 | 1,971 | 0 |
| S08 t1 | 38,812 | 1,068 | 1,967 | 0 |
| S08 t2 | 15,496 | 796 | 1,176 | 0 |
| S08 t4 | 15,964 | 912 | 1,646 | 0 |

Task 05's interim paused tokens were 46–94 KB of raw JSON with 1–2 prompt copies. Task 03 estimated variant (b) at 680–972 base64 characters; the real tokens add the `prompt` of each stopped node and the tool-call message's usage, 0–10 % more.
