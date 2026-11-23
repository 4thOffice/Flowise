# Task 05: Token-Only Core

- **Status**: Done (2026-11-23; results and deviations from §2 in §4)
- **Depends On**: [04-decision-gate-and-token-v2-design.md](./04-decision-gate-and-token-v2-design.md) (§2 = the design; D-numbers are its §4 decisions)
- **Fixes**: F01, F03 (state in the token), F12, F13 (normal turns), F14, F15, F16
- **Primary Files**:
  - `packages/server/src/utils/trustedStateHelper.ts` (crypto unchanged)
  - `packages/server/src/utils/agentflow/trustedState.ts` (new: v2 types, codec, v1 upgrade, builder, turn input, history mapping)
  - `packages/server/src/utils/buildAgentflow.ts`
  - `packages/server/src/utils/agentflow/types.ts`, `packages/server/src/Interface.ts`
  - `packages/server/src/utils/buildChatflow.ts`, queue job/result path (non-streaming token)
  - `packages/ui/src/ui-component/extended/ClientState.jsx`, `packages/ui/src/views/chatmessage/ChatMessage.jsx` (non-streaming token)
  - `packages/server/test/utils/buildAgentflow/trustedState/`

---

## 1. Objective

One execution path: every Agentflow V2 turn reads history, state and the previous turn's outcome from the token only, and returns a v2 token in both streaming and non-streaming responses.

---

## 2. Scope

