# Task 01: Jest Harness & Characterization Tests

- **Status**: Done
- **Depends On**: [00b-scenario-suite-and-baseline-capture.md](./00b-scenario-suite-and-baseline-capture.md) (flows and scenario scripts)
- **Parallel with**: Task 02 (disjoint files)
- **Primary Files**:
  - `packages/server/test/utils/buildAgentflow/trustedState/` (new): `harness.ts`, `testChatModel.ts`, `characterization.test.ts`, `characterization.expected.ts`, `__snapshots__/characterization.test.ts.snap`
  - `packages/server/test/utils/buildAgentflow/testHelpers.ts` (additions only: `COMPONENTS_DIST_NODES_DIR`, `loadComponentNodes`)

---

## 1. Objective

Pin today's cross-turn behaviour in fast, offline Jest tests that run **real** LLM/Agent/HumanInput/Condition Agent nodes, so Tasks 03 and 05–09 get immediate feedback. These tests must keep passing after every later task (TS6). An assertion may change only in the task whose finding intends that change, and only to the behaviour recorded for it in `compare.config.json`.

---

## 2. Harness

### 2.1 Test chat model
A chat model that real Agent/LLM nodes can use without credentials or network (`packages/components/nodes/agentflow/LLM/LLM.test.ts` already loads a fake model through a generated module file; reuse the idea):
- Implements `invoke`, `stream` and `bindTools`, returns `tool_calls` and `usage_metadata`, and records every call's messages and bound tools.
- Uses the same reply rules as the fake server (route marker, keywords, call index), loaded from the scenario scripts in `baselines/scenarios/`.
- Preferred: register it as a test-only component in the `componentNodes` the harness passes to `executeAgentFlow` (`loadRealComponentNodes()` plus one entry). Fallback: run `fake-openai-server.mjs` in-process and point the real `ChatOpenAI` at it, seeding a credential in the mock data source. Pick one and note why in this file.

### 2.2 Multi-turn runner
`runConversation({ flow, mode, turns })`:
- Calls `executeAgentFlow` per turn with the real `SSEStreamer` recorder, taking the `trustedStateData` token from turn n and sending it with turn n+1, like the real clients.
- Supports question, form, `humanInput` (proceed/reject/feedback), `overrideConfig`, `history`, and the M1/M2/M3 mode settings.
- Returns per turn: model calls (grouped by route), SSE events, result, decoded token, size metrics, sentinel counts, mock DB writes.
- `decodeToken`, `encodeToken`, `tokenSize(path)` and `countSentinels(payload)` helpers.

---

## 3. Characterization Tests

One `describe` per scenario S01–S13 (S01r only if the redirect resolver runs inside the harness; S12 only if the child call can be served in-process), mirroring the turn scripts. Each turn asserts:
- the model calls (messages, tools) as a stored snapshot (`toMatchSnapshot` or explicit JSON fixtures next to the test);
- final text, streamed tokens, executed nodes and statuses, final state, and the user-facing `action` fields;
- that the next turn's behaviour depends on the token, by running the next turn once **without** the token and checking that the model calls differ (proves the test exercises the token).

Token-content assertions (sizes, sentinels) are recorded as **current values**, in a separate `describe('token contents')` block that Tasks 05–09 update deliberately.

### 3.1 Failing tests for the findings

For every finding in [00c-findings.md](./00c-findings.md), add a test of the **target behaviour** marked `test.failing` (Jest 29) with the finding ID in its name, e.g. `F05 saves the approval answer as the user message`. Each fixing task flips its tests to plain `test`. Examples:
- F01/TS9: a full conversation runs with ChatMessage and Execution repositories that throw on any read.
- F03/TS11: S04b carries state over with the Persist State input absent or off.
- F04/TS12: a second form submission replaces the form values seen by the Start node and by `$form.*`.
- F05/F07/TS15: model input after a resume has the answer as a user message between the approval prompt and the next reply.
- F10/TS16: the S12 child sees its own earlier messages and state on turn 2.
- F14: a non-streaming result contains a token that continues the conversation.
- F02/TS13/TS22: with the flow setting on, client `history` (with a welcome message) is the history nodes with memory see; a memory-off node sees none; a warning is logged when the token's last message is missing.
- F18/F19: external executed data and `action` contain no sentinel; internal executed data is unchanged.

