# Task 08: Execute Flow Child Tokens

- **Status**: Not started (spec finalised in the Task 04 design review)
- **Depends On**: [05-token-only-core.md](./05-token-only-core.md) (child token in the JSON response, F14; child flow tokens field and its plumbing); design: [04 §2.10](./04-decision-gate-and-token-v2-design.md), D15
- **Runs after**: Task 06 (shared characterization tests and components build in one checkout; the version sync uses Task 06's `updateOutdatedNodeData` change)
- **Fixes**: F10; TS25 for Execute Flow
- **Primary Files**:
  - `packages/components/nodes/agentflow/ExecuteFlow/ExecuteFlow.ts` (only this node: the server plumbing comes from Task 05, which keeps this task disjoint from Task 06)
  - `packages/components/nodes/agentflow/ExecuteFlow/ExecuteFlow.test.ts` (new) and/or `packages/server/test/utils/buildAgentflow/trustedState/`

---

## 1. Objective

A child flow called by Execute Flow keeps its own history and state across the parent's turns, without DB reads (TS16).

---

## 2. Scope

- Read `options.childFlowToken` (`{ flowId, token }`, from the run params); send `trustedState: token` only when `flowId` equals the selected flow, otherwise call the child fresh.
- Return `childFlowToken: { flowId: selectedFlowId, token: response.data.trustedState }` at the top level of the node result (the server stores it under this node's id and strips it from the record); no token in the response returns none, which deletes the entry.
- Leave `trustedState` out of the whole-JSON fallback text (`:226`).
- Chat id, override config and Merge State (`agentFlowExecutedData[last].data.state`) unchanged.
- Child flows that stop for human input are not resumed: the next parent turn sends the child token with a question, which abandons the child's pause. Record the limitation.
- Size: the child token adds to the parent token; record its size in S12.
- "Return Response As" (D15): User Message removed, default Assistant Message, any value but `ignore` means assistant; version 1.2 → 1.3 (sync fallback from Task 06's `updateOutdatedNodeData` change).

---

## 3. Acceptance Criteria

- [ ] Failing test for F10 passes: on turn 2 the S12 child sees its own earlier messages and state.
- [ ] S12 shows exactly the intended differences (F10 entry); parent token raw JSON ≤ 10 % of `before/`; other scenarios unchanged.
- [ ] `pnpm --filter ./packages/server build` and components tests green.
