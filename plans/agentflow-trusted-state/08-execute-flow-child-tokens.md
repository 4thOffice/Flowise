# Task 08: Execute Flow Child Tokens

- **Status**: Not started (spec finalised in the Task 04 design review)
- **Depends On**: [05-token-only-core.md](./05-token-only-core.md) (child token in the JSON response, F14; child flow tokens field and its plumbing)
- **Parallel with**: Task 06 (disjoint files)
- **Fixes**: F10
- **Primary Files**:
  - `packages/components/nodes/agentflow/ExecuteFlow/ExecuteFlow.ts` (only this node: the server plumbing comes from Task 05, which keeps this task disjoint from Task 06)
  - `packages/components/nodes/agentflow/ExecuteFlow/ExecuteFlow.test.ts` (new) and/or `packages/server/test/utils/buildAgentflow/trustedState/`

---

## 1. Objective

A child flow called by Execute Flow keeps its own history and state across the parent's turns, without DB reads (TS16).

---

## 2. Scope

- Before calling the child, take this node's entry from the child flow tokens field (TS16, TS19), passed in by the server, and send it as `trustedState`.
- Return the token from the child's JSON response in the node result, so the server stores it under this node's id.
- Behaviour when the selected child flow changes (token from another flow): start the child fresh.
- Child flows that stop for human input: out of scope unless trivial; record the limitation.
- Size: the child token adds to the parent token; record its size in S12.

---

## 3. Acceptance Criteria

- [ ] Failing test for F10 passes: on turn 2 the S12 child sees its own earlier messages and state.
- [ ] S12 shows exactly the intended differences; other scenarios unchanged.
- [ ] `pnpm --filter flowise build` and components tests green.
