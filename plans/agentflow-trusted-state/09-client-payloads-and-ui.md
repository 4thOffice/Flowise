# Task 09: Client Payloads & UI

- **Status**: Not started (spec finalised in the Task 04 design review)
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

---

## 3. Acceptance Criteria

- [ ] Sentinel count 0 in every `action` payload and in external executed data; internal executed data unchanged except credential ids.
- [ ] Flowise UI checked in the browser on the isolated server: chat, approval, feedback, resume, execution viewer, reload behaviour.
- [ ] Characterization tests: class A unchanged.
- [ ] `pnpm --filter ./packages/server build`, `pnpm --filter ./packages/server test` and the UI build green.
