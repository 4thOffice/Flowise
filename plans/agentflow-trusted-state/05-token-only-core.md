# Task 05: Token-Only Core

- **Status**: Not started (spec finalised in the Task 04 design review)
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

- [ ] Failing tests for F01, F12, F14, F15, F16 now pass (`test.failing` → `test`).
- [ ] A full S01–S05, S09–S11, S13 conversation runs with ChatMessage and Execution repositories that throw on read (the `updateExecution` read allowed).
- [ ] Characterization tests pass; changed assertions match `compare.config.json` entries only (F01, F12–F16; S04b unchanged until Task 06).
- [ ] Codec unit tests: round trip; v1 detection and upgrade (history, flow state, form values, interim pending data) using real v1 tokens from `before/` traces (S01 t5, S04a t2, S05 t2, S06 t1, S07 t2, S08 t1).
- [ ] Sentinel count 0 in the token for all normal turns (Jest); token raw JSON ≤ 5 % of `before/` on normal turns.
- [ ] `pnpm --filter ./packages/server build`, `pnpm --filter ./packages/server test` and the UI build green.