---

## 4. Implementation Steps

1. Run the existing agentflow tests to confirm a green start.
2. Build the test chat model and confirm a real Agent node with tools runs against it.
3. Build the runner and helpers.
4. Port S01–S13, starting with S01, S07 and S06 (the riskiest), then the failing tests from §3.1.
5. Confirm the snapshots match the `before/` traces from Task 00b for the same scenarios (model messages after normalization).

---

## 5. Invariants

- No changes in `packages/**/src`, except a documented zero-behaviour-change test seam if unavoidable.
- No network: the suite runs offline. Target < 30 s for the trusted state tests.
- Parallel branches: assert model calls per route, not in arrival order.

---

## 6. Acceptance Criteria

- [x] `pnpm --filter flowise test -- test/utils/buildAgentflow/trustedState` passes, covering S01–S13, plus one failing test per finding: 165 passed, 1 todo (F17), 69 snapshots, 28.8 s. Run as `pnpm --filter ./packages/server test -- …`, see §7.6.
- [x] `pnpm --filter flowise test -- test/utils/buildAgentflow` stays green (same note).
- [x] Model messages in the snapshots match the `before/` traces: every turn of all 30 captured scenario × mode traces, not only S01, S06, S07 (`describe('before/ traces')`).
- [x] Each scenario has at least one assertion proving the token changes the next turn (`the next turn depends on the token` in every scenario block).

---

## 7. Results

### 7.1 Test chat model: the real ChatOpenAI node with an in-process transport

`testChatModel.ts` registers a test-only component as `chatOpenAI` in the harness `componentNodes` (the preferred option), so the 00b flows run unchanged. Its `init` runs the **real** ChatOpenAI node `init` from `packages/components/dist` with the credential values passed inline (`openAIApiKey`, `openAIBaseUrl`), then swaps two things on the model and on its inner `completions` / `responses` models (`@langchain/openai` 0.6 sends requests through those): LangChain's `AsyncCaller` gets `maxRetries: 0`, and the OpenAI client's `fetch` is `ScriptedOpenAIServer.fetch`, a TypeScript port of `fake-openai-server.mjs` (same rules: route marker, turn, per-route call index, `{turn}`/`{call}` fills, injected errors and delays, the same streaming chunks and `usage`). No socket is opened.

Why this rather than a hand-written fake model or the fake server on a port:
- The model input is recorded as the OpenAI request body, so it compares 1:1 with `modelRequests[].body` in `traces/before/`.
- `invoke`, `stream`, `bindTools`, tool-call chunk merging and `usage_metadata` are LangChain's own code, as in production.
- No credential row, encryption key or port is needed, and the 6 retries with backoff are gone.

### 7.2 Runner and helpers (`harness.ts`)