- **Codec and upgrade** (04 §2.1–2.4): `TrustedStateV2` with all TS19 fields from the start, `version: 2`, v1 detection, `upgradeV1`, unknown or broken tokens = new conversation with a warning (D3). History messages per 04 §2.2 (D2) and `toNodeMessage` producing today's node input.
- **Turn input** (04 §2.5): `readTurnInput` once per top-level turn; `pastChatHistory`, `agentflowRuntime.state` and `agentflowRuntime.form` come from it. Remove the ChatMessage reads (`:1563`, `:2140`), `lazyLoadExecution` (`:1287-1314`) and the iteration parent lookup (`:1503`). A missing token means a new conversation. `history` handling and the removal of the first-node prepend are Task 06; until then `prependedChatHistory` stays as it is.
- **State in the token**: the builder stores `agentflowRuntime.state` as `flowState`; the Persist State read takes it from there instead of scanning records, with the `startState` override applied as today (04 §2.5). Still only when Persist State is on: carrying it always and removing the option is Task 06.
- **Builder** (04 §2.6): v2 for `FINISHED` and failed turns (TS14). **Stopped turns until Task 07**: the builder writes an interim `pendingResume.legacyExecution` (the stopped turn's `previousExecution` object as today, records included) and the existing resume path reads it in place of `trustedData.previousExecution`; the history `action` scan (`:2139-2177`) becomes "pending data present", which in trusted mode is all it reads today. A v1 paused token upgrades into the same interim field. Task 07 replaces it with the TS26 fields; paused tokens may hold prompts until then.
- **Recursive runs**: iteration children get the turn input through `IExecuteAgentFlowParams.turnInput`, never the raw token (F12); they use the parent's execution when executions are recorded.
- **Child flow tokens plumbing** (TS16, 04 §2.10): `childFlowTokens` is one mutable object per turn, shared with recursive runs; `executeNode` passes `childFlowToken: childFlowTokens[nodeId]` in the run params, moves a returned `results.childFlowToken` into the object (no token deletes the entry) and removes it from `results` before the record is committed; the builder drops entries whose node id is not in the flow. Task 08 then only changes the Execute Flow node.
- **Switches** (04 §2.8, D12): `clientState.enabled` (no chat messages), `clientState.enabledFull` (no executions), the request flag `enableTrustedState` (stands in for an unset `enabled`) and the `DISABLE_*` env flags only decide writes (F15, F16, TS21, TS5). `ClientState.jsx`: dialog text says conversations always continue from the token and the settings only control recording; the two switches become "Disable recording chat messages" and "Disable recording executions" (Task 06 adds the TS13a switch).
- **Recorded executions** (D10): `updateExecution` never fails the turn on a missing row (warning; the final write inserts a new row). Its `findOneBy({ id, workspaceId })` stays the only Execution read.
- **Non-streaming** (F14): `result.trustedState` (same string as the SSE event), also through the queue job result; the UI's non-streaming path stores it.
- **Observability**: one debug line per top-level turn: chat id, incoming version, token size in and out, history length in and out, pending in and out.
- **Test harness**: `tokenHistory()` reads `history` (v2) or `pastChatHistory` (v1); `tokenRecords()` reads the v1 records, or for v2 the interim `legacyExecution` records (Task 07: the skeleton) and `[]` otherwise. The read guard keeps allowing `updateExecution`'s `findOneBy({ id, workspaceId })` (D10). Task 03's `fieldRemoval.test.ts` builds v1 tokens and reads the written ones with the same helpers.

---

## 3. Acceptance Criteria

- [x] Failing tests for F01, F12, F14, F15, F16 now pass (`test.failing` → `test`). F08 and F13 flipped too: the v2 history has no `action` (D2) and a finished turn's token holds no records (§4.4). F02–F07, F09–F11, F18, F19 still fail as intended.
- [x] A full S01–S05, S09–S11, S13 conversation runs with ChatMessage and Execution repositories that throw on read (the `updateExecution` read allowed): `token-only conversations (Task 05)` in `characterization.test.ts` runs S01, S01r, S02, S03, S04a, S04b, S05, S09, S10a, S10b, S11 and S13 in M3 (Client State off, everything recorded) with `readGuard: 'throw'`; no read other than the allowed one, and statuses, errors and model requests equal the M1 run turn by turn. F01's test does the same for S06 and S07.
- [x] Characterization tests pass; changed assertions match `compare.config.json` entries only: `before/ traces` differs only at M1/S13 t1–t3 (F14) and M3/S06 t2–t5, M3/S07 t3–t6, M3/S12 t2–t4 (F01-M3-like-M1), listed in `INTENDED_DIFFERENCES`; S13's turn facts and snapshots (F14) and `EXPECTED_TOKEN_CONTENTS` (F13, measured) are updated; S04b unchanged. Every other scenario × mode × turn of `before/` matches.
- [x] Codec unit tests (`codec.test.ts`): round trip; v1 detection and upgrade (history, flow state, form values, interim pending data) using real v1 tokens from `before/` traces (S01 t5, S04a t2, S05 t1 and t2, S06 t1, S07 t2, S08 t1); broken and unknown-version tokens start a new conversation with a warning; the retry rule for an error right after a stop.
- [x] Sentinel count 0 in the token for all normal turns (Jest); token raw JSON ≤ 5 % of `before/` on normal turns: the `token-only conversations (Task 05)` test checks every M1 turn that does not end stopped (S13: ≤ 4 KB, it has no v1 token). Measured: 211–1 219 bytes against 44–308 KB before; the largest share is 2.25 % (S07 t6).
- [x] `pnpm --filter ./packages/server build`, `pnpm --filter ./packages/server test` (18 suites, 439 passed + 1 todo, 69 snapshots; trusted state folder 234 passed + 1 todo) and the UI build green. Components unchanged.

---

## 4. Results

### 4.1 Code

- `packages/server/src/utils/agentflow/trustedState.ts` (new): the v2 types (04 §2.1–2.2), `readTurnInput`, `upgradeV1`, `toNodeMessage`, `buildTrustedState`, `writeToken`, `isResumableExecution` and the per-turn debug line (`logTurnTokens`). `trustedStateHelper.ts` keeps its crypto; only its types changed (`unknown` in and out). `Interface.ts` lost the v1 `TrustedState` type.
- `buildAgentflow.ts`: the turn input is read once per top-level turn (or handed to an iteration child through `IExecuteAgentFlowParams.turnInput`); `pastChatHistory` is `turnInput.history.map(toNodeMessage)`; Persist State starts from `turnInput.flowState` with the `startState` override applied as before, and a form flow starts from `turnInput.formValues`, both only when the request carried a token (the v1 code read them only when a previous run existed). Removed: the ChatMessage history read, `lazyLoadExecution`, the iteration parent lookup, the pending-action scan and its ChatMessage query. Iteration children use the parent's execution id. The builder writes v2 for every turn; `result.trustedState` is the same string as the SSE event.
- `updateExecution` returns `false` with a warning for a missing row; the final write then inserts a new row (D10). `findOneBy({ id, workspaceId })` is the only Execution read left.
- Child flow tokens: the run params carry `childFlowToken`, a returned `childFlowToken` moves into the turn's object (no token deletes the entry) and leaves `results` before the record is committed; the builder drops entries of node ids not in the flow. Nothing returns one until Task 08.
- Switches: `clientState.enabled` (or the request flag when unset), `clientState.enabledFull` and the env flags only gate `utilAddChatMessage`, `addExecution` and `updateExecution`.
- UI: `ChatMessage.jsx` stores `trustedState` from a non-streaming response; `ClientState.jsx` says conversations always continue from the token and the settings only control recording ("Disable recording chat messages", "Disable recording executions").

### 4.2 Deviations from §2 (for the plan session)

1. **Pending action marker** (§2 Builder said the history `action` scan "becomes 'pending data present'"). That is not what the trusted-mode scan read: it looked for the action in the history *after* node commits had changed it, and S06b's HumanInput (history toggle off) drops the stop message before the scan, so today S06b t2 saves a user message (`uua`). A plain "pending present" rule would change S06b's history from t2 and the t4 Drafter input, which no Task 05 compare entry allows. The interim pending data therefore keeps `actionMessageIndex`, the index of the history message that announced the action (v1: the first message with an `action`), and a resume saves no user message while that message is still in the outgoing history. Task 07 replaces it with D8.
2. **Failed turns that stay resumable**: a turn whose run ends with an error right after a stop (the v1 retry rule, `isResumableExecution`) also writes the interim pending data, so answering again retries as today. Every other failed turn writes TS14's v2 token without pending data. Task 07's D6 replaces this.
3. **Recorded stop messages (D11) are not cleaned up until Task 07**: the scan's ChatMessage query is gone, so with chat message recording on, the stop message row keeps its `action` after the resume (and the toggle-off case no longer deletes it). Pinned in `faultAndHumanInput`, `publicInterface` and `integration` tests with a note for Task 07 to flip. Model input is unaffected (rows are never read).
4. **Form values**: the turn input carries the token's values only; `incomingInput.form ?? formValues` (F04) stays in Task 06, so S05 is unchanged. The builder stores a Start form string as values (`parseFormStringToJson`), the same values the v1 read produced.
5. **Execute Flow fallback text** (not exercised): a child response is now JSON with `trustedState`, so a child without `text` or `json` puts the token into the parent's whole-JSON fallback text until Task 08 leaves it out (04 §2.10).
6. **Resume without pending data** fails with "No previous execution found for session …: the trustedState holds no stopped run to resume" (kept the old prefix).

### 4.3 Tests changed

- Harness: `tokenHistory()` / `tokenRecords()` read v1 and v2 (v2 records: the interim `legacyExecution`); `isV2Token`. `fieldRemoval.test.ts`: the removal helpers edit v2 tokens (history, `pendingResume.legacyExecution`); "history message action" removes `actionMessageIndex` from a v2 token (same expected boundaries), the marker variant is a no-op on v2; `contractFieldsOf` reads `flowState` / `formValues` of v2 tokens; paused "today" sizes come from the v1 tokens in `before/`. All 41 removal and TS-O1 results are unchanged.
- The older engine suites (`baseline`, `dagSemantics`, `faultAndHumanInput`, `integration`, `publicInterface`, `stateReconciler`, `concurrentScheduler`) resumed or read history by session id from the database. They now send the previous turn's token, as clients do; tests that seeded an Execution row send it as a v1 token (`legacyTokenFor`), tests that seeded a ChatMessage send a token with that history (`tokenWithHistory`). v1 token assertions read the v2 fields. The queue test checks that the job result carries the published token.
- New: `codec.test.ts`; in `characterization.test.ts` the `token-only conversations (Task 05)` block (read guard per scenario, sentinel/size check, D10 missing-row resume).

### 4.4 Measurements (M1, Jest)

| | Normal-turn tokens (raw JSON) | Paused tokens (raw JSON) |
| :--- | :--- | :--- |
| before (v1) | 44–308 KB, 1–7 prompt copies | 47–139 KB, 1–3 prompt copies |
| after (v2) | 211–1 219 bytes (≤ 2.25 % of before), no prompt, no records | 46–94 KB, 1–2 prompt copies: the interim `legacyExecution` (Task 07: under 1 KB) |
