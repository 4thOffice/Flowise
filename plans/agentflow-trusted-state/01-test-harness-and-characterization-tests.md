# Task 01: Jest Harness & Characterization Tests

- **Status**: Not started
- **Depends On**: [00b-scenario-suite-and-baseline-capture.md](./00b-scenario-suite-and-baseline-capture.md) (flows and scenario scripts)
- **Parallel with**: Task 02 (disjoint files)
- **Primary Files**:
  - `packages/server/test/utils/buildAgentflow/trustedState/` (new): `harness.ts`, `testChatModel.ts`, `characterization.test.ts`
  - `packages/server/test/utils/buildAgentflow/testHelpers.ts` (additions only)

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

- [ ] `pnpm --filter flowise test -- test/utils/buildAgentflow/trustedState` passes, covering S01–S13, plus one failing test per finding.
- [ ] `pnpm --filter flowise test -- test/utils/buildAgentflow` stays green.
- [ ] Model messages in the snapshots match the `before/` traces (spot-checked for S01, S06, S07 at minimum).
- [ ] Each scenario has at least one assertion proving the token changes the next turn.