- `runConversation({ scenario, mode, turns?, chatbotConfig?, readGuard?, freshDataSourcePerTurn? })` and the `Conversation` class: `run(turn)` sends the turn like the 00b capture client (question, form, `humanInput` with `startNodeId` from the last action, `overrideConfig`, client `history` built from the conversation, the `llmMessages` override, the request flag) with the token the previous turn returned. `replay(turnId, overrides)` reruns a turn from the state it started from (e.g. `{ sendToken: false }`) without advancing the conversation and restores the database.
- Each turn goes through what the prediction controller does: `resolveFlowRedirect`, a real `SSEStreamer` with an external (or internal) client, `executeAgentFlow`, the `metadata` / `error` event and `removeClient`. Non-streaming turns use no client and return the JSON result.
- Modes M1, M2, M3, M1-internal, M1-reqflag and M3-envflags as in `baselines/README.md` §3.
- Execute Flow child calls (S12) are served in-process: an axios adapter runs `executeAgentFlow` for the child flow, as the server would for `POST /api/v1/prediction/:id`. S01r's redirect runs through the real resolver.
- Per turn: model calls (grouped by route), SSE events, result, the token and the tokens the server built but could not deliver (`serverTokens`), decoded token and size summary, sentinel counts per payload, mock DB rows, Execution/ChatMessage reads, warnings and errors logged.
- `decodeToken`, `encodeToken`, `tokenSize(value, path)` (with `<json>` to step into JSON strings) and `countSentinels(payload)`.
- `tokenHistory` / `tokenRecords` read the v1 layout only and throw on any other, so the v2 token cannot make a check pass by reading a field that no longer exists. Task 05 adds the v2 field names there.
- The data source records every Execution and ChatMessage read; `readGuard: 'throw'` fails them. `Execution.findOneBy({ id, workspaceId })`, the read-modify-write inside `updateExecution`, is allowed as part of recording executions (TS5), not a conversation read.

No test seam in `src/` was needed.

### 7.3 Characterization tests (`characterization.test.ts`)

