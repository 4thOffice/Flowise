# Task 09: Client Payloads & UI

- **Status**: Not started (spec finalised in the Task 04 design review)
- **Depends On**: [07-human-input-stop-and-resume.md](./07-human-input-stop-and-resume.md), [08-execute-flow-child-tokens.md](./08-execute-flow-child-tokens.md)
- **Fixes**: F17, F18, F19
- **Primary Files**:
  - `packages/server/src/utils/buildAgentflow.ts` (`action` construction, `:2060`, `:2270`)
  - `packages/server/src/utils/SSEStreamer.ts`, `packages/server/src/queue/RedisEventPublisher.ts` (executed data delivery)
  - `packages/ui/src/views/chatmessage/ChatMessage.jsx`
  - `packages/server/test/utils/buildAgentflow/trustedState/`

---

## 1. Objective

No system prompt or other unneeded data reaches clients unencrypted, and the Flowise UI works with the token-only model.

---

## 2. Scope

- **`action`** (SSE and any saved copy, TS20): `id`, `mapping`, `elements`, `data.nodeId`, `data.nodeLabel`, `data.input.humanInputEnableFeedback`. Resume must not depend on the client echoing removed fields.
- **`agentFlowExecutedData`** (TS18): full for the internal Flowise chat (`isInternal`); for every other request, records pruned to `nodeId`, `nodeLabel`, `status`, `previousNodeIds`, `data.name`, `data.state`, error text and the slim action. Prune before the payload leaves `executeAgentFlow`, so SSE, queue mode (Redis) and the non-streaming JSON all get the same result.
- **UI**: approval buttons, feedback dialog and execution viewer work with the slim payloads. Decide with the user whether the internal chat keeps the token across page reloads (F17).
- Saved executions unchanged (TS5).

---

## 3. Acceptance Criteria

- [ ] Sentinel count 0 in every `action` payload and in external executed data; internal executed data unchanged.
- [ ] Flowise UI checked in the browser on the isolated server: chat, approval, feedback, resume, execution viewer, reload behaviour.
- [ ] Characterization tests: class A unchanged.
- [ ] `pnpm --filter ./packages/server build`, `pnpm --filter ./packages/server test` and the UI build green.
