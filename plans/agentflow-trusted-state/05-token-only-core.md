# Task 05: Token-Only Core

- **Status**: Not started (spec finalised in the Task 04 design review)
- **Depends On**: [04-decision-gate-and-token-v2-design.md](./04-decision-gate-and-token-v2-design.md)
- **Fixes**: F01, F03 (state in the token), F12, F13 (normal turns), F14, F15, F16
- **Primary Files**:
  - `packages/server/src/utils/trustedStateHelper.ts` (crypto unchanged)
  - `packages/server/src/utils/agentflow/trustedState.ts` (new: v2 types, codec, v1 upgrade, builder, turn input)
  - `packages/server/src/utils/buildAgentflow.ts`
  - `packages/server/src/Interface.ts`
  - `packages/server/src/utils/buildChatflow.ts`, queue job/result path (non-streaming token)
  - `packages/ui/src/ui-component/extended/ClientState.jsx` (settings per TS9)
  - `packages/server/test/utils/buildAgentflow/trustedState/`

---

## 1. Objective

One execution path: every Agentflow V2 turn reads history, state and the previous turn's outcome from the token only, and returns a v2 token in both streaming and non-streaming responses.

---

## 2. Scope

- **Codec and upgrade**: version detection, v1 → v2 on read, v2 on write (TS1). The v2 schema has all TS19 fields from the start: history, flow state, form values, child flow tokens, pending resume data.
- **Turn input**: history and flow state from the token feed `pastChatHistory` and `agentflowRuntime.state`. Remove the ChatMessage reads (`:1563`, `:2140`), `lazyLoadExecution`'s DB branch (`:1286–1310`) and the iteration parent lookup (`:1503`). A missing token means a new conversation.
- **State in the token**: the final flow state of the turn is stored once; persisted-state reads no longer scan records. (Removing the Persist State option itself is Task 06.)
- **Builder**: v2 from the turn result for normal and failed turns (TS14). Stopped turns keep working through the existing resume path until Task 07; note how in this file.
- **Recursive runs**: iteration children get the decoded turn input, not the raw token (F12).
- **Child flow tokens plumbing (TS16)**: pass each node its entry from the child flow tokens field through the run params, and store a token a node returns under its node id. Task 08 then only changes the Execute Flow node.
- **Switches**: `clientState.enabled`, `enableTrustedState`, `DISABLE_CHAT_MESSAGE_RECORDING` and `DISABLE_EXECUTION_RECORDING` no longer change where data is read from (F15, F16). They only decide writes: chat messages are written only when chat message recording is on (TS21), executions only when execution recording is on (TS5). UI settings (`ClientState.jsx`) become the two recording options, mapped from today's stored config per the Task 04 design.
- **Non-streaming**: the JSON result carries `trustedState`, also in queue mode; the UI's non-streaming path stores it (F14).
- **Observability**: a debug log line per turn with the incoming and outgoing token size.

---

## 3. Acceptance Criteria

- [ ] Failing tests for F01, F12, F14, F15, F16 now pass (`test.failing` → `test`).
- [ ] A full S01–S05, S09–S11, S13 conversation runs with ChatMessage and Execution repositories that throw on read.
- [ ] Characterization tests pass; changed assertions match `compare.config.json` entries only.
- [ ] Codec unit tests: round trip, v1 detection and upgrade using real v1 tokens from `before/` traces.
- [ ] Sentinel count 0 in the token for all normal turns (Jest).
- [ ] `pnpm --filter flowise build`, `pnpm --filter flowise test` and the UI build green.
