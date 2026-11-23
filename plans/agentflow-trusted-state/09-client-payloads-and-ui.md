# Task 09: Client Payloads & UI

- **Status**: Done (2026-11-23; results, the user's decisions and decisions taken here in §4)
- **Depends On**: [07-human-input-stop-and-resume.md](./07-human-input-stop-and-resume.md), [08-execute-flow-child-tokens.md](./08-execute-flow-child-tokens.md); design: [04 §2.9](./04-decision-gate-and-token-v2-design.md)
- **Fixes**: F17, F18, F19
- **Primary Files**:
  - `packages/server/src/utils/buildAgentflow.ts` (`action` construction `:1017-1081`, executed data hand-outs `:1829`, `:1900`, `:2004`, `:2275`)
  - `packages/server/src/utils/agentflow/trustedState.ts` or a new `clientPayloads.ts` (`toSlimAction`, `toClientExecutedData`)
  - `packages/server/src/utils/SSEStreamer.ts`, `packages/server/src/queue/RedisEventPublisher.ts` (check only: they forward what they get)
  - `packages/ui/src/views/chatmessage/ChatMessage.jsx`
  - `packages/server/test/utils/buildAgentflow/trustedState/`

---

## 1. Objective

No system prompt or other unneeded data reaches clients unencrypted, and the Flowise UI works with the token-only model.

---

## 2. Scope

- **`action`** (TS20, 04 §2.9 `SlimAction`): `executeNode` builds the slim action when a node stops (`id`, `mapping`, `elements`, `data.nodeId`, `data.nodeLabel`, and `data.input.humanInputEnableFeedback` for HumanInput only), so records, the SSE event, a saved ChatMessage and the pending data hold the same object; the stopped record keeps the full `data.input`. Task 07's pending data already stores the slim form.
- **`agentFlowExecutedData`** (TS18): `toClientExecutedData(records, isInternal)` at every hand-out: internal = full records with `_removeCredentialId` applied; external = `ExternalExecutedRecord` per record (`nodeId`, `nodeLabel`, `status`, `previousNodeIds`, `data.name`, `data.state`, error text, slim action on stopped records), same order and length. Applied inside `executeAgentFlow`, so SSE, queue mode (Redis events and job result) and the non-streaming JSON all get the pruned array. Execute Flow's Merge State reads the child's `[last].data.state` from this pruned form (S12 covers it).
- **Internal** = `isInternal` (`/internal-prediction`), unchanged; API-key callers there count as internal (04 §3 Q6).
- **UI**: approval buttons, feedback dialog and execution viewer work with the slim payloads (all read paths guard `data.input`). Decide with the user whether the internal chat keeps the token across page reloads (F17).
- Recorded executions unchanged (TS5).
- From Task 07 (07 §4.2): enable the `actionKeysOnly` check of `F06-S06b-toggle-off`, which the harness skips in `TASK_09_CHECKS`. A carried stopped node is already announced again with its slim action (S08 t2). `fieldRemoval`'s D5 = D4 test reads the stored prompt from M1's external executed data: read it from M1-internal or the recorded execution once that data is pruned.

---

## 3. Acceptance Criteria

- [x] Sentinel count 0 in every `action` payload and in external executed data; internal executed data unchanged except credential ids.
  - Jest (`characterization.test.ts`):
    - F18 and F19 flipped from `test.failing` to `test`. External records hold only `nodeId`, `nodeLabel`, `status`, `previousNodeIds` and `data.{name, state, error, output.humanInputAction}`, over SSE (S07) and JSON (S13). The action holds only the TS20 fields (S06 t1, S07 t2, S08 t1).
    - `compare.config.json checks` now run `F18-executed-data-external` (every scenario × external mode with a `before/` trace: executed data and REST JSON sentinels 0), `F18-executed-data-internal` (sentinels ≥ 1), `F19-slim-action` (S06, S06b, S07, S08 in every mode: action keys and sentinels 0) and the `actionKeysOnly` check of `F06-S06b-toggle-off`. `TASK_09_CHECKS` is gone.
    - New tests: external records keep the order, node ids, statuses, previous node ids and state of the internal records, and the stopped record holds the announced action (S07). A queue worker publishes only pruned executed data and the slim action through `RedisEventPublisher`, and its job result is pruned (S07, same turn facts as SSE). A stopped Agent carried from a v1 token is announced again with the slim action while its stored prompt stays in the token (S08, D4; §4.2 item 1).
    - Internal: the M1-internal executed data of S01 and of S07's normal turns equals the M2 recorded execution rows without `FLOWISE_CREDENTIAL_ID`; nothing else differs.
  - Live, on the isolated server (`capture-traces.mjs`, modes M1, M1-internal, M2, M3, scenarios S01, S06, S06b, S07, S08, S13; 74 turns):
    - External modes: 0 sentinels and 0 credential ids in every `action`, executed data and REST JSON payload, and in every saved ChatMessage action (M3); external records carry only `data.{name, state, output}`.
    - M1-internal: full records, 1 sentinel per turn (the Agent's system prompt in `data.input`), 0 credential ids. `before/` had 2 at the stops (the action repeated `data.input`) and a credential id in every turn.
- [x] Flowise UI checked in the browser on the isolated server: chat, approval, feedback, resume, execution viewer, reload behaviour.
  - Isolated server (`baselines/start-server.sh`, port 3100) on this build with the fake LLM; flows seeded by the capture run.
  - S07, chat messages recorded (M3 settings): t1 chat; t2 stops with Proceed/Reject. The SSE `action` is the slim action and the internal executed data has the full records without credential ids; the chat's execution viewer shows the stopped Agent's full input. After a page reload the chat shows the saved messages with their buttons, and Proceed resumes with the token restored from localStorage: the reply is "The refund is 37.50 euros." and the model input holds the whole conversation.
  - S06, chat messages recorded: Request changes opens the feedback dialog from the slim action (`humanInputEnableFeedback`), and the feedback resumes the loop. After a reload, the expanded chat view shows the saved messages, and Approve with the dialog's empty Submit resumes with the restored token; the Finalizer sees the whole conversation, the feedback included.
  - Clear Chat removes the stored token (the localStorage entry is gone).
  - S01, recording off (M1 settings): after a reload the chat shows no earlier messages, and the next question starts a new conversation (the model input holds only that question).
  - The Agent Executions page shows the recorded runs, the stopped Agent's full input included (TS5).
  - No server errors; one browser console error, a resource outside the server that timed out.
- [x] Characterization tests: class A unchanged.
  - `before/ traces`: every scenario × mode matches as before; `INTENDED_DIFFERENCES` is unchanged.
  - Snapshots: 69 passed, none updated.
- [x] `pnpm --filter ./packages/server build`, `pnpm --filter ./packages/server test` and the UI build green.
  - Builds: `pnpm --filter ./packages/server build`, `pnpm --filter flowise-ui build`. No node changed, so no components build.
  - Server tests: `pnpm --filter ./packages/server test`, 18 suites, 495 passed + 1 todo, 69 snapshots (trusted state folder: characterization 217 passed + 1 todo, codec 25, field removal 49).
  - Components tests: `pnpm --filter flowise-components test`, 8 suites, 105 passed.

---

## 4. Results

### 4.1 Code

- **Slim action** (`buildAgentflow.ts`): `executeNode` builds the HumanInput and Agent stop actions with `toSlimAction`, so the stopped record's `output.humanInputAction`, the SSE `action`, the saved ChatMessage action and the pending data hold the TS20 fields only. The stopped record keeps the full `data.input`.
- **Announced action**: the SSE `action` and the saved ChatMessage action are slimmed again when announced (§4.2 item 1).
- **Executed data** (`agentflow/clientPayloads.ts`, new): `toClientExecutedData(records, isInternal)`.
  - Internal: the records with `_removeCredentialId` applied.
  - External: an `ExternalExecutedRecord` per record, in the same order: `nodeId`, `nodeLabel`, `status`, `previousNodeIds`, `data.name`, `data.state`, `data.error` as text, and `data.output.humanInputAction` (slim) on stopped records.
  - It runs at the three streamed hand-outs (node stopped, node finished, fatal error) and for `result.agentFlowExecutedData`. Queue mode gets the pruned array from the same calls (`RedisEventPublisher` forwards what it gets) and in the job result.
  - Iteration runs still return their full records to the parent run, with credential ids removed as before. The record array is no longer replaced by its credential-free copy at the end of the turn, so `turnRecords` is gone.
- **UI** (`ChatMessage.jsx`, F17 as the user decided, §4.2): every new token is stored next to the chat id in the chat's localStorage entry (`<flowId>_INTERNAL.trustedState`). When the chat reloads its saved messages (page reload, reopening the chat, the expanded view), the token is restored if it belongs to the same chat id. With chat message recording off nothing is reloaded and a new conversation starts, as before. Clear Chat removes the entry. Approval buttons, the feedback dialog and the execution viewer needed no change: they read only the TS20 fields, or the full records of the internal chat and of recorded executions.

### 4.2 Decisions

Decisions of the user in this task:
- **F17**: the internal chat keeps the token with its saved messages (§4.1 UI). Recorded in the `F17-internal-chat-reload` compare entry.
- **Execute Flow's fallback text**: when a child flow's reply is blank, the node's output is the child's whole JSON response, which now holds the pruned records (the child call is an external `/prediction` call). This changes the parent's output only in that edge case; no scenario has it. Accepted as a consequence of TS18.
- **Flowise Evaluations**: the EvaluationRunner calls `/prediction` and reads token usage and model names from the executed data, which it no longer gets for Agentflow V2. Accepted (an ignored client, `client-inventory.md` §1); for Task 10's deploy note.

Decisions taken here (none changes model input):
1. **The announced action is slimmed again.** A stopped Agent carried from a v1 token keeps its stored prompt in the rehydrated action, where the Agent reads it for its one-time replay (D4). If another stopped node is resumed first, that Agent is announced again, so the SSE `action` and the saved ChatMessage action go through `toSlimAction`, and external records slim every stopped action. The token keeps the prompt until the Agent resumes. Tested with S08's v1 token, gate answered first; without the second slim the test fails.
2. **Recorded executions**: the stopped record's `output.humanInputAction` is the slim action there too (04 §2.9: records hold the slim object). The same input is in the record's `data.input`, so recorded executions lose only that duplicate; nothing else changes (TS5).
3. **`F19-slim-action`**: its `actionKeysOnly` check runs on t2 and t4, where all four scenarios stop; S07 t1 finishes without an action, and the check fails a turn without an action (as `compare-traces.mjs` does).
4. **Harness**: Execute Flow child calls run with `isInternal: false`, as the server routes them through `/prediction`. A `queueMode` option runs a conversation through `RedisEventPublisher` (publish captured, no Redis).
5. **Older suites** read the engine's records, so `runTestAgentFlow` now runs as the internal chat by default; tests that pass `isInternal: false` keep the external payloads.

Observations (not changed here):
- The Agent Executions page's Proceed/Reject sends no token, so it cannot resume (an ignored client, TS23).
- With Post Processing on, the internal chat gets JSON, which has no `action` field, so it shows no approval buttons (before this plan as well; outside TS3).
- The popup and the expanded view are two chat instances, each with its own token in memory. Each restores the stored token when it opens and loads the saved messages; answering in one and then in the other continues the second from the token it holds.

### 4.3 Tests changed

- **`characterization.test.ts`**:
  - F18 and F19 flipped to `test`, plus five tests (§3): pruned records keep order, ids, statuses and state (S07); queue mode (S07); internal records equal the recorded rows without credential ids (S01, S07); the carried v1 Agent (S08).
  - `compare.config.json checks`: `F18-executed-data-external`, `F18-executed-data-internal`, `F19-slim-action`, and `F06-S06b-toggle-off`'s `actionKeysOnly`. `TASK_09_CHECKS` is removed; the harness evaluates `actionKeysOnly`, `payloadSentinelMax` and `payloadSentinelMin`, and `'*'` scenarios mean the scenario × mode pairs with a `before/` trace.
  - D9 (S08 t2) and F04 (S05 t3) read the gate prompt and the Start node's form from M1-internal executed data, since external records carry no node output.
  - F17's todo names the decided behaviour; the UI check is in §3.
- **`fieldRemoval.test.ts`**: the conversations run in M1-internal, so the D5 = D4 test reads the stored Agent prompt from the internal executed data. Tokens and outcomes are the same as in M1.
- **`harness.ts`**: child calls external; `queueMode`; `BeforeTurn.executedData`.
- **`testHelpers.ts`**: `runTestAgentFlow` defaults to `isInternal: true` (§4.2 item 5).
- **`compare.config.json`**: `F17-internal-chat-reload` records the decision; `F19-slim-action`'s `actionKeysOnly` runs on t2 and t4.