- One `describe` per scenario, S01–S13 including S01r and S12, all in M1. Per turn: `turnFacts` (status, final text, executed nodes and statuses, final state, scripted replies per route, token history roles, user-facing action fields, error) against `characterization.expected.ts`, plus a snapshot of the streamed tokens and every model call (messages and tools; system prompts folded to length, hash and sentinel).
- `the next turn depends on the token`: the turn is replayed without the token and its model calls differ. Exceptions: S10b (ephemeral memory, so the model sees no history either way) shows it through the carried counter; S13 has no token today (F14), so the turn is replayed with the token the server built and did not return.
- `token contents`: per turn, prompt sentinels, node records and history messages carrying an action (exact), raw size (±3 %; ids, dates and the Current DateTime output vary in length). Tasks 05–09 update `EXPECTED_TOKEN_CONTENTS` deliberately.
- `before/ traces`: all 30 captured scenario × mode traces (M1 17, M2 4, M3 5, M1-internal 2, M1-reqflag 1, M3-envflags 1): every turn's model requests (normalized messages and tool definitions, per route) and facts equal the trace. `INTENDED_DIFFERENCES` lists turns a fix changes on purpose, keyed `<mode>/<scenario>/<turn>`, with the finding ID.
- `kept behaviour`: TS5 (M2 saves full executions, no conversation reads), TS14 (S11's failed turn), F18's internal half (the internal chat keeps full executed data).

### 7.4 Failing tests for the findings

In the `findings: target behaviour` block of the same file (one file keeps the suite under 30 s; a second file costs another ~15 s of module loading). Each fails today at the assertion below, checked by running a copy with `test.failing` turned into `test`:

| Test | Fails today because |
| :--- | :--- |
| F01 conversations with approvals run with conversation reads failing, with Client State off as well | M3 t1 `ChatMessage.find`, t2 `Execution.findOne` |
| F02 with the setting on, a memory node sees the client history once | Context Agent t2 gets client history plus token history (duplicates) |
| F02 the client history, welcome message included, is saved in the token | token history after t1 has no welcome message |
| F02 a memory-off first node sees no history (TS22) | Quick Answer gets the client history prepended |
| F02 a warning is logged when the client history lacks the token's last message (TS13) | no warning in t3 (none in t2 either, as required) |
| F02 with the setting off, the client history is ignored with a warning (TS13a) | Context Agent t2 gets the welcome message and duplicates |
| F03 flow state carries over with Persist State off | S04b `count` stays 1 and every turn routes to Intake |
| F04 a new form submission replaces the values the Start node and `$form.*` see | t3 Start `output.form` is still Ada Lovelace / billing |
| F05 HumanInput (S06) | before the t2 reply in t4's Drafter input is the stopped turn's bot message, not the feedback |
| F05 Agent tool approval (S07) | before "The refund is 37.50 euros." is the "Attempting to use tool" message, not `Proceed` |
| F05 parallel stops (S08) | `Proceed` reaches neither the t3 Summary nor t4 |
| F06 toggle off (S06b) | `action.extra` is `doNotIncludeFeedbackHistory` |
| F07 no two assistant messages in a row or blank ones | 14 cases in S06 t3–t5, S07 t4–t6, S08 t3–t4 (S08: `" "`) |
| F08 no history message carries an action while stopped | S06 t1's bot message holds the action JSON |
| F09 resume chains do not copy earlier records | S06 t1→t2 46.6 KB, t2→t3 41.1 KB, S08 t2→t3 43.6 KB beyond the added history |
| F10 the child sees its own earlier messages and state (S12) | the Specialist gets only the current question |
| F11 ephemeral memory keeps no history in the token (S10b) | the token keeps the last exchange (2 messages) |
| F12 one token decode per turn, no parent execution lookup (S09) | 4 decodes in t2 (1 + one per iteration item) |
| F13 a finished turn's token holds no node records or prompts | 57 finished turns hold records and sentinels |
| F14 a non-streaming response carries a token (S13) | no token in the JSON response |
| F15 Client State off or only the request flag continue from the token | with Client State off and an empty database, t2 has no history |
| F16 recording env flags only change writes | M3 without the flags reads history from the (empty) database |
| F18 external executed data is pruned (SSE and JSON) | S07's executed data holds the system prompt sentinel |
| F19 the action carries only the slim fields | S06's action has `extra` (and the full `data.input`) |

F17 is a `test.todo`: it is UI-only (decided in Task 09). TS-O1 is an open decision (Task 03), so it has no failing test; its replayed checkpoint prompt is pinned in the S07/S08 snapshots.

To see the failures again: copy `characterization.test.ts` with `test.failing(` replaced by `test(`, run the copy with `-t findings --ci`, and delete it.

### 7.5 Deviations from `traces/before/`

- **S11 t2**: one Agent A request instead of 7 (no retries). The capture's retry backoff let LLM B (300 ms) finish before the failure; the harness delays the 500 reply by 600 ms (`loadHarnessScenario`) so the turn ends the same way. `withoutRetries` drops the repeated failed requests when comparing with the trace.
- Executed node lists are compared sorted, and model calls per route: parallel branches (S10a, S11) commit in either order.
- Token sizes are ~70 bytes smaller than in the traces (shorter chat and flow ids).

### 7.6 Notes for later tasks

- **Test command**: `pnpm --filter flowise test -- <path>` fails before the server tests run, because the filter also selects the root package (also named `flowise`), whose `turbo run test -- <path>` runs `flowise-components`' jest with the path; it finds no tests and exits 1. `pnpm --filter ./packages/server test -- <path>` (from the repository root) runs the server suite. This predates Task 01.
- **Provisional setting key**: `ACCEPT_CLIENT_HISTORY_CHATBOT_CONFIG` (`chatbotConfig.acceptClientHistory.enabled`) stands in for the TS13a setting in the F02 tests until Task 04/06 names it.
- **Changing a pinned value**: when a finding's fix changes behaviour, update its entries in `characterization.expected.ts`, the affected snapshots (`-u -t "<scenario>"`, then review the diff), `EXPECTED_TOKEN_CONTENTS`, and add the turns to `INTENDED_DIFFERENCES`; then flip the finding's tests to `test`.
- README observation 2 (S10a t4: the memory-off LLM drops the current question when the `llmMessages` override holds user messages) is pinned as today's behaviour; Task 06 decides it.
- `TS_HARNESS_LOGS=1` prints the warnings and errors the harness otherwise only records.
